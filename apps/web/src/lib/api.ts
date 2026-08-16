'use client';

import type { ErrorCode } from '@wallet/shared';

/**
 * The API client.
 *
 * The session token lives **in module scope only** — never `localStorage`, never a cookie.
 * Consequences, both deliberate:
 *
 *   * a cross-site request cannot carry authority, so CSRF does not apply to this API;
 *   * a reload loses the token, and the app silently re-authenticates from `initData`, which
 *     is always available inside Telegram. Users never see a login screen.
 *
 * A 401 mid-session triggers exactly one re-authentication and one retry, so an expired token
 * is invisible rather than an error toast.
 */

let sessionToken: string | null = null;
let reauthenticate: (() => Promise<string | null>) | null = null;
let inflightReauth: Promise<string | null> | null = null;

export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

/** Registered once by the app provider, which owns the initData exchange. */
export function setReauthenticator(fn: (() => Promise<string | null>) | null): void {
  reauthenticate = fn;
}

export class ApiError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;

  constructor(params: {
    code: string;
    status: number;
    details?: Record<string, unknown>;
    requestId?: string;
  }) {
    super(params.code);
    this.name = 'ApiError';
    this.code = params.code;
    this.status = params.status;
    this.details = params.details;
    this.requestId = params.requestId;
  }

  /** Message key for the i18n catalogue. Unknown codes fall back to a generic message. */
  get messageKey(): string {
    return `error.${this.code}`;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** Internal: prevents an infinite re-auth loop. */
  retryOnUnauthorized?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, retryOnUnauthorized = true } = options;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // No cookies are used at all; this makes that explicit.
      credentials: 'omit',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError({ code: 'NETWORK', status: 0 });
  }

  const requestId = response.headers.get('x-request-id') ?? undefined;

  if (response.status === 204) return undefined as T;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const envelope = payload as {
      error?: { code?: string; details?: Record<string, unknown> };
    } | null;
    const code = envelope?.error?.code ?? 'INTERNAL_ERROR';

    // One silent re-authentication, then one retry. Never more — a genuine auth failure
    // must surface rather than loop.
    if (
      (response.status === 401 || code === 'SESSION_EXPIRED') &&
      retryOnUnauthorized &&
      reauthenticate
    ) {
      const token = await runReauth();
      if (token) {
        return apiRequest<T>(path, { ...options, retryOnUnauthorized: false });
      }
    }

    throw new ApiError({
      code,
      status: response.status,
      ...(envelope?.error?.details ? { details: envelope.error.details } : {}),
      ...(requestId ? { requestId } : {}),
    });
  }

  return payload as T;
}

/** Collapses concurrent re-auth attempts into one exchange. */
async function runReauth(): Promise<string | null> {
  if (!reauthenticate) return null;
  if (!inflightReauth) {
    inflightReauth = reauthenticate().finally(() => {
      inflightReauth = null;
    });
  }
  return inflightReauth;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    apiRequest<T>(path, {
      method: 'GET',
      ...(query ? { query } : {}),
      ...(signal ? { signal } : {}),
    }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};

/**
 * Generate an idempotency key for a mutation.
 *
 * The client owns this so a retry — a lost response, a double tap, a flaky connection — is
 * recognised by the server as the same request rather than a second one.
 */
export function newIdempotencyKey(prefix = 'req'): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2).padEnd(24, '0');
  return `${prefix}-${Date.now().toString(36)}-${random}`.slice(0, 100);
}
