-- =============================================================================
--  0006_functions
--  Invariants that must hold no matter which process writes:
--    * state-machine transitions
--    * cash-account balance maintenance
--    * atomic job claiming
--    * atomic rate-limit counters
--    * atomic replay-protection gate
-- =============================================================================

-- -----------------------------------------------------------------------------
--  State machines, enforced in the database.
--
--  packages/shared/domain/state-machines.ts enforces the same rules in TypeScript. Having
--  them here too means a psql session, a migration, or a future service cannot corrupt a
--  financial state machine by accident.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.assert_tx_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed text[];
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'pending'    THEN ARRAY['confirmed', 'failed', 'cancelled']
    WHEN 'detected'   THEN ARRAY['confirming', 'confirmed', 'failed']
    WHEN 'confirming' THEN ARRAY['confirmed', 'failed']
    WHEN 'confirmed'  THEN ARRAY['reversed']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status::text = ANY (allowed)) THEN
    RAISE EXCEPTION 'invalid transaction status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.assert_scheduled_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed text[];
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'scheduled'  THEN ARRAY['processing', 'cancelled']
    -- 'processing' -> 'scheduled' releases the lease when a pre-flight check says
    -- "not now" (e.g. provider unreachable). Nothing was sent in that case.
    WHEN 'processing' THEN ARRAY['completed', 'failed', 'scheduled']
    WHEN 'failed'     THEN ARRAY['scheduled', 'cancelled']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status::text = ANY (allowed)) THEN
    RAISE EXCEPTION 'invalid scheduled payment transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.assert_send_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed text[];
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'quoted'    THEN ARRAY['confirmed', 'cancelled', 'expired']
    WHEN 'confirmed' THEN ARRAY['signing', 'failed', 'cancelled']
    WHEN 'signing'   THEN ARRAY['broadcast', 'failed']
    WHEN 'broadcast' THEN ARRAY['completed', 'failed']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status::text = ANY (allowed)) THEN
    RAISE EXCEPTION 'invalid send request transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.assert_expected_income_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed text[];
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'pending'   THEN ARRAY['received', 'delayed', 'cancelled']
    WHEN 'delayed'   THEN ARRAY['received', 'cancelled', 'pending']
    WHEN 'cancelled' THEN ARRAY['pending']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status::text = ANY (allowed)) THEN
    RAISE EXCEPTION 'invalid expected income transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tx_status_machine ON transactions;
CREATE TRIGGER trg_tx_status_machine
  BEFORE UPDATE OF status ON transactions
  FOR EACH ROW EXECUTE FUNCTION app.assert_tx_status_transition();

DROP TRIGGER IF EXISTS trg_scheduled_status_machine ON scheduled_payments;
CREATE TRIGGER trg_scheduled_status_machine
  BEFORE UPDATE OF status ON scheduled_payments
  FOR EACH ROW EXECUTE FUNCTION app.assert_scheduled_status_transition();

DROP TRIGGER IF EXISTS trg_send_status_machine ON send_requests;
CREATE TRIGGER trg_send_status_machine
  BEFORE UPDATE OF status ON send_requests
  FOR EACH ROW EXECUTE FUNCTION app.assert_send_status_transition();

DROP TRIGGER IF EXISTS trg_expected_income_machine ON expected_income;
CREATE TRIGGER trg_expected_income_machine
  BEFORE UPDATE OF status ON expected_income
  FOR EACH ROW EXECUTE FUNCTION app.assert_expected_income_transition();

-- -----------------------------------------------------------------------------
--  Cash account balances.
--
--  Derived from the ledger by trigger rather than written by application code, so the
--  cached balance cannot drift from the transactions that justify it. Only `confirmed`,
--  non-deleted cash rows count.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.cash_effective_amount(
  p_kind tx_kind_t,
  p_status tx_status_t,
  p_deleted_at timestamptz,
  p_amount bigint
)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_kind <> 'cash' THEN 0
    WHEN p_deleted_at IS NOT NULL THEN 0
    WHEN p_status <> 'confirmed' THEN 0
    ELSE COALESCE(p_amount, 0)
  END;
