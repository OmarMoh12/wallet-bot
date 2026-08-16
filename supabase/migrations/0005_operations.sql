-- =============================================================================
--  0005_operations
--  Notifications, jobs (the queue), audit logs, market data, rate limits,
--  processed events, and app settings.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  Notifications
--
--  Delivery is a database row, not an in-memory event. That is what makes notifications
--  work while the Mini App is closed, survive a bot restart, and retry safely.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type                text NOT NULL,
  -- Localisation params only — never a pre-rendered string, so the message is rendered in
  -- whatever language the user has selected at delivery time.
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              notification_status_t NOT NULL DEFAULT 'queued',
  -- The anti-spam primitive: one row per (user, logical event).
  dedupe_key          text NOT NULL,
  deliver_after       timestamptz NOT NULL DEFAULT now(),
  attempts            smallint NOT NULL DEFAULT 0,
  sent_at             timestamptz,
  telegram_message_id bigint,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT notifications_type_bounded CHECK (length(type) BETWEEN 1 AND 64),
  CONSTRAINT notifications_dedupe_bounded CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  CONSTRAINT notifications_error_bounded CHECK (error IS NULL OR length(error) <= 500),
  CONSTRAINT notifications_attempts CHECK (attempts >= 0 AND attempts <= 20)
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx
  ON notifications (user_id, dedupe_key);
CREATE INDEX IF NOT EXISTS notifications_pending_idx
  ON notifications (deliver_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS notifications_user_idx
  ON notifications (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
--  Jobs — the queue.
--
--  Postgres rather than Redis, deliberately. A chain-scan handler inserts the transaction,
--  updates the balance, enqueues the notification and completes its own job in ONE commit.
--  With an external broker those steps can disagree after a crash, which is precisely how
--  duplicate or missing money records happen. See docs/architecture.md §3.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  queue         text NOT NULL DEFAULT 'default',
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        job_status_t NOT NULL DEFAULT 'queued',
  priority      smallint NOT NULL DEFAULT 100,
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      smallint NOT NULL DEFAULT 0,
  max_attempts  smallint NOT NULL DEFAULT 5,
  -- Lease held by a worker while running. Expiry reclaims abandoned work.
  locked_by     text,
  locked_until  timestamptz,
  last_error    text,
  -- Optional: collapses equivalent queued work into a single row.
  dedupe_key    text,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT jobs_type_bounded CHECK (length(type) BETWEEN 1 AND 64),
  CONSTRAINT jobs_attempts CHECK (attempts >= 0 AND max_attempts > 0),
  CONSTRAINT jobs_error_bounded CHECK (last_error IS NULL OR length(last_error) <= 2000)
);

-- Only one *pending* job per dedupe key; finished ones do not block re-enqueueing.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_idx
  ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
-- The dequeue path: FOR UPDATE SKIP LOCKED over this index.
CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (queue, status, run_at, priority)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_stuck_idx
  ON jobs (locked_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_cleanup_idx
  ON jobs (finished_at) WHERE status IN ('succeeded', 'dead');

-- -----------------------------------------------------------------------------
--  Processed events — replay protection.
--
--  Two distinct uses:
--    * chain events  ("we already ingested this transfer")
--    * initData hashes ("this Telegram payload was already exchanged for a session")
--  Both are "insert and check rowcount" gates, which is race-free because uniqueness is
--  enforced by the index, not by a prior SELECT.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         text NOT NULL,
  event_key     text NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  -- Rows older than this can be pruned; keeps the table from growing without bound.
  expires_at    timestamptz,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT processed_events_scope_bounded CHECK (length(scope) BETWEEN 1 AND 40),
  CONSTRAINT processed_events_key_bounded CHECK (length(event_key) BETWEEN 1 AND 300)
);

CREATE UNIQUE INDEX IF NOT EXISTS processed_events_identity_idx
  ON processed_events (scope, event_key);
CREATE INDEX IF NOT EXISTS processed_events_expiry_idx
  ON processed_events (expires_at) WHERE expires_at IS NOT NULL;

-- -----------------------------------------------------------------------------
--  Audit log — append-only. No UPDATE or DELETE grant is issued to the app role.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_type   actor_type_t NOT NULL DEFAULT 'user',
  action       text NOT NULL,
  entity_type  text,
  entity_id    uuid,
  -- Hashed, not raw: enough to correlate abuse, not enough to be a tracking database.
  ip_hash      text,
  user_agent   text,
  request_id   text,
  -- Redacted before insertion by packages/shared/util/redact.
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_action_bounded CHECK (length(action) BETWEEN 1 AND 64),
  CONSTRAINT audit_logs_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT audit_logs_ua_bounded CHECK (user_agent IS NULL OR length(user_agent) <= 512)
);

CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx
  ON audit_logs (entity_type, entity_id) WHERE entity_id IS NOT NULL;

-- -----------------------------------------------------------------------------
--  Market data
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exchange_rates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base        fiat_code NOT NULL,
  quote       fiat_code NOT NULL,
  rate        rate_value NOT NULL,
  source      text NOT NULL,
  is_manual   boolean NOT NULL DEFAULT false,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exchange_rates_distinct CHECK (base <> quote),
  CONSTRAINT exchange_rates_source_bounded CHECK (length(source) BETWEEN 1 AND 40)
);

-- Latest-rate lookup and the historical series both ride this index.
CREATE INDEX IF NOT EXISTS exchange_rates_lookup_idx
  ON exchange_rates (base, quote, fetched_at DESC);

CREATE TABLE IF NOT EXISTS asset_prices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  quote       fiat_code NOT NULL DEFAULT 'USD',
  price       numeric(30, 12) NOT NULL,
  source      text NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_prices_non_negative CHECK (price >= 0),
  CONSTRAINT asset_prices_source_bounded CHECK (length(source) BETWEEN 1 AND 40)
);

CREATE INDEX IF NOT EXISTS asset_prices_lookup_idx
  ON asset_prices (asset_id, quote, fetched_at DESC);

-- -----------------------------------------------------------------------------
--  Rate limiting (fixed-window counters).
--
--  Application-level only. Volumetric/network DDoS is handled by the Vercel and Railway
--  edge; see docs/security.md for the exact split of responsibilities.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_rate_limits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket        text NOT NULL,
  subject       text NOT NULL,
  window_start  timestamptz NOT NULL,
  window_ms     integer NOT NULL,
  hits          integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_rate_limits_hits CHECK (hits >= 0),
  CONSTRAINT api_rate_limits_window CHECK (window_ms > 0),
  CONSTRAINT api_rate_limits_bucket_bounded CHECK (length(bucket) BETWEEN 1 AND 64),
  CONSTRAINT api_rate_limits_subject_bounded CHECK (length(subject) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS api_rate_limits_identity_idx
  ON api_rate_limits (bucket, subject, window_start);
CREATE INDEX IF NOT EXISTS api_rate_limits_cleanup_idx ON api_rate_limits (window_start);

-- -----------------------------------------------------------------------------
--  App settings — runtime configuration and kill switches.
--
--  Values here can only *tighten* what the environment allows. `SENDING_ENABLED=false` in
--  the environment cannot be overridden from the database; the setting is ANDed with it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_settings_key_bounded CHECK (length(key) BETWEEN 1 AND 64)
);

SELECT app.attach_touch_trigger('notifications');
SELECT app.attach_touch_trigger('jobs');
