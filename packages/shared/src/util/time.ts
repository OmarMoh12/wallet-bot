/** Time helpers shared by the UI, the bot and the workers. Pure, no I/O. */

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * SECOND_MS);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Whole days from `from` to `to`, using UTC calendar days. Negative when `to` is earlier. */
export function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / DAY_MS);
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** ISO calendar date, e.g. "2026-08-16". */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface RelativeTime {
  key: string;
  params: { count: number } | undefined;
}

/**
 * Choose the right relative-time message key. Returns a key + params so the caller can run it
 * through the localised, plural-aware translator rather than building English strings here.
 */
export function relativeTimeKey(from: Date, now: Date = new Date()): RelativeTime {
  const deltaMs = now.getTime() - from.getTime();
  if (deltaMs < 45 * SECOND_MS) return { key: 'common.justNow', params: undefined };
  if (deltaMs < HOUR_MS) {
    return { key: 'common.minutesAgo', params: { count: Math.round(deltaMs / MINUTE_MS) } };
  }
  if (deltaMs < DAY_MS) {
    return { key: 'common.hoursAgo', params: { count: Math.round(deltaMs / HOUR_MS) } };
  }
  return { key: 'common.daysAgo', params: { count: Math.round(deltaMs / DAY_MS) } };
}

/**
 * Period boundaries for analytics. Anchored on UTC so the same query gives the same answer
 * regardless of which server runs it; the UI labels it with the user's timezone.
 */
export type AnalyticsPeriod = 'week' | 'month' | 'quarter' | 'year';

export interface PeriodRange {
  start: Date;
  end: Date;
  previousStart: Date;
  previousEnd: Date;
  /** Bucket size for the time series. */
  bucket: 'day' | 'week' | 'month';
}

export function periodRange(period: AnalyticsPeriod, now: Date = new Date()): PeriodRange {
  const end = new Date(now.getTime());
  let start: Date;
  let bucket: PeriodRange['bucket'] = 'day';

  switch (period) {
    case 'week': {
      const day = startOfUtcDay(now);
      // ISO week starts Monday.
      const weekday = (day.getUTCDay() + 6) % 7;
      start = addDays(day, -weekday);
      bucket = 'day';
      break;
    }
    case 'month':
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      bucket = 'day';
      break;
    case 'quarter': {
      const quarterMonth = Math.floor(now.getUTCMonth() / 3) * 3;
      start = new Date(Date.UTC(now.getUTCFullYear(), quarterMonth, 1));
      bucket = 'week';
      break;
    }
    case 'year':
      start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      bucket = 'month';
      break;
    default: {
      const exhaustive: never = period;
      throw new Error(`Unknown period: ${String(exhaustive)}`);
    }
  }

  const span = end.getTime() - start.getTime();
  const previousEnd = new Date(start.getTime() - 1);
  const previousStart = new Date(start.getTime() - span);
  return { start, end, previousStart, previousEnd, bucket };
}

/**
 * Is `now` inside the user's quiet-hours window? Handles windows that wrap midnight.
 * `start`/`end` are "HH:MM" in the user's timezone; `nowMinutes` is minutes since midnight
 * in that same timezone (computed by the caller, which knows the timezone).
 */
export function isWithinQuietHours(
  nowMinutes: number,
  start: string | null,
  end: string | null,
): boolean {
  if (!start || !end) return false;
  const parse = (value: string): number | null => {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const hours = Number.parseInt(match[1] as string, 10);
    const minutes = Number.parseInt(match[2] as string, 10);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const from = parse(start);
  const to = parse(end);
  if (from === null || to === null || from === to) return false;
  return from < to ? nowMinutes >= from && nowMinutes < to : nowMinutes >= from || nowMinutes < to;
}

/** Minutes since midnight for `date` in the given IANA timezone. Falls back to UTC. */
export function minutesInTimezone(date: Date, timeZone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const hour = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const minute = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    return hour * 60 + minute;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

/** Exponential backoff with full jitter, capped. Used by every retryable job. */
export function backoffDelayMs(attempt: number, baseMs = 2000, capMs = 15 * MINUTE_MS): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exponential);
}
