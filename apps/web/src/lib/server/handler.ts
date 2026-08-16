import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { type z } from 'zod';
import { AppError, createTranslator, toAppError, type Locale } from '@wallet/shared';
import {
  createServiceContext,
  resolveRequestId,
  type AuthenticatedActor,
  type RateLimitBucket,
  type ServiceContext,
} from '@wallet/core';
import { getAppContext, getServices } from './context';

/**
 * The API route wrapper.
 *
 * Every `/api` handler goes through here, so the security controls are applied once and
 * cannot be forgotten on a new endpoint:
 *
 *   1. **Origin check** — cross-origin requests are rejected against an allow-list.
 *   2. **Body size cap** — enforced before parsing.
 *   3. **Content-type check** — JSON only for mutations.
 *   4. **Rate limiting** — per bucket, keyed on the user when authenticated, on a hashed IP
 *      otherwise.
 *   5. **Authentication** — bearer token → server-verified actor. A user id in a body or
 *      query string is never authority.
 *   6. **Validation** — Zod, `.strict()`, so unknown keys are rejected rather than stripped.
 *   7. **Error shaping** — only an error code and safe details cross the boundary; stack
 *      traces and SQL stay in the log.
 *
 * CSRF needs no separate defence: authority lives in an `Authorization` header the browser
 * never attaches automatically, so a cross-site request carries no identity. See
 * docs/security.md §Authentication.
 */

export interface HandlerContext<TBody = unknown, TQuery = unknown> {
  request: NextRequest;
  requestId: string;
  body: TBody;
  query: TQuery;
  /** Present only on authenticated routes. */
  service: ServiceContext;
  actor: AuthenticatedActor;
  params: Record<string, string>;
}

export interface PublicHandlerContext<TBody = unknown, TQuery = unknown> {
  request: NextRequest;
  requestId: string;
  body: TBody;
  query: TQuery;
  params: Record<string, string>;
  locale: Locale;
}

interface RouteOptions<TBody, TQuery> {
  bucket: RateLimitBucket;
  bodySchema?: z.ZodType<TBody, z.ZodTypeDef, unknown>;
  querySchema?: z.ZodType<TQuery, z.ZodTypeDef, unknown>;
  /** Require the acting user to be an admin. */
  admin?: boolean;
}

type RouteParams = { params?: Promise<Record<string, string>> | Record<string, string> };

const MAX_BODY_BYTES = 64 * 1024;

/* -------------------------------------------------------------- primitives -- */

function jsonResponse(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('x-request-id', requestId);
  response.headers.set('cache-control', 'no-store, no-cache, must-revalidate, private');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}

function errorResponse(error: AppError, requestId: string): NextResponse {
  const response = jsonResponse(error.toWire(requestId), error.status, requestId);
  if (error.code === 'RATE_LIMITED') {
    const retryAfter = error.details?.retryAfterSeconds;
    if (typeof retryAfter === 'number') {
      response.headers.set('retry-after', String(Math.max(1, Math.ceil(retryAfter))));
    }
  }
  return response;
}

/**
 * Client IP.
 *
 * Only trusted because Vercel terminates and rewrites `x-forwarded-for`; behind any other
 * proxy this must be re-verified. Used solely for rate limiting and hashed audit entries,
 * never for authorization.
 */
function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first && first.length <= 45) return first;
  }
  return request.headers.get('x-real-ip');
}

/**
 * Reject cross-origin requests.
 *
 * Telegram Mini App requests come from the app's own origin. Anything else is either a
 * misconfiguration or an attempt, and neither should reach the service layer.
 */
function assertAllowedOrigin(request: NextRequest): void {
  const origin = request.headers.get('origin');
  if (!origin) return; // Same-origin fetches and non-browser clients send no Origin.

  const allowed = getAppContext().config.corsAllowedOrigins;
  if (allowed.includes('*') || allowed.includes(origin)) return;

  throw new AppError('FORBIDDEN', { internal: `blocked cross-origin request from ${origin}` });
}

async function readJsonBody(request: NextRequest): Promise<unknown> {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') return undefined;

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE');
  }

  const declared = request.headers.get('content-length');
  if (declared && Number.parseInt(declared, 10) > MAX_BODY_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE');
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new AppError('PAYLOAD_TOO_LARGE');
  if (text.length === 0) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('VALIDATION_ERROR', { internal: 'body is not valid JSON' });
  }
}

function parseQuery<T>(
  request: NextRequest,
  schema: z.ZodType<T, z.ZodTypeDef, unknown> | undefined,
): T {
  if (!schema) return undefined as T;
  const raw: Record<string, string> = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    // Last value wins; array-style params are not part of any contract here.
    raw[key] = value;
  });
  return validate(schema, raw, 'query');
}

function validate<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  where: 'body' | 'query',
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  // Field paths and messages are safe to return; they describe the caller's own request.
  const fields = result.error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  throw new AppError('VALIDATION_ERROR', { details: { where, fields } });
}

