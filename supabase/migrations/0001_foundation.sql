-- =============================================================================
--  0001_foundation
--  Extensions, schemas, enum types, and the shared trigger helpers.
--  Every later migration assumes this one has run.
-- =============================================================================

-- pgcrypto gives us gen_random_uuid() and digest(). Available on Supabase by default.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- citext is used for case-insensitive lookups that are genuinely case-insensitive
-- (usernames). Addresses deliberately stay case-SENSITIVE — see docs/security.md.
CREATE EXTENSION IF NOT EXISTS citext;

-- Private schema for helper functions used by RLS policies and triggers. Keeping them out
-- of `public` means they are not exposed through PostgREST.
CREATE SCHEMA IF NOT EXISTS app;

-- -----------------------------------------------------------------------------
--  Enum types. These mirror packages/shared/src/domain/enums.ts one-for-one.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'network_t') THEN
    CREATE TYPE network_t AS ENUM ('tron', 'ton');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'network_env_t') THEN
    CREATE TYPE network_env_t AS ENUM ('mainnet', 'testnet');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_type_t') THEN
    CREATE TYPE wallet_type_t AS ENUM ('watch_only', 'managed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'asset_kind_t') THEN
    CREATE TYPE asset_kind_t AS ENUM ('native', 'token');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tx_kind_t') THEN
    CREATE TYPE tx_kind_t AS ENUM ('cash', 'crypto');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tx_type_t') THEN
    CREATE TYPE tx_type_t AS ENUM ('income', 'expense', 'transfer', 'adjustment');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tx_direction_t') THEN
    CREATE TYPE tx_direction_t AS ENUM ('in', 'out', 'internal');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tx_status_t') THEN
    CREATE TYPE tx_status_t AS ENUM
      ('pending', 'detected', 'confirming', 'confirmed', 'failed', 'cancelled', 'reversed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tx_source_t') THEN
    CREATE TYPE tx_source_t AS ENUM ('manual', 'chain', 'scheduled', 'system');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'scheduled_status_t') THEN
    CREATE TYPE scheduled_status_t AS ENUM
      ('scheduled', 'processing', 'completed', 'failed', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'expected_income_status_t') THEN
    CREATE TYPE expected_income_status_t AS ENUM ('pending', 'received', 'delayed', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'send_request_status_t') THEN
    CREATE TYPE send_request_status_t AS ENUM
      ('quoted', 'confirmed', 'signing', 'broadcast', 'completed', 'failed', 'cancelled', 'expired');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'goal_status_t') THEN
    CREATE TYPE goal_status_t AS ENUM ('active', 'achieved', 'archived');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'category_kind_t') THEN
    CREATE TYPE category_kind_t AS ENUM ('income', 'expense', 'both');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'theme_preference_t') THEN
    CREATE TYPE theme_preference_t AS ENUM ('system', 'dark', 'light');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fx_mode_t') THEN
    CREATE TYPE fx_mode_t AS ENUM ('auto', 'manual');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_status_t') THEN
    CREATE TYPE notification_status_t AS ENUM ('queued', 'sent', 'failed', 'suppressed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status_t') THEN
    CREATE TYPE job_status_t AS ENUM ('queued', 'running', 'succeeded', 'failed', 'dead');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'actor_type_t') THEN
    CREATE TYPE actor_type_t AS ENUM ('user', 'admin', 'system');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'scan_status_t') THEN
    CREATE TYPE scan_status_t AS ENUM ('running', 'ok', 'failed');
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
--  Session context helpers.
--
--  The application connects as a NON-superuser role that is subject to RLS, and binds the
--  acting user for the duration of each transaction with
--      SELECT set_config('app.user_id', $1, true);
--  `true` makes it transaction-local, so a pooled connection can never leak identity from
--  one request into the next.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_admin', true), ''), 'false')::boolean;
$$;

COMMENT ON FUNCTION app.current_user_id() IS
  'UUID of the user this transaction is acting as. NULL when unbound, which makes every RLS policy fail closed.';

-- -----------------------------------------------------------------------------
--  updated_at maintenance
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Convenience: attach the updated_at trigger to a table.
CREATE OR REPLACE FUNCTION app.attach_touch_trigger(target regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  trigger_name text := 'trg_touch_updated_at';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = target AND tgname = trigger_name
  ) THEN
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
      trigger_name, target::text
    );
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
--  Guard: reject non-integer values in crypto base-unit columns.
--  NUMERIC(78,0) already forbids a fractional scale, but an explicit domain makes the
--  intent unmistakable at every call site.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'base_units') THEN
    CREATE DOMAIN base_units AS numeric(78, 0)
      CHECK (VALUE IS NULL OR scale(VALUE) = 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fiat_code') THEN
    CREATE DOMAIN fiat_code AS char(3)
      CHECK (VALUE IN ('USD', 'ILS'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rate_value') THEN
    CREATE DOMAIN rate_value AS numeric(30, 12)
      CHECK (VALUE > 0);
  END IF;
END
$$;
