import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from '@wallet/shared';
import type { z } from 'zod';

/**
 * Outbound HTTP for provider calls.
 *
 * Every request this application makes to a third party goes through here. The protections
 * are all aimed at the same class of problem: an attacker (or a compromised provider)
 * steering our server into making requests it should not, or feeding it a response that
 * exhausts memory.
 *
 *   * **Host allow-list** — the destination host must be one we configured. A provider URL
 *     coming from the database or an admin form cannot become an arbitrary fetch.
 *   * **No redirects** — `redirect: 'manual'`. A 302 to `169.254.169.254` is the classic
 *     cloud-metadata SSRF, and following redirects would bypass the allow-list entirely.
 *   * **DNS pinning against private ranges** — the resolved address must be public.
 *   * **HTTPS only** in production.
 *   * **Response size cap** — the body is read in chunks and aborted past the limit.
 *   * **Timeout** on every call, no exceptions.
 *   * **Schema validation** — provider responses are parsed with Zod before use. Chain data
 *     is attacker-controlled: anyone can create a token whose name is a script tag or whose
 *     decimals field is a string.
 */

export interface HttpClientConfig {
  /** Hostnames this client may talk to. Derived from configured provider URLs. */
  allowedHosts: string[];
  timeoutMs: number;
  maxResponseBytes: number;
  /** Allow http:// and private addresses. Development only. */
  allowInsecure?: boolean;
  userAgent?: string;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  /** Overrides the client default for this call. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const PRIVATE_IPV4 =
  /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|198\.1[89]\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/;

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return PRIVATE_IPV4.test(address);
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return true;
    // IPv4-mapped: re-check the embedded v4 address.
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return PRIVATE_IPV4.test(mapped[1]);
    return false;
  }
  return false;
}

export class HttpClient {
  private readonly allowed: Set<string>;

  constructor(private readonly config: HttpClientConfig) {
    this.allowed = new Set(
      config.allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean),
    );
  }

  /** Register an additional host at runtime (e.g. when an admin adds a provider URL). */
  allowHost(host: string): void {
    this.allowed.add(host.trim().toLowerCase());
  }

  private async assertSafeUrl(url: URL): Promise<void> {
    if (url.protocol !== 'https:' && !(this.config.allowInsecure && url.protocol === 'http:')) {
      throw new AppError('PROVIDER_ERROR', {
        internal: `blocked non-https provider URL: ${url.protocol}//${url.hostname}`,
      });
    }

    const host = url.hostname.toLowerCase();
    if (!this.allowed.has(host)) {
      throw new AppError('PROVIDER_ERROR', { internal: `host not allow-listed: ${host}` });
    }

    if (this.config.allowInsecure) return;

    // Resolve and reject private/link-local destinations. This does not fully close the
    // DNS-rebinding window (Node re-resolves on connect), which is why the allow-list above
    // is the primary control and this is defence in depth.
    const literal = isIP(host);
    if (literal) {
      if (isPrivateAddress(host)) {
        throw new AppError('PROVIDER_ERROR', { internal: 'blocked private IP destination' });
      }
      return;
    }

    try {
      const records = await lookup(host, { all: true });
      for (const record of records) {
        if (isPrivateAddress(record.address)) {
          throw new AppError('PROVIDER_ERROR', {
            internal: `host ${host} resolves to a private address`,
          });
        }
      }
    } catch (error) {
      if (AppError.is(error)) throw error;
      throw new AppError('NETWORK_UNAVAILABLE', { internal: `DNS lookup failed for ${host}` });
    }
  }

  /** Read the body with a hard byte cap so a hostile response cannot exhaust memory. */
  private async readBounded(response: Response): Promise<string> {
    const declared = response.headers.get('content-length');
    if (declared && Number.parseInt(declared, 10) > this.config.maxResponseBytes) {
      throw new AppError('PROVIDER_ERROR', { internal: 'provider response too large' });
    }

    const body = response.body;
    if (!body) return '';

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > this.config.maxResponseBytes) {
          await reader.cancel();
          throw new AppError('PROVIDER_ERROR', { internal: 'provider response exceeded size cap' });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  }

  async requestRaw(rawUrl: string, options: HttpRequestOptions = {}): Promise<string> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new AppError('PROVIDER_ERROR', { internal: 'malformed provider URL' });
    }
    await this.assertSafeUrl(url);

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': this.config.userAgent ?? 'wallet-bot/1.0',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // Never follow a redirect: it would escape the allow-list.
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        throw new AppError('PROVIDER_ERROR', {
          internal: `provider attempted redirect (${response.status})`,
        });
      }

      const text = await this.readBounded(response);

      if (!response.ok) {
        if (response.status === 429) {
          throw new AppError('RATE_LIMITED', {
            internal: `provider rate limited: ${url.hostname}`,
            retryable: true,
          });
        }
        throw new AppError('PROVIDER_ERROR', {
          internal: `provider ${url.hostname} returned ${response.status}: ${text.slice(0, 200)}`,
          retryable: response.status >= 500,
        });
      }

      return text;
    } catch (error) {
      if (AppError.is(error)) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AppError('TIMEOUT', { internal: `provider ${url.hostname} timed out` });
      }
      throw new AppError('NETWORK_UNAVAILABLE', {
        internal: `provider ${url.hostname} unreachable`,
        cause: error,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch and validate against a Zod schema.
   *
   * A provider that changes its response shape produces a clear `PROVIDER_ERROR` instead of
   * `undefined` propagating into a balance calculation.
   */
  async requestJson<T>(
    url: string,
    // Input type is `unknown`: schemas here routinely use `.transform()`/`.default()`, so
    // the parsed input and output types differ.
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    options: HttpRequestOptions = {},
  ): Promise<T> {
    const text = await this.requestRaw(url, options);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AppError('PROVIDER_ERROR', { internal: 'provider returned invalid JSON' });
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new AppError('PROVIDER_ERROR', {
        internal: `provider response failed validation: ${result.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      });
    }
    return result.data;
  }
}

/** Extract the hostname from a URL, for building an allow-list. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
