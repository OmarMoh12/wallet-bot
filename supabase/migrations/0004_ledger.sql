-- =============================================================================
--  0004_ledger
--  The unified transaction ledger plus the forward-looking money tables
--  (expected income, scheduled payments, send requests, goals).
-- =============================================================================

-- -----------------------------------------------------------------------------
--  transactions
--
--  One table for both cash and crypto. The alternative — two parallel tables — makes every
--  history query, filter, search and analytics aggregate a UNION, and makes it easy for the
--  two halves to drift apart. Instead we use a discriminator column plus CHECK constraints
--  that make each variant's columns mandatory-together, so the database rejects a half-built
--  row of either kind.
--
--  Money columns:
--    * fiat_amount_minor  BIGINT      signed integer minor units (cents/agorot)
--    * raw_amount         base_units  signed integer token base units
--  Neither is ever a float. Valuations (value_usd_minor / value_ils_minor) are snapshots
--  taken when the row was written, with the exact rate and price recorded alongside, so a
--  historical report never silently changes because today's rate changed.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind                  tx_kind_t NOT NULL,
  type                  tx_type_t NOT NULL,
  direction             tx_direction_t NOT NULL,
  status                tx_status_t NOT NULL DEFAULT 'pending',
  source                tx_source_t NOT NULL DEFAULT 'manual',

  title                 text NOT NULL,
  description           text,
  notes                 text,
  category_id           uuid REFERENCES categories (id) ON DELETE SET NULL,
  occurred_at           timestamptz NOT NULL DEFAULT now(),

  -- ---- cash leg ----
  cash_account_id       uuid REFERENCES cash_accounts (id) ON DELETE RESTRICT,
  fiat_currency         fiat_code,
  fiat_amount_minor     bigint,

  -- ---- crypto leg ----
  wallet_id             uuid REFERENCES wallets (id) ON DELETE SET NULL,
  asset_id              uuid REFERENCES assets (id) ON DELETE RESTRICT,
  raw_amount            base_units,
  network               network_t,
  env                   network_env_t,
  tx_hash               text,
  -- Distinguishes multiple transfers inside one transaction hash.
  log_index             integer,
  counterparty_address  text,
  memo                  text,
  fee_asset_id          uuid REFERENCES assets (id) ON DELETE RESTRICT,
  fee_raw_amount        base_units,
  confirmations         integer,
  required_confirmations integer,
  block_number          bigint,
  block_time            timestamptz,

  -- ---- valuation snapshot ----
  value_usd_minor       bigint,
  value_ils_minor       bigint,
  usd_ils_rate          rate_value,
  unit_price_usd        numeric(30, 12),
  valued_at             timestamptz,

  -- ---- provenance / integrity ----
  external_ref          text,
  attachment_url        text,
  idempotency_key       text,
  send_request_id       uuid,
  scheduled_payment_id  uuid,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,

  CONSTRAINT transactions_title_bounded CHECK (length(title) BETWEEN 1 AND 120),
  CONSTRAINT transactions_description_bounded CHECK (description IS NULL OR length(description) <= 500),
  CONSTRAINT transactions_notes_bounded CHECK (notes IS NULL OR length(notes) <= 2000),
  CONSTRAINT transactions_memo_bounded CHECK (memo IS NULL OR length(memo) <= 120),
  CONSTRAINT transactions_attachment_https CHECK (
    attachment_url IS NULL OR attachment_url ~ '^https://'
  ),

  -- A cash row must have a complete fiat leg and no crypto leg.
  CONSTRAINT transactions_cash_shape CHECK (
    kind <> 'cash' OR (
      fiat_currency IS NOT NULL
      AND fiat_amount_minor IS NOT NULL
      AND wallet_id IS NULL
      AND asset_id IS NULL
      AND raw_amount IS NULL
      AND tx_hash IS NULL
    )
  ),
  -- A crypto row must have a complete token leg.
  CONSTRAINT transactions_crypto_shape CHECK (
    kind <> 'crypto' OR (
      asset_id IS NOT NULL
      AND raw_amount IS NOT NULL
      AND network IS NOT NULL
      AND env IS NOT NULL
      AND cash_account_id IS NULL
      AND fiat_amount_minor IS NULL
    )
  ),
  -- Amount sign must agree with direction, so a "+" row can never reduce a balance.
  CONSTRAINT transactions_cash_sign CHECK (
    kind <> 'cash' OR type = 'adjustment' OR
    (direction = 'in' AND fiat_amount_minor > 0) OR
    (direction = 'out' AND fiat_amount_minor < 0) OR
    (direction = 'internal')
  ),
  CONSTRAINT transactions_crypto_sign CHECK (
    kind <> 'crypto' OR
    (direction = 'in' AND raw_amount > 0) OR
    (direction = 'out' AND raw_amount < 0) OR
    (direction = 'internal')
  ),
  -- A chain-sourced row must carry the identity that makes it deduplicable.
  CONSTRAINT transactions_chain_identity CHECK (
    source <> 'chain' OR (tx_hash IS NOT NULL AND log_index IS NOT NULL)
  ),
  CONSTRAINT transactions_confirmations CHECK (
    confirmations IS NULL OR confirmations >= 0
  ),
  CONSTRAINT transactions_valuation_pair CHECK (
    (value_usd_minor IS NULL AND valued_at IS NULL)
    OR (value_usd_minor IS NOT NULL AND valued_at IS NOT NULL)
  )
);

