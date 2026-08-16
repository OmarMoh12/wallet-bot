import { parseCount, type HealthDto } from '@wallet/shared';
import { opsRepo, withSystem } from '@wallet/db';
import type { AppContext } from '../context.js';

/**
 * Health reporting.
 *
 * Distinguishes `degraded` from `down` on purpose. A market-data outage means totals are
 * stale but the app is usable; a database outage means it is not. Conflating them makes the
 * signal useless for deciding whether to page someone.
 */

const startedAt = Date.now();

interface Check {
  name: string;
  status: 'ok' | 'degraded' | 'down';
  latencyMs: number | null;
  detail?: string;
}

async function timed<T>(
  run: () => Promise<T>,
): Promise<{ value: T | null; ms: number; error: string | null }> {
  const start = Date.now();
  try {
    const value = await run();
    return { value, ms: Date.now() - start, error: null };
  } catch (error) {
    return {
      value: null,
      ms: Date.now() - start,
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

export async function healthReport(
  app: AppContext,
  service: string,
  options: { deep?: boolean } = {},
): Promise<HealthDto> {
  const checks: Check[] = [];

  // --- database (the only hard dependency) ------------------------------------
  const db = await timed(() => withSystem(app.sql, (tx) => tx`SELECT 1 AS ok`));
  checks.push({
    name: 'database',
    status: db.error ? 'down' : 'ok',
    latencyMs: db.ms,
    ...(db.error ? { detail: 'query failed' } : {}),
  });

  // --- queue depth --------------------------------------------------------------
  if (!db.error) {
    const queue = await timed(() => withSystem(app.sql, (tx) => opsRepo.jobQueueStats(tx)));
    const stats = Object.fromEntries(
      (queue.value ?? []).map((row) => [row.status, parseCount(row.count)]),
    );
    const dead = stats.dead ?? 0;
    const queued = stats.queued ?? 0;
    checks.push({
      name: 'jobs',
      // A backlog is a warning; dead jobs mean something needs a human.
      status: dead > 0 ? 'degraded' : queued > 500 ? 'degraded' : 'ok',
      latencyMs: queue.ms,
      detail: `queued=${queued} dead=${dead}`,
    });
  }

  // --- exchange rate freshness ---------------------------------------------------
  if (!db.error) {
    const rate = await timed(() =>
      withSystem(app.sql, (tx) => opsRepo.latestExchangeRate(tx, 'USD', 'ILS')),
    );
    const row = rate.value;
    const ageSeconds = row ? Math.floor((Date.now() - row.fetched_at.getTime()) / 1000) : null;
    checks.push({
      name: 'exchange_rate',
      status:
        ageSeconds === null
          ? 'degraded'
          : ageSeconds > app.config.market.fxMaxStalenessSeconds
            ? 'down'
            : ageSeconds > app.config.market.fxRefreshSeconds * 4
              ? 'degraded'
              : 'ok',
      latencyMs: rate.ms,
      detail: ageSeconds === null ? 'no rate recorded yet' : `age=${ageSeconds}s`,
    });
  }

  // --- providers (only on the deep check; these are outbound network calls) -------
  if (options.deep) {
    for (const provider of app.providers.all()) {
      const result = await timed(() => provider.health());
      checks.push({
        name: `chain:${provider.network}`,
        status: result.value?.healthy ? 'ok' : 'degraded',
        latencyMs: result.value?.latencyMs ?? result.ms,
        ...(result.value?.detail ? { detail: result.value.detail } : {}),
      });
    }

    const signer = await timed(() => app.signer.health());
    checks.push({
      name: 'signer',
      status: signer.value?.healthy ? 'ok' : 'degraded',
      latencyMs: signer.ms,
      detail: `mode=${app.signer.mode}`,
    });
  }

  checks.push({
    name: 'telegram',
    status: app.telegram ? 'ok' : 'degraded',
    latencyMs: null,
    detail: app.telegram ? 'configured' : 'TELEGRAM_BOT_TOKEN not set',
  });

  const status: HealthDto['status'] = checks.some((check) => check.status === 'down')
    ? 'down'
    : checks.some((check) => check.status === 'degraded')
      ? 'degraded'
      : 'ok';

  return {
    status,
    service,
    version: app.config.version,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    checks,
    timestamp: new Date().toISOString(),
  };
}
