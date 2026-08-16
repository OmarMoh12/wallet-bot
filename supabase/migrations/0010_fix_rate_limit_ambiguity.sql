-- =============================================================================
--  0010_fix_rate_limit_ambiguity
--
--  `app.bump_rate_limit` declared a PL/pgSQL variable named `window_start`, which is also a
--  column on `api_rate_limits`. PostgreSQL cannot disambiguate the two inside
--  `ON CONFLICT (bucket, subject, window_start)` and raised
--
--      column reference "window_start" is ambiguous
--
--  on every call. The application caught the error and degraded to its in-process counter,
--  so nothing appeared broken — rate limiting simply stopped being shared across instances,
--  which is exactly the property it exists to provide.
--
--  Prefixing the local variable removes the collision. `tests/integration/rate-limit.test.ts`
--  now asserts that the counter is actually persisted, so a silent regression here fails the
--  build rather than quietly weakening a security control.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.bump_rate_limit(
  p_bucket text,
  p_subject text,
  p_window_ms integer
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_window_start timestamptz;
  v_hits integer;
BEGIN
  -- Floor "now" onto the window grid so every caller agrees on the boundary.
  v_window_start := to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) * 1000 / p_window_ms) * p_window_ms / 1000.0
  );

  INSERT INTO api_rate_limits (bucket, subject, window_start, window_ms, hits)
  VALUES (p_bucket, p_subject, v_window_start, p_window_ms, 1)
  ON CONFLICT (bucket, subject, window_start)
  DO UPDATE SET hits = api_rate_limits.hits + 1, updated_at = now()
  RETURNING api_rate_limits.hits INTO v_hits;

  RETURN v_hits;
END;
$$;
