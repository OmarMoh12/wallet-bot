-- =============================================================================
--  0009_system_plane
--
--  Grants unbound ("system") transactions access to user-scoped tables.
--
--  WHY THIS IS NEEDED
--  ------------------
--  Two code paths legitimately act without a user identity:
--
--    1. **Authentication bootstrap.** A user row must be created before any user id
--       exists to bind to. Note also that `INSERT ... RETURNING` requires the *SELECT*
--       policy to admit the new row — so without this, the very first login of every
--       user failed with "new row violates row-level security policy".
--
--    2. **The worker plane.** Chain scanning, confirmation tracking, scheduled-payment
--       execution, reminders and notification dispatch all operate across users on behalf
--       of the platform, not on behalf of a session.
--
--  WHY THIS IS STILL SAFE
--  ----------------------
--  An unbound transaction is not something a request can produce. Every API route resolves
--  a bearer token to an actor and calls `withUser(...)`, which binds `app.user_id` for the
--  transaction; there is no code path from an HTTP request to `withSystem(...)` on
--  user-scoped data. RLS's job in this system is to constrain the *request plane*, which is
--  where IDOR risk actually lives — and there it remains fully in force, as
--  `tests/integration/rls.test.ts` demonstrates.
--
--  The alternative — a second database role with BYPASSRLS for workers — moves the same
--  trust boundary into role configuration, where it is harder to see and easier to grant by
--  accident. Keeping it as an explicit, named policy makes the boundary reviewable.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.is_system()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app.current_user_id() IS NULL;
$$;

COMMENT ON FUNCTION app.is_system() IS
  'True in an unbound transaction. Unbound transactions are only ever created by trusted server processes (auth bootstrap and background workers), never by a request handler.';

CREATE OR REPLACE FUNCTION app.create_system_policy(target text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  policy_name text := target || '_system';
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, target);
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR ALL USING (app.is_system()) WITH CHECK (app.is_system())',
    policy_name, target
  );
END;
$$;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'users',
    'user_settings',
    'notification_preferences',
    'sessions',
    'cash_accounts',
    'categories',
    'wallets',
    'wallet_balances',
    'blockchain_scans',
    'transactions',
    'expected_income',
    'scheduled_payments',
    'send_requests',
    'financial_goals',
    'notifications'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    PERFORM app.create_system_policy(t);
  END LOOP;
END
$$;

-- Audit logs stay append-only even for the system: the INSERT policy is widened, but no
-- UPDATE or DELETE policy is added, and the app role has no grant for either.
DROP POLICY IF EXISTS audit_logs_write ON audit_logs;
CREATE POLICY audit_logs_write ON audit_logs
  FOR INSERT WITH CHECK (
    app.is_system() OR user_id IS NULL OR user_id = app.current_user_id() OR app.is_admin()
  );
