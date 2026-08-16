# Database

PostgreSQL, managed by Supabase in production. Migrations live in `supabase/migrations/` and
are applied by `packages/db`'s runner, not by an ORM.

---

## Conventions

| Concern        | Rule                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Primary keys   | `uuid` with `gen_random_uuid()`                                                                               |
| Timestamps     | `timestamptz`, always. `created_at` / `updated_at` on every mutable table, `updated_at` maintained by trigger |
| Deletion       | Soft, via `deleted_at`. Financial history is not destroyed                                                    |
| Fiat money     | `BIGINT` **minor units** (cents/agorot). Never `numeric`, never float                                         |
| Crypto money   | `NUMERIC(78,0)` base units via the `base_units` domain, which asserts scale 0                                 |
| Rates          | `NUMERIC(30,12)` via the `rate_value` domain, which asserts positivity                                        |
| Enums          | Native PostgreSQL enums, mirroring `packages/shared/src/domain/enums.ts` one-for-one                          |
| State machines | Enforced by trigger **and** in TypeScript. Either alone is a single point of failure                          |

---

## Migrations

| File                            | Contents                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `0001_foundation`               | Extensions, `app` schema, enum types, domains, session helpers, `updated_at` trigger                                           |
| `0002_identity`                 | `users`, `user_settings`, `notification_preferences`, `sessions`, `cash_accounts`, `categories`                                |
| `0003_wallets_assets`           | `assets`, `wallets`, `wallet_balances`, `blockchain_scans`                                                                     |
| `0004_ledger`                   | `transactions`, `expected_income`, `scheduled_payments`, `send_requests`, `financial_goals`                                    |
| `0005_operations`               | `notifications`, `jobs`, `processed_events`, `audit_logs`, `exchange_rates`, `asset_prices`, `api_rate_limits`, `app_settings` |
| `0006_functions`                | State-machine triggers, cash-balance maintenance, job queue, rate limiter, replay gate, cleanup                                |
| `0007_rls`                      | `app_user` role, grants, RLS enabled + forced, owner/admin policies                                                            |
| `0008_reference_data`           | Asset registry, built-in categories, default app settings                                                                      |
| `0009_system_plane`             | Policies for unbound (worker/bootstrap) transactions — see below                                                               |
| `0010_fix_rate_limit_ambiguity` | Fixes a PL/pgSQL variable shadowing a column, which had silently disabled shared rate limiting                                 |

Migrations are **immutable**: the runner records a checksum and refuses to proceed if an
applied file has changed. An advisory lock serialises concurrent deployers.

---

## The unified ledger

`transactions` holds both cash and crypto, discriminated by `kind`, rather than two parallel
tables.

**Why.** History, search, filters and analytics are single-table queries instead of `UNION`s,
and the two halves cannot drift apart. The cost is nullable columns, which is paid for with
`CHECK` constraints that make each variant's columns mandatory-together:

```sql
CONSTRAINT transactions_cash_shape CHECK (
  kind <> 'cash' OR (
    fiat_currency IS NOT NULL AND fiat_amount_minor IS NOT NULL
    AND wallet_id IS NULL AND asset_id IS NULL AND raw_amount IS NULL AND tx_hash IS NULL
  )
)
```

Plus sign/direction agreement, so a `direction='in'` row can never carry a negative amount:

```sql
CONSTRAINT transactions_cash_sign CHECK (
  kind <> 'cash' OR type = 'adjustment'
  OR (direction = 'in'  AND fiat_amount_minor > 0)
  OR (direction = 'out' AND fiat_amount_minor < 0)
  OR (direction = 'internal')
)
```

### Valuation snapshots

`value_usd_minor`, `value_ils_minor`, `usd_ils_rate` and `unit_price_usd` are written when the
row is created. A report for last month does not change because the shekel moved this
morning. Rows that could not be valued carry `NULL` — never zero — and aggregates count them
so the UI can report the total as partial rather than under-stating it.

---

## Derived balances

`cash_accounts.balance_minor` is maintained by an `AFTER INSERT/UPDATE/DELETE` trigger on
`transactions`, not by application code. Only `confirmed`, non-deleted, cash rows count. The
invariant — cache equals the sum of the rows that justify it — is asserted directly by
`tests/integration/ledger.test.ts`, including through status changes, soft deletes and
concurrent inserts.

`app.recompute_cash_balance(account_id)` recomputes from scratch and is the repair tool.

---

## Idempotency indexes

```sql
-- One ledger row per on-chain movement, whatever the indexer does.
CREATE UNIQUE INDEX transactions_chain_identity_idx
  ON transactions (network, env, tx_hash, log_index) WHERE tx_hash IS NOT NULL;

-- One row per client request, however many times it is retried.
CREATE UNIQUE INDEX transactions_idempotency_idx
  ON transactions (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- One notification per logical event.
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications (user_id, dedupe_key);

-- One pending job per equivalent unit of work.
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
```

`log_index` is what stops a batched payout collapsing into a single row and understating a
balance.

---

## Row Level Security

Enabled **and forced** on every table. Two policy families:

- **Owner** — `user_id = app.current_user_id()`, with `WITH CHECK` on updates so a row cannot
  be reassigned to another user.
- **System** — `app.is_system()`, true only in an unbound transaction. Used by the auth
  bootstrap and the worker. See `docs/security.md` §3 for why that boundary is safe.

Admin policies are SELECT-only. `audit_logs` has no UPDATE or DELETE policy and the app role
has no grant for either, so the trail is append-only.

---

## The job queue

`jobs`, drained with `FOR UPDATE SKIP LOCKED` under a lease:

```sql
SELECT * FROM app.claim_jobs('worker-1', 4, 90, 'default');
```

PostgreSQL rather than Redis so a handler can insert a transaction, update a balance, queue a
notification and complete its own job **in one commit**. With an external broker those can
disagree after a crash, which is precisely how duplicate or missing money records happen.

Expired leases are reclaimed by `app.reclaim_stuck_jobs()`; jobs past `max_attempts` become
`dead` and surface in the admin panel rather than retrying forever.

---

## Indexes worth knowing

| Index                            | Serves                                                       |
| -------------------------------- | ------------------------------------------------------------ |
| `transactions_user_time_idx`     | The history feed, keyset-paginated on `(occurred_at, id)`    |
| `transactions_in_flight_idx`     | The confirmation walker                                      |
| `transactions_search_idx` (GIN)  | Full-text search over title, description, hash, counterparty |
| `wallets_scan_due_idx`           | "Which wallets need checking?"                               |
| `scheduled_payments_due_idx`     | The scheduler's hot path                                     |
| `jobs_claim_idx`                 | Queue dequeue                                                |
| `send_requests_spend_window_idx` | Daily spend-cap accounting                                   |