-- ---- Idempotency guarantees ---------------------------------------------------
-- (1) The same on-chain movement can only ever produce one row, no matter how many times
--     an indexer replays it or how many workers race.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_chain_identity_idx
  ON transactions (network, env, tx_hash, log_index)
  WHERE tx_hash IS NOT NULL;
-- (2) A retried client request produces one row, not two.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_idempotency_idx
  ON transactions (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---- Query indexes ------------------------------------------------------------
-- Primary history feed: newest first, per user.
CREATE INDEX IF NOT EXISTS transactions_user_time_idx
  ON transactions (user_id, occurred_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS transactions_user_kind_time_idx
  ON transactions (user_id, kind, occurred_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS transactions_wallet_time_idx
  ON transactions (wallet_id, occurred_at DESC)
  WHERE wallet_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS transactions_category_idx
  ON transactions (category_id) WHERE category_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS transactions_cash_account_idx
  ON transactions (cash_account_id) WHERE cash_account_id IS NOT NULL AND deleted_at IS NULL;
-- Confirmation walker: "which chain rows are still in flight?"
CREATE INDEX IF NOT EXISTS transactions_in_flight_idx
  ON transactions (status, updated_at)
  WHERE status IN ('detected', 'confirming') AND deleted_at IS NULL;
-- Free-text search over title/description/hash/counterparty.
CREATE INDEX IF NOT EXISTS transactions_search_idx
  ON transactions USING gin (
    to_tsvector('simple',
      coalesce(title, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(tx_hash, '') || ' ' ||
      coalesce(counterparty_address, '')
    )
  );

-- -----------------------------------------------------------------------------
--  Expected income
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expected_income (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name                     text NOT NULL,
  reason                   text,
  amount_minor             bigint NOT NULL,
  currency                 fiat_code NOT NULL,
  expected_date            date NOT NULL,
  status                   expected_income_status_t NOT NULL DEFAULT 'pending',
  remind_at                timestamptz,
  reminded_at              timestamptz,
  overdue_notified_at      timestamptz,
  category_id              uuid REFERENCES categories (id) ON DELETE SET NULL,
  notes                    text,
  received_transaction_id  uuid REFERENCES transactions (id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  CONSTRAINT expected_income_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT expected_income_name_bounded CHECK (length(name) BETWEEN 1 AND 60),
  CONSTRAINT expected_income_reason_bounded CHECK (reason IS NULL OR length(reason) <= 500),
  CONSTRAINT expected_income_received_link CHECK (
    status <> 'received' OR received_transaction_id IS NOT NULL OR deleted_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS expected_income_user_idx
  ON expected_income (user_id, expected_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS expected_income_due_idx
  ON expected_income (status, expected_date)
  WHERE status IN ('pending', 'delayed') AND deleted_at IS NULL;

-- -----------------------------------------------------------------------------
--  Scheduled payments
--
--  A scheduled payment is an INTENT, not a signed transaction. Nothing here can move funds
--  on its own: execution runs through the same guarded send pipeline as a manual transfer,
--  which is refused outright while sending is disabled.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_payments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  wallet_id               uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
  asset_id                uuid NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
  title                   text,
  to_address              text NOT NULL,
  to_address_canonical    text NOT NULL,
  raw_amount              base_units NOT NULL,
  memo                    text,
  scheduled_at            timestamptz NOT NULL,
  status                  scheduled_status_t NOT NULL DEFAULT 'scheduled',
  attempts                smallint NOT NULL DEFAULT 0,
  max_attempts            smallint NOT NULL DEFAULT 3,
  last_error_code         text,
  last_error_at           timestamptz,
  next_attempt_at         timestamptz,
  -- Execution lease. Two workers cannot both hold a live lease on the same row.
  locked_by               text,
  locked_until            timestamptz,
  executed_transaction_id uuid REFERENCES transactions (id) ON DELETE SET NULL,
  send_request_id         uuid,
  upcoming_notified_at    timestamptz,
  idempotency_key         text NOT NULL,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT scheduled_payments_amount_positive CHECK (raw_amount > 0),
  CONSTRAINT scheduled_payments_attempts CHECK (attempts >= 0 AND attempts <= max_attempts + 5),
  CONSTRAINT scheduled_payments_address_bounded CHECK (length(to_address) BETWEEN 20 AND 120),
  CONSTRAINT scheduled_payments_memo_bounded CHECK (memo IS NULL OR length(memo) <= 120),
  CONSTRAINT scheduled_payments_error_bounded CHECK (
    last_error_code IS NULL OR length(last_error_code) <= 64
  ),
  CONSTRAINT scheduled_payments_completed_link CHECK (
    status <> 'completed' OR executed_transaction_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS scheduled_payments_idempotency_idx
  ON scheduled_payments (user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS scheduled_payments_user_idx
  ON scheduled_payments (user_id, scheduled_at DESC) WHERE deleted_at IS NULL;
-- The scheduler's hot path.
CREATE INDEX IF NOT EXISTS scheduled_payments_due_idx
  ON scheduled_payments (scheduled_at)
  WHERE status = 'scheduled' AND deleted_at IS NULL;

-- -----------------------------------------------------------------------------
--  Send requests — the two-phase quote/confirm record for outgoing transfers.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS send_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  wallet_id             uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
  asset_id              uuid NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
  to_address            text NOT NULL,
  to_address_canonical  text NOT NULL,
  raw_amount            base_units NOT NULL,
  memo                  text,
  status                send_request_status_t NOT NULL DEFAULT 'quoted',
  -- Digest over every field the user was shown. Confirmation must echo it back, so a
  -- quote cannot be swapped between being displayed and being approved.
  quote_fingerprint     text NOT NULL,
  fee_asset_id          uuid REFERENCES assets (id) ON DELETE RESTRICT,
  fee_raw_amount        base_units,
  value_usd_minor       bigint,
  expires_at            timestamptz NOT NULL,
  confirmed_at          timestamptz,
  broadcast_at          timestamptz,
  completed_at          timestamptz,
  tx_hash               text,
  transaction_id        uuid REFERENCES transactions (id) ON DELETE SET NULL,
  scheduled_payment_id  uuid REFERENCES scheduled_payments (id) ON DELETE SET NULL,
  simulated             boolean NOT NULL DEFAULT true,
  error_code            text,
  idempotency_key       text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT send_requests_amount_positive CHECK (raw_amount > 0),
  CONSTRAINT send_requests_error_bounded CHECK (error_code IS NULL OR length(error_code) <= 64),
  CONSTRAINT send_requests_broadcast_hash CHECK (
    status NOT IN ('broadcast', 'completed') OR tx_hash IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS send_requests_idempotency_idx
  ON send_requests (user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS send_requests_user_idx ON send_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS send_requests_open_idx
  ON send_requests (expires_at) WHERE status = 'quoted';
-- Daily-limit accounting reads this.
CREATE INDEX IF NOT EXISTS send_requests_spend_window_idx
  ON send_requests (user_id, confirmed_at)
  WHERE status IN ('confirmed', 'signing', 'broadcast', 'completed');

-- Late-bound FKs (transactions references send_requests and vice versa).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_send_request_fk'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_send_request_fk
      FOREIGN KEY (send_request_id) REFERENCES send_requests (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_scheduled_payment_fk'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_scheduled_payment_fk
      FOREIGN KEY (scheduled_payment_id) REFERENCES scheduled_payments (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_payments_send_request_fk'
  ) THEN
    ALTER TABLE scheduled_payments
      ADD CONSTRAINT scheduled_payments_send_request_fk
      FOREIGN KEY (send_request_id) REFERENCES send_requests (id) ON DELETE SET NULL;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
--  Financial goals
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS financial_goals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name            text NOT NULL,
  target_minor    bigint NOT NULL,
  current_minor   bigint NOT NULL DEFAULT 0,
  currency        fiat_code NOT NULL,
  deadline        date,
  status          goal_status_t NOT NULL DEFAULT 'active',
  icon            text,
  color           text,
  notes           text,
  achieved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT financial_goals_target_positive CHECK (target_minor > 0),
  CONSTRAINT financial_goals_current_non_negative CHECK (current_minor >= 0),
  CONSTRAINT financial_goals_name_bounded CHECK (length(name) BETWEEN 1 AND 60),
  CONSTRAINT financial_goals_color_hex CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$')
);

CREATE INDEX IF NOT EXISTS financial_goals_user_idx
  ON financial_goals (user_id, status) WHERE deleted_at IS NULL;

SELECT app.attach_touch_trigger('transactions');
SELECT app.attach_touch_trigger('expected_income');
SELECT app.attach_touch_trigger('scheduled_payments');
SELECT app.attach_touch_trigger('send_requests');
SELECT app.attach_touch_trigger('financial_goals');
