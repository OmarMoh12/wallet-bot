-- =============================================================================
--  0002_identity
--  Users, settings, sessions, notification preferences, cash accounts, categories.
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Telegram ids exceed int4 and are documented as fitting in 52 bits.
  telegram_id     bigint NOT NULL UNIQUE,
  username        citext,
  first_name      text NOT NULL DEFAULT '',
  last_name       text,
  photo_url       text,
  language_code   text,
  is_admin        boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  last_seen_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT users_telegram_id_positive CHECK (telegram_id > 0),
  CONSTRAINT users_names_bounded CHECK (
    length(first_name) <= 128 AND (last_name IS NULL OR length(last_name) <= 128)
  )
);

CREATE INDEX IF NOT EXISTS users_active_idx ON users (is_active) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS user_settings (
  user_id            uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  locale             text NOT NULL DEFAULT 'en',
  theme_preference   theme_preference_t NOT NULL DEFAULT 'system',
  -- Cash is held mainly in ILS; crypto is reported mainly in USD. Both are configurable.
  primary_fiat       fiat_code NOT NULL DEFAULT 'ILS',
  reporting_fiat     fiat_code NOT NULL DEFAULT 'USD',
  fx_mode            fx_mode_t NOT NULL DEFAULT 'auto',
  manual_usd_ils     rate_value,
  timezone           text NOT NULL DEFAULT 'UTC',
  hide_balances      boolean NOT NULL DEFAULT false,
  -- scrypt(pin, salt, pepper). The pepper lives in the environment, never in the database,
  -- so a database-only compromise does not permit offline PIN cracking.
  pin_hash           text,
  pin_salt           text,
  pin_set_at         timestamptz,
  pin_failed_count   smallint NOT NULL DEFAULT 0,
  pin_locked_until   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_settings_locale_supported CHECK (locale IN ('en', 'ar')),
  CONSTRAINT user_settings_timezone_bounded CHECK (length(timezone) BETWEEN 1 AND 64),
  CONSTRAINT user_settings_manual_rate_required CHECK (
    fx_mode <> 'manual' OR manual_usd_ils IS NOT NULL
  ),
  CONSTRAINT user_settings_pin_pair CHECK (
    (pin_hash IS NULL AND pin_salt IS NULL) OR (pin_hash IS NOT NULL AND pin_salt IS NOT NULL)
  ),
  CONSTRAINT user_settings_pin_failed_bounded CHECK (pin_failed_count BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id                     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- Per-type on/off switches, keyed by notification_type. Defaults are "everything that
  -- concerns money is on; everything advisory is on but throttled".
  enabled_types               jsonb NOT NULL DEFAULT '{}'::jsonb,
  quiet_hours_start           time,
  quiet_hours_end             time,
  -- Suppress dust notifications below this USD value.
  min_crypto_value_usd_minor  bigint NOT NULL DEFAULT 0,
  -- Notify when USD/ILS moves by at least this many basis points since the last alert.
  fx_alert_threshold_bps      integer NOT NULL DEFAULT 200,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_prefs_types_object CHECK (jsonb_typeof(enabled_types) = 'object'),
  CONSTRAINT notification_prefs_min_value CHECK (min_crypto_value_usd_minor >= 0),
  CONSTRAINT notification_prefs_fx_threshold CHECK (fx_alert_threshold_bps BETWEEN 0 AND 10000)
);

-- -----------------------------------------------------------------------------
--  Sessions
--
--  Only a hash of the token is stored, so a database dump does not yield usable session
--  credentials. Rows exist for revocation and audit, not for lookup-by-token-value.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  ip_hash       text,
  user_agent    text,
  CONSTRAINT sessions_expiry_future CHECK (expires_at > issued_at),
  CONSTRAINT sessions_ua_bounded CHECK (user_agent IS NULL OR length(user_agent) <= 512)
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
--  Cash accounts — the "money I physically own" side of the ledger.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cash_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name           text NOT NULL,
  currency       fiat_code NOT NULL,
  -- Cached running balance in minor units. Maintained by a trigger from the ledger so it
  -- can never drift from the transactions that produced it.
  balance_minor  bigint NOT NULL DEFAULT 0,
  is_default     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT cash_accounts_name_bounded CHECK (length(name) BETWEEN 1 AND 60)
);

CREATE INDEX IF NOT EXISTS cash_accounts_user_idx
  ON cash_accounts (user_id) WHERE deleted_at IS NULL;
-- At most one default account per user.
CREATE UNIQUE INDEX IF NOT EXISTS cash_accounts_one_default_idx
  ON cash_accounts (user_id) WHERE is_default AND deleted_at IS NULL;

-- -----------------------------------------------------------------------------
--  Categories — system categories have user_id NULL and are visible to everyone.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  -- Localisation key for built-ins ("category.food"); NULL for user-created ones.
  key         text,
  name        text,
  kind        category_kind_t NOT NULL DEFAULT 'both',
  icon        text,
  color       text,
  is_system   boolean NOT NULL DEFAULT false,
  sort_order  smallint NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT categories_system_shape CHECK (
    (is_system AND user_id IS NULL AND key IS NOT NULL)
    OR (NOT is_system AND user_id IS NOT NULL AND name IS NOT NULL)
  ),
  CONSTRAINT categories_name_bounded CHECK (name IS NULL OR length(name) BETWEEN 1 AND 60),
  CONSTRAINT categories_color_hex CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT categories_icon_key CHECK (icon IS NULL OR icon ~ '^[a-z0-9-]{1,32}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS categories_system_key_idx
  ON categories (key) WHERE is_system;
CREATE UNIQUE INDEX IF NOT EXISTS categories_user_name_idx
  ON categories (user_id, lower(name)) WHERE user_id IS NOT NULL AND deleted_at IS NULL;

SELECT app.attach_touch_trigger('users');
SELECT app.attach_touch_trigger('user_settings');
SELECT app.attach_touch_trigger('notification_preferences');
SELECT app.attach_touch_trigger('cash_accounts');
SELECT app.attach_touch_trigger('categories');
