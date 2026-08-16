-- =============================================================================
--  0007_rls
--  Row Level Security.
--
--  The application does NOT connect as a superuser. It connects as `app_user`, a role
--  without BYPASSRLS, and binds the acting user per transaction:
--
--      SELECT set_config('app.user_id', $1, true);
--
--  Consequently these policies constrain our own server code, not just hypothetical direct
--  database access. A missing WHERE clause in a repository returns zero rows instead of
--  another user's finances. `app.current_user_id()` is NULL when unbound, and every policy
--  compares against it, so an unbound transaction sees nothing — fail closed by default.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  Application role
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    -- NOLOGIN by default: grant a password out of band, or GRANT app_user TO <your role>.
    CREATE ROLE app_user NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT USAGE ON SCHEMA app TO app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO app_user;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- Audit logs are append-only for the application. Nothing it does can rewrite history.
REVOKE UPDATE, DELETE ON audit_logs FROM app_user;
-- Reference data is read-only at runtime; assets change via migrations or an admin path.
REVOKE INSERT, UPDATE, DELETE ON assets FROM app_user;

-- -----------------------------------------------------------------------------
--  Enable RLS everywhere. FORCE applies policies to the table owner too, so running a
--  query as the migration role does not silently bypass them.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'users', 'user_settings', 'notification_preferences', 'sessions', 'cash_accounts',
    'categories', 'wallets', 'wallet_balances', 'blockchain_scans', 'transactions',
    'expected_income', 'scheduled_payments', 'send_requests', 'financial_goals',
    'notifications', 'audit_logs', 'jobs', 'processed_events', 'exchange_rates',
    'asset_prices', 'api_rate_limits', 'app_settings', 'assets'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
--  Helper: standard "this row belongs to me" policy set.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.create_owner_policies(target text, owner_column text DEFAULT 'user_id')
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', target || '_owner_select', target);
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR SELECT USING (%I = app.current_user_id())',
    target || '_owner_select', target, owner_column);

  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', target || '_owner_insert', target);
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%I = app.current_user_id())',
    target || '_owner_insert', target, owner_column);

  -- Both USING and WITH CHECK: you may only modify your own rows, and you may not
  -- reassign a row to someone else in the process.
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', target || '_owner_update', target);
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR UPDATE USING (%I = app.current_user_id()) WITH CHECK (%I = app.current_user_id())',
    target || '_owner_update', target, owner_column, owner_column);

  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', target || '_owner_delete', target);
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR DELETE USING (%I = app.current_user_id())',
    target || '_owner_delete', target, owner_column);
END;
$$;

SELECT app.create_owner_policies('cash_accounts');
SELECT app.create_owner_policies('wallets');
SELECT app.create_owner_policies('transactions');
SELECT app.create_owner_policies('expected_income');
SELECT app.create_owner_policies('scheduled_payments');
SELECT app.create_owner_policies('send_requests');
SELECT app.create_owner_policies('financial_goals');
SELECT app.create_owner_policies('notifications');
SELECT app.create_owner_policies('sessions');

-- -----------------------------------------------------------------------------
--  users / settings — a user sees only themselves; admins may read all users.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS users_self_select ON users;
CREATE POLICY users_self_select ON users
  FOR SELECT USING (id = app.current_user_id() OR app.is_admin());

DROP POLICY IF EXISTS users_self_update ON users;
CREATE POLICY users_self_update ON users
  FOR UPDATE USING (id = app.current_user_id() OR app.is_admin())
  WITH CHECK (id = app.current_user_id() OR app.is_admin());

-- Account creation happens in an unbound transaction during Telegram authentication,
-- before a user id exists. It is gated by verified initData, not by RLS.
DROP POLICY IF EXISTS users_bootstrap_insert ON users;
CREATE POLICY users_bootstrap_insert ON users
  FOR INSERT WITH CHECK (app.current_user_id() IS NULL OR app.is_admin());

DROP POLICY IF EXISTS user_settings_self ON user_settings;
CREATE POLICY user_settings_self ON user_settings
  FOR ALL USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

DROP POLICY IF EXISTS user_settings_bootstrap ON user_settings;
CREATE POLICY user_settings_bootstrap ON user_settings
  FOR INSERT WITH CHECK (app.current_user_id() IS NULL OR user_id = app.current_user_id());

DROP POLICY IF EXISTS notification_prefs_self ON notification_preferences;
CREATE POLICY notification_prefs_self ON notification_preferences
  FOR ALL USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

DROP POLICY IF EXISTS notification_prefs_bootstrap ON notification_preferences;
CREATE POLICY notification_prefs_bootstrap ON notification_preferences
  FOR INSERT WITH CHECK (app.current_user_id() IS NULL OR user_id = app.current_user_id());

-- -----------------------------------------------------------------------------
--  categories — system categories are readable by everyone; custom ones are private.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS categories_read ON categories;
CREATE POLICY categories_read ON categories
  FOR SELECT USING (is_system OR user_id = app.current_user_id());

