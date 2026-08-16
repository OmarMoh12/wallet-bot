import { AppError, rateLimitKey } from '@wallet/shared';
import { opsRepo, withSystem } from '@wallet/db';
import type { AppContext } from './context.js';

/**
 * Application-level rate limiting.
 *
 * Two tiers, deliberately:
 *
 *   1. **In-process fixed window** — a Map guarded by the same window boundary as the
 *      database counter. It absorbs bursts from a single instance without a round trip.
 *   2. **PostgreSQL counter** (`app.bump_rate_limit`) — one atomic upsert, so limits hold
 *      across serverless instances and worker replicas. There is no read-modify-write, so
 *      concurrent requests cannot both observe "one below the limit".
 *
 * What this is *not*: DDoS protection. Volumetric attacks are absorbed by the Vercel and
 * Railway edge before a request reaches this code. See docs/security.md for the split.
 */

export type RateLimitBucket = 'auth' | 'read' | 'write' | 'send' | 'admin';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: Date;
}

interface WindowSpec {
  limit: number;
  windowMs: number;
}

interface LocalCounter {
  windowStart: number;
  hits: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export class RateLimiter {
  /** Bounded so a flood of distinct subjects cannot grow this without limit. */
  private readonly local = new Map<string, LocalCounter>();
  private static readonly MAX_LOCAL_ENTRIES = 10_000;

  constructor(private readonly app: AppContext) {}

  private specFor(bucket: RateLimitBucket): WindowSpec {
    const limits = this.app.config.rateLimit;
    switch (bucket) {
      case 'auth':
        return { limit: limits.authPerMinute, windowMs: MINUTE_MS };
      case 'read':
        return { limit: limits.readPerMinute, windowMs: MINUTE_MS };
      case 'write':
        return { limit: limits.writePerMinute, windowMs: MINUTE_MS };
      case 'send':
        return { limit: limits.sendPerHour, windowMs: HOUR_MS };
      case 'admin':
        return { limit: limits.writePerMinute, windowMs: MINUTE_MS };
      default: {
        const exhaustive: never = bucket;
        void exhaustive;
        return { limit: limits.readPerMinute, windowMs: MINUTE_MS };
      }
    }
  }

  /**
   * Record a hit and decide.
   *
   * `subject` should be the most specific identity available — a user id where the caller is
   * authenticated, a hashed IP otherwise. Never a raw client-supplied value.
   */
  async check(
    bucket: RateLimitBucket,
    subject: string,
    options: { costs?: number } = {},
  ): Promise<RateLimitDecision> {
    const spec = this.specFor(bucket);
    const now = Date.now();
    const windowStart = Math.floor(now / spec.windowMs) * spec.windowMs;
    const resetAt = new Date(windowStart + spec.windowMs);
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000));

    if (!this.app.config.rateLimit.enabled) {
      return {
        allowed: true,
        limit: spec.limit,
        remaining: spec.limit,
        retryAfterSeconds,
        resetAt,
      };
    }

    const key = rateLimitKey(bucket, subject);
    const cost = options.costs ?? 1;

    // Tier 1: local. Rejecting here saves the database round trip entirely.
    const localHits = this.bumpLocal(key, windowStart, cost);
    if (localHits > spec.limit) {
      return { allowed: false, limit: spec.limit, remaining: 0, retryAfterSeconds, resetAt };
    }

    // Tier 2: shared counter.
    let hits = localHits;
    try {
      hits = await withSystem(this.app.sql, (tx) =>
        opsRepo.bumpRateLimit(tx, { bucket, subject, windowMs: spec.windowMs }),
      );
    } catch (error) {
      // A rate-limit store failure must not take the API down, so this degrades to
      // per-instance limiting rather than to no limiting. It is logged at ERROR, not warn:
      // a silently-degraded rate limiter is how a control stops working without anyone
      // noticing, which is exactly what happened before migration 0010.
      this.app.logger.error('rate limit store unavailable; falling back to local counters', {
        operation: 'ratelimit.check',
        bucket,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

    const allowed = hits <= spec.limit;
    return {
      allowed,
      limit: spec.limit,
      remaining: Math.max(0, spec.limit - hits),
      retryAfterSeconds,
      resetAt,
    };
  }

  /** Throwing variant, for call sites that just want the guard. */
  async enforce(bucket: RateLimitBucket, subject: string): Promise<RateLimitDecision> {
    const decision = await this.check(bucket, subject);
    if (!decision.allowed) {
      throw new AppError('RATE_LIMITED', {
        details: { retryAfterSeconds: decision.retryAfterSeconds, limit: decision.limit },
      });
    }
    return decision;
  }

  private bumpLocal(key: string, windowStart: number, cost: number): number {
    const existing = this.local.get(key);
    if (!existing || existing.windowStart !== windowStart) {
      // Opportunistic eviction: drop everything from an older window when we grow too big.
      if (this.local.size >= RateLimiter.MAX_LOCAL_ENTRIES) {
        for (const [candidate, counter] of this.local) {
          if (counter.windowStart !== windowStart) this.local.delete(candidate);
        }
        if (this.local.size >= RateLimiter.MAX_LOCAL_ENTRIES) this.local.clear();
      }
      this.local.set(key, { windowStart, hits: cost });
      return cost;
    }
    existing.hits += cost;
    return existing.hits;
  }

  /** Test seam. */
  reset(): void {
    this.local.clear();
  }
}
