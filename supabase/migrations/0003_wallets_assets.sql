-- =============================================================================
--  0003_wallets_assets
--  Chain assets, wallets (public addresses only), and cached balances.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  Assets: the canonical registry of what can be held. Shared across all users, seeded
--  in 0007 and extensible at runtime by an admin.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network           network_t NOT NULL,
  env               network_env_t NOT NULL,
  kind              asset_kind_t NOT NULL,
  symbol            text NOT NULL,
  name              text NOT NULL,
  decimals          smallint NOT NULL,
  -- NULL for native coins (TRX, TON); contract/jetton-master address for tokens.
  contract_address  text,
  -- Identifier used by the price provider, e.g. "tether", "the-open-network", "tron".
  price_id          text,
  icon_key          text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_decimals_range CHECK (decimals BETWEEN 0 AND 36),
  CONSTRAINT assets_symbol_shape CHECK (symbol ~ '^[A-Za-z0-9._-]{1,16}$'),
  CONSTRAINT assets_contract_shape CHECK (
    (kind = 'native' AND contract_address IS NULL)
    OR (kind = 'token' AND contract_address IS NOT NULL AND length(contract_address) BETWEEN 20 AND 120)
  )
);

-- One row per (network, env, contract). COALESCE keeps native coins unique too.
CREATE UNIQUE INDEX IF NOT EXISTS assets_identity_idx
  ON assets (network, env, COALESCE(contract_address, 'native:' || symbol));

-- -----------------------------------------------------------------------------
--  Wallets.
--
--  This table stores PUBLIC ADDRESSES ONLY. There is deliberately no column for a private
--  key, seed phrase, or encrypted key material — key handling lives entirely in the
--  isolated signer service (apps/signer), which has its own storage and its own secret.
--  `type = 'managed'` merely records that a signer knows about this address.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name               text NOT NULL,
  network            network_t NOT NULL,
  env                network_env_t NOT NULL,
  address            text NOT NULL,
  -- Canonical form used for uniqueness and for matching chain events. Chain-specific;
  -- see packages/blockchain address modules. NOT lower-cased — TRON base58 and TON
  -- base64url addresses are case-sensitive.
  address_canonical  text NOT NULL,
  type               wallet_type_t NOT NULL DEFAULT 'watch_only',
  is_active          boolean NOT NULL DEFAULT true,
  -- Opaque, provider-specific resume point for incremental scanning.
  scan_cursor        jsonb,
  last_scanned_at    timestamptz,
  last_scan_error    text,
  consecutive_failures smallint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT wallets_name_bounded CHECK (length(name) BETWEEN 1 AND 60),
  CONSTRAINT wallets_address_bounded CHECK (length(address) BETWEEN 20 AND 120),
  CONSTRAINT wallets_scan_cursor_object CHECK (
    scan_cursor IS NULL OR jsonb_typeof(scan_cursor) = 'object'
  ),
  CONSTRAINT wallets_failures_bounded CHECK (consecutive_failures BETWEEN 0 AND 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_address_idx
  ON wallets (user_id, network, env, address_canonical) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS wallets_user_idx ON wallets (user_id) WHERE deleted_at IS NULL;
-- Drives the scan scheduler: "which active wallets are due a check?"
CREATE INDEX IF NOT EXISTS wallets_scan_due_idx
  ON wallets (last_scanned_at NULLS FIRST)
  WHERE is_active AND deleted_at IS NULL;
-- Used by the chain-event router to find the owning wallet for an address.
CREATE INDEX IF NOT EXISTS wallets_canonical_lookup_idx
  ON wallets (network, env, address_canonical) WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
--  Cached balances, refreshed by the reconcile job. The ledger remains the source of
--  truth for history; this table is the source of truth for "what do I hold right now",
--  because a wallet may have activity that predates the user adding it here.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet_balances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id   uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  asset_id    uuid NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
  raw_amount  base_units NOT NULL DEFAULT 0,
  -- Where the number came from, for debugging drift between indexers.
  source      text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_balances_non_negative CHECK (raw_amount >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_balances_identity_idx
  ON wallet_balances (wallet_id, asset_id);
CREATE INDEX IF NOT EXISTS wallet_balances_asset_idx ON wallet_balances (asset_id);

-- -----------------------------------------------------------------------------
--  Scan history — one row per scan attempt. Used for the health endpoint, the admin
--  "sync inspector", and for diagnosing a provider that silently stops returning data.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blockchain_scans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id     uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  provider      text NOT NULL,
  status        scan_status_t NOT NULL DEFAULT 'running',
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  transfers_seen integer NOT NULL DEFAULT 0,
  transfers_new  integer NOT NULL DEFAULT 0,
  cursor_before jsonb,
  cursor_after  jsonb,
  error         text,
  CONSTRAINT blockchain_scans_counts CHECK (transfers_seen >= 0 AND transfers_new >= 0),
  CONSTRAINT blockchain_scans_error_bounded CHECK (error IS NULL OR length(error) <= 1000)
);

CREATE INDEX IF NOT EXISTS blockchain_scans_wallet_idx
  ON blockchain_scans (wallet_id, started_at DESC);

SELECT app.attach_touch_trigger('assets');
SELECT app.attach_touch_trigger('wallets');