async function resolveParams(context: RouteParams): Promise<Record<string, string>> {
  const params = context.params;
  if (!params) return {};
  return params instanceof Promise ? await params : params;
}

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/* ------------------------------------------------------------------ routes -- */

/**
 * Authenticated route.
 *
 * The actor is derived exclusively from the bearer token. Handlers receive a
 * `ServiceContext` already bound to that identity, so every database call they make is
 * RLS-constrained to the right user.
 */
export function route<TBody = undefined, TQuery = undefined, TResult = unknown>(
  options: RouteOptions<TBody, TQuery>,
  handler: (context: HandlerContext<TBody, TQuery>) => Promise<TResult>,
) {
  return async (request: NextRequest, routeParams: RouteParams = {}): Promise<NextResponse> => {
    const app = getAppContext();
    const services = getServices();
    const requestId = resolveRequestId(request.headers.get('x-request-id'));
    const startedAt = Date.now();

    try {
      assertAllowedOrigin(request);

      const token = bearerToken(request);
      if (!token) throw new AppError('UNAUTHORIZED', { internal: 'no bearer token' });

      const actor = await services.auth.resolveSession(token);
      if (!actor) throw new AppError('SESSION_EXPIRED');

      if (options.admin && !actor.isAdmin) throw new AppError('ADMIN_REQUIRED');

      // Rate limit on the authenticated identity, which is far more meaningful than an IP
      // behind Telegram's clients.
      await services.rateLimiter.enforce(options.bucket, actor.userId);

      const rawBody = await readJsonBody(request);
      const body = options.bodySchema
        ? validate(options.bodySchema, rawBody ?? {}, 'body')
        : (undefined as TBody);
      const query = parseQuery(request, options.querySchema);
      const params = await resolveParams(routeParams);

      const service = createServiceContext({
        app,
        actor,
        requestId,
        locale: actor.locale,
        ip: clientIp(request),
        userAgent: request.headers.get('user-agent'),
      });

      const result = await handler({
        request,
        requestId,
        body,
        query,
        service,
        actor,
        params,
      });

      app.logger.info('api request', {
        requestId,
        userId: actor.userId,
        operation: `${request.method} ${request.nextUrl.pathname}`,
        durationMs: Date.now() - startedAt,
        status: 200,
      });

      return jsonResponse(result ?? { ok: true }, 200, requestId);
    } catch (error) {
      const appError = toAppError(error);
      app.logger[appError.status >= 500 ? 'error' : 'warn']('api request failed', {
        requestId,
        operation: `${request.method} ${request.nextUrl.pathname}`,
        durationMs: Date.now() - startedAt,
        code: appError.code,
        status: appError.status,
        // `internal` is operator-only and never reaches the client.
        detail: appError.internal,
      });
      return errorResponse(appError, requestId);
    }
  };
}

/**
 * Unauthenticated route (authentication, health).
 *
 * Rate limited on a hashed IP, since there is no user yet.
 */
export function publicRoute<TBody = undefined, TQuery = undefined, TResult = unknown>(
  options: Omit<RouteOptions<TBody, TQuery>, 'admin'>,
  handler: (context: PublicHandlerContext<TBody, TQuery>) => Promise<TResult>,
) {
  return async (request: NextRequest, routeParams: RouteParams = {}): Promise<NextResponse> => {
    const app = getAppContext();
    const services = getServices();
    const requestId = resolveRequestId(request.headers.get('x-request-id'));
    const startedAt = Date.now();

    try {
      assertAllowedOrigin(request);

      const ip = clientIp(request);
      await services.rateLimiter.enforce(options.bucket, ip ?? 'anonymous');

      const rawBody = await readJsonBody(request);
      const body = options.bodySchema
        ? validate(options.bodySchema, rawBody ?? {}, 'body')
        : (undefined as TBody);
      const query = parseQuery(request, options.querySchema);
      const params = await resolveParams(routeParams);

      const result = await handler({
        request,
        requestId,
        body,
        query,
        params,
        locale: 'en',
      });

      app.logger.info('api request', {
        requestId,
        operation: `${request.method} ${request.nextUrl.pathname}`,
        durationMs: Date.now() - startedAt,
        status: 200,
      });

      return jsonResponse(result ?? { ok: true }, 200, requestId);
    } catch (error) {
      const appError = toAppError(error);
      app.logger[appError.status >= 500 ? 'error' : 'warn']('api request failed', {
        requestId,
        operation: `${request.method} ${request.nextUrl.pathname}`,
        durationMs: Date.now() - startedAt,
        code: appError.code,
        status: appError.status,
        detail: appError.internal,
      });
      return errorResponse(appError, requestId);
    }
  };
}

/** Localised error text, for the few places the server renders a message itself. */
export function translateError(locale: Locale, code: string): string {
  return createTranslator(locale)(`error.${code}`);
}

export { clientIp };