DROP POLICY IF EXISTS categories_write ON categories;
CREATE POLICY categories_write ON categories
  FOR INSERT WITH CHECK (user_id = app.current_user_id() AND NOT is_system);

DROP POLICY IF EXISTS categories_update ON categories;
CREATE POLICY categories_update ON categories
  FOR UPDATE USING (user_id = app.current_user_id() AND NOT is_system)
  WITH CHECK (user_id = app.current_user_id() AND NOT is_system);

DROP POLICY IF EXISTS categories_delete ON categories;
CREATE POLICY categories_delete ON categories
  FOR DELETE USING (user_id = app.current_user_id() AND NOT is_system);

-- -----------------------------------------------------------------------------
--  Child tables reached through a wallet — ownership is inherited via EXISTS.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS wallet_balances_owner ON wallet_balances;
CREATE POLICY wallet_balances_owner ON wallet_balances
  FOR ALL USING (
    EXISTS (SELECT 1 FROM wallets w WHERE w.id = wallet_balances.wallet_id
              AND w.user_id = app.current_user_id())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM wallets w WHERE w.id = wallet_balances.wallet_id
              AND w.user_id = app.current_user_id())
  );

DROP POLICY IF EXISTS blockchain_scans_owner ON blockchain_scans;
CREATE POLICY blockchain_scans_owner ON blockchain_scans
  FOR ALL USING (
    EXISTS (SELECT 1 FROM wallets w WHERE w.id = blockchain_scans.wallet_id
              AND w.user_id = app.current_user_id())
    OR app.is_admin()
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM wallets w WHERE w.id = blockchain_scans.wallet_id
              AND w.user_id = app.current_user_id())
    OR app.is_admin()
  );

-- -----------------------------------------------------------------------------
--  Audit logs — a user can read their own trail; only the system writes.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS audit_logs_read ON audit_logs;
CREATE POLICY audit_logs_read ON audit_logs
  FOR SELECT USING (user_id = app.current_user_id() OR app.is_admin());

-- Inserts are allowed for the acting user, for system actions (NULL user), and for admins.
DROP POLICY IF EXISTS audit_logs_write ON audit_logs;
CREATE POLICY audit_logs_write ON audit_logs
  FOR INSERT WITH CHECK (
    user_id IS NULL OR user_id = app.current_user_id() OR app.is_admin()
  );

-- -----------------------------------------------------------------------------
--  Reference and infrastructure tables.
--
--  Assets, rates and prices are non-sensitive shared reference data: readable by any bound
--  session, writable only by the worker (which runs unbound, i.e. as the system) or an admin.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS assets_read ON assets;
CREATE POLICY assets_read ON assets FOR SELECT USING (true);

DROP POLICY IF EXISTS exchange_rates_read ON exchange_rates;
CREATE POLICY exchange_rates_read ON exchange_rates FOR SELECT USING (true);
DROP POLICY IF EXISTS exchange_rates_write ON exchange_rates;
CREATE POLICY exchange_rates_write ON exchange_rates
  FOR INSERT WITH CHECK (app.current_user_id() IS NULL OR app.is_admin());

DROP POLICY IF EXISTS asset_prices_read ON asset_prices;
CREATE POLICY asset_prices_read ON asset_prices FOR SELECT USING (true);
DROP POLICY IF EXISTS asset_prices_write ON asset_prices;
CREATE POLICY asset_prices_write ON asset_prices
  FOR INSERT WITH CHECK (app.current_user_id() IS NULL OR app.is_admin());

-- Jobs, processed events and rate limits are system-plane tables. Only unbound (system)
-- transactions or admins may touch them; a user session sees nothing.
DROP POLICY IF EXISTS jobs_system ON jobs;
CREATE POLICY jobs_system ON jobs
  FOR ALL USING (app.current_user_id() IS NULL OR app.is_admin())
  WITH CHECK (app.current_user_id() IS NULL OR app.is_admin());

DROP POLICY IF EXISTS processed_events_system ON processed_events;
CREATE POLICY processed_events_system ON processed_events
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS api_rate_limits_system ON api_rate_limits;
CREATE POLICY api_rate_limits_system ON api_rate_limits
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS app_settings_read ON app_settings;
CREATE POLICY app_settings_read ON app_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS app_settings_write ON app_settings;
CREATE POLICY app_settings_write ON app_settings
  FOR ALL USING (app.is_admin() OR app.current_user_id() IS NULL)
  WITH CHECK (app.is_admin() OR app.current_user_id() IS NULL);

-- -----------------------------------------------------------------------------
--  Admin read-across policies. Deliberately SELECT-only: an admin can inspect, but
--  mutating another user's financial rows still requires an explicit, audited code path.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'wallets', 'transactions', 'expected_income', 'scheduled_payments',
    'send_requests', 'financial_goals', 'notifications', 'cash_accounts'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_admin_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (app.is_admin())',
      t || '_admin_select', t);
  END LOOP;
END
$$;