$$;

CREATE OR REPLACE FUNCTION app.sync_cash_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_amount bigint := 0;
  new_amount bigint := 0;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.cash_account_id IS NOT NULL THEN
    old_amount := app.cash_effective_amount(OLD.kind, OLD.status, OLD.deleted_at, OLD.fiat_amount_minor);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.cash_account_id IS NOT NULL THEN
    new_amount := app.cash_effective_amount(NEW.kind, NEW.status, NEW.deleted_at, NEW.fiat_amount_minor);
  END IF;

  -- Moved between accounts: reverse from the old, apply to the new.
  IF TG_OP = 'UPDATE'
     AND OLD.cash_account_id IS DISTINCT FROM NEW.cash_account_id THEN
    IF OLD.cash_account_id IS NOT NULL AND old_amount <> 0 THEN
      UPDATE cash_accounts SET balance_minor = balance_minor - old_amount
        WHERE id = OLD.cash_account_id;
    END IF;
    IF NEW.cash_account_id IS NOT NULL AND new_amount <> 0 THEN
      UPDATE cash_accounts SET balance_minor = balance_minor + new_amount
        WHERE id = NEW.cash_account_id;
    END IF;
    RETURN NULL;
  END IF;

  IF new_amount <> old_amount THEN
    UPDATE cash_accounts
      SET balance_minor = balance_minor + (new_amount - old_amount)
      WHERE id = COALESCE(NEW.cash_account_id, OLD.cash_account_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_cash_balance ON transactions;
CREATE TRIGGER trg_sync_cash_balance
  AFTER INSERT OR UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION app.sync_cash_balance();

-- Recompute a cash account from scratch. Used by tests, by the admin panel, and after any
-- bulk maintenance. The invariant it asserts is "cache == sum(ledger)".
CREATE OR REPLACE FUNCTION app.recompute_cash_balance(p_account_id uuid)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  total bigint;
BEGIN
  SELECT COALESCE(SUM(fiat_amount_minor), 0) INTO total
  FROM transactions
  WHERE cash_account_id = p_account_id
    AND kind = 'cash'
    AND status = 'confirmed'
    AND deleted_at IS NULL;

  UPDATE cash_accounts SET balance_minor = total WHERE id = p_account_id;
  RETURN total;
END;
$$;

-- -----------------------------------------------------------------------------
--  Replay-protection gate.
--
--  Returns true when THIS caller is the one that claimed the key. Race-free because the
--  uniqueness is decided by the index, never by a preceding SELECT.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.claim_event(
  p_scope text,
  p_event_key text,
  p_ttl_seconds integer DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  inserted integer;
BEGIN
  INSERT INTO processed_events (scope, event_key, expires_at, metadata)
  VALUES (
    p_scope,
    p_event_key,
    CASE WHEN p_ttl_seconds IS NULL THEN NULL ELSE now() + make_interval(secs => p_ttl_seconds) END,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (scope, event_key) DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted = 1;
END;
$$;

-- -----------------------------------------------------------------------------
--  Job queue
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.enqueue_job(
  p_type text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_run_at timestamptz DEFAULT now(),
  p_dedupe_key text DEFAULT NULL,
  p_queue text DEFAULT 'default',
  p_priority smallint DEFAULT 100,
  p_max_attempts smallint DEFAULT 5
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  job_id uuid;
BEGIN
  INSERT INTO jobs (type, queue, payload, run_at, dedupe_key, priority, max_attempts)
  VALUES (p_type, p_queue, COALESCE(p_payload, '{}'::jsonb), p_run_at, p_dedupe_key, p_priority, p_max_attempts)
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running')
  DO UPDATE SET
    -- Keep the earliest requested run time; an equivalent job already covers the work.
    run_at = LEAST(jobs.run_at, EXCLUDED.run_at),
    updated_at = now()
  RETURNING id INTO job_id;

  RETURN job_id;
END;
$$;

-- Claim up to `p_limit` due jobs for this worker. SKIP LOCKED means N workers never
-- collide, and the lease (`locked_until`) means a crashed worker's jobs come back.
CREATE OR REPLACE FUNCTION app.claim_jobs(
  p_worker text,
  p_limit integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 60,
  p_queue text DEFAULT 'default'
)
RETURNS SETOF jobs
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT id FROM jobs
    WHERE queue = p_queue
      AND status = 'queued'
      AND run_at <= now()
    ORDER BY priority ASC, run_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE jobs j
  SET status = 'running',
      attempts = j.attempts + 1,
      locked_by = p_worker,
      locked_until = now() + make_interval(secs => p_lease_seconds),
      started_at = now(),
      updated_at = now()
  FROM claimed
  WHERE j.id = claimed.id
  RETURNING j.*;
END;
$$;

-- Return abandoned jobs (expired lease) to the queue.
CREATE OR REPLACE FUNCTION app.reclaim_stuck_jobs(p_grace_seconds integer DEFAULT 0)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE jobs
  SET status = CASE WHEN attempts >= max_attempts THEN 'dead'::job_status_t ELSE 'queued'::job_status_t END,
      locked_by = NULL,
      locked_until = NULL,
      last_error = COALESCE(last_error, 'lease expired'),
      finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
      updated_at = now()
  WHERE status = 'running'
    AND locked_until IS NOT NULL
    AND locked_until < now() - make_interval(secs => p_grace_seconds);

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- -----------------------------------------------------------------------------
--  Rate limiting — one atomic upsert per request, no read-modify-write race.
--  Returns the hit count *after* recording this request.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.bump_rate_limit(
  p_bucket text,
  p_subject text,
  p_window_ms integer
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  window_start timestamptz;
  current_hits integer;
BEGIN
  -- Floor "now" to the window grid so every caller agrees on the boundary.
  window_start := to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) * 1000 / p_window_ms) * p_window_ms / 1000.0
  );

  INSERT INTO api_rate_limits (bucket, subject, window_start, window_ms, hits)
  VALUES (p_bucket, p_subject, window_start, p_window_ms, 1)
  ON CONFLICT (bucket, subject, window_start)
  DO UPDATE SET hits = api_rate_limits.hits + 1, updated_at = now()
  RETURNING hits INTO current_hits;

  RETURN current_hits;
END;
$$;

-- -----------------------------------------------------------------------------
--  Goal progress: flip to 'achieved' the moment the target is reached.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.sync_goal_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'active' AND NEW.current_minor >= NEW.target_minor THEN
    NEW.status := 'achieved';
    NEW.achieved_at := COALESCE(NEW.achieved_at, now());
  ELSIF NEW.status = 'achieved' AND NEW.current_minor < NEW.target_minor THEN
    NEW.status := 'active';
    NEW.achieved_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_goal_status ON financial_goals;
CREATE TRIGGER trg_sync_goal_status
  BEFORE INSERT OR UPDATE OF current_minor, target_minor ON financial_goals
  FOR EACH ROW EXECUTE FUNCTION app.sync_goal_status();

-- -----------------------------------------------------------------------------
--  Housekeeping
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.cleanup_expired(p_job_retention_days integer DEFAULT 14)
RETURNS TABLE (deleted_events bigint, deleted_jobs bigint, deleted_sessions bigint, deleted_limits bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  a bigint; b bigint; c bigint; d bigint;
BEGIN
  DELETE FROM processed_events WHERE expires_at IS NOT NULL AND expires_at < now();
  GET DIAGNOSTICS a = ROW_COUNT;

  DELETE FROM jobs
  WHERE status IN ('succeeded', 'dead')
    AND finished_at < now() - make_interval(days => p_job_retention_days);
  GET DIAGNOSTICS b = ROW_COUNT;

  DELETE FROM sessions WHERE expires_at < now() - interval '7 days';
  GET DIAGNOSTICS c = ROW_COUNT;

  DELETE FROM api_rate_limits WHERE window_start < now() - interval '1 day';
  GET DIAGNOSTICS d = ROW_COUNT;

  RETURN QUERY SELECT a, b, c, d;
END;
$$;
