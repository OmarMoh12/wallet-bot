# Testing

```bash
pnpm test                # everything
pnpm run test:watch
pnpm run test:coverage
```

**193 tests: 131 unit, 62 integration.**

---

## The two tiers

**Unit tests** run anywhere with no external dependency — money arithmetic, initData
verification, address validation, state machines, the currency service, redaction, and the
signer's request authentication and spend policy.

**Integration tests** need a real PostgreSQL. They exercise RLS, unique-index idempotency,
trigger-maintained balances and `FOR UPDATE SKIP LOCKED` — none of which can be verified
against a mock without testing the mock instead of the system. If `TEST_DATABASE_URL` is
unreachable they **skip with a message** rather than failing, so a fresh clone still gets a
green unit run.

### Running integration tests

```bash
docker compose up -d db
createdb wallet_test   # or: psql -c 'CREATE DATABASE wallet_test'

# Integration tests must connect as a NON-superuser, or RLS is silently bypassed and
# the security tests pass without proving anything.
psql -U postgres -c "CREATE ROLE app_user LOGIN PASSWORD 'app_user_pw'"

TEST_DATABASE_URL=postgresql://app_user:app_user_pw@127.0.0.1:5432/wallet_test \
TEST_DATABASE_MIGRATION_URL=postgresql://postgres:postgres@127.0.0.1:5432/wallet_test \
pnpm test
```

Migrations are applied automatically on first contact. Each suite creates its own user, so
suites cannot see each other's rows and no cleanup is needed.

---

## What is covered

| Area               | File                                     | Notable cases                                                                                                                                                       |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money              | `unit/money.test.ts`                     | half-even vs half-up, negative rounding, `mulDiv` precision at 10^30, allocation losing no cent, rejecting excess precision, `0.1 + 0.2`                            |
| Auth               | `unit/initdata.test.ts`                  | tampered field, wrong bot token, unsigned, stale, future-dated, oversized, bot account, the newer `signature` field                                                 |
| Addresses          | `unit/address.test.ts`                   | single mistyped character, cross-network rejection, TON bounceable/non-bounceable equivalence, CRC16 vector, explorer URL encoding                                  |
| Currency           | `unit/currency.test.ts`                  | sanity-band rejection, provider failover, stale-but-usable vs too-stale, manual rate, request coalescing, unpriced assets absent rather than zero                   |
| State machines     | `unit/state-machines.test.ts`            | no un-confirming, no broadcast without signing, no cancel after signing                                                                                             |
| Security           | `unit/security.test.ts`                  | bot-token and Postgres-URL redaction, prototype pollution, PIN pepper, signer HMAC replay/tamper/path-swap, spend caps                                              |
| i18n               | `unit/i18n.test.ts`                      | **no missing keys in any locale**, every error code translated, placeholder consistency, Arabic dual/few plurals                                                    |
| RLS                | `integration/rls.test.ts`                | IDOR by exact id, `SELECT` with no filter, cross-user update/delete, row reassignment, identity not leaking across pooled transactions                              |
| Idempotency        | `integration/idempotency.test.ts`        | replayed chain event, 8 concurrent ingestions of one event, distinct log indices, repeated client key, job/notification dedupe                                      |
| Ledger             | `integration/ledger.test.ts`             | trigger balance through insert/status-change/soft-delete/concurrency, cache equals recomputation, DB-level state machine and CHECK enforcement                      |
| Chain sync         | `integration/chain-sync.test.ts`         | the full **detected → stored → balance → notification** pipeline, replay safety, unregistered token ignored, reverted tx ignored, confirmation walk, reconciliation |
| Scheduled payments | `integration/scheduled-payments.test.ts` | **fails closed with `SENDING_DISABLED`**, nothing broadcast, user notified, no double-claim across workers, kill switch                                             |
| Rate limiting      | `integration/rate-limit.test.ts`         | limit enforcement, bucket/subject isolation, **shared budget across instances**, atomic counting under concurrency                                                  |

---

## The two required end-to-end workflows

Both are asserted directly, against a real database:

**Incoming crypto** (`chain-sync.test.ts`) — a transfer is seeded into the mock provider, then
`ChainSyncService.scanWallet` is run for real. The test asserts the ledger row exists exactly
once with the right direction, source and amount; the cached balance moved by exactly that
amount; exactly one notification was queued with the right payload; a replay changes nothing;
and the confirmation walker moves it to `confirmed` and queues the follow-up.

**Scheduled payment** (`scheduled-payments.test.ts`) — a due payment is claimed and validated,
then refused with `SENDING_DISABLED`. The test asserts no `send_requests` row reached
`broadcast`, no outgoing crypto transaction exists, the failure reason is recorded as a code,
the user was notified, and two concurrent workers claim it exactly once.

---

## Tests that found real bugs

Worth recording, because they justify the tier split:

1. **RLS blocked every signup.** `INSERT ... RETURNING` requires the SELECT policy to admit
   the new row; in an unbound bootstrap transaction it did not. The entire worker plane was
   affected too. Fixed by migration `0009`.
2. **Rate limiting was silently off.** A PL/pgSQL variable shadowed a column name inside
   `ON CONFLICT`, so every call raised — and the defensive `catch` hid it, degrading to
   per-instance counting. Fixed by migration `0010`; the failure now logs at error level.
3. **Log redaction missed bot tokens in URLs.** The `\b` anchor did not match
   `.../bot123456789:AAH...`, and a 64-char transaction hash was being redacted as if it were
   a key. Both fixed.

None of these are visible without executing the real code paths.

---

## Writing new tests

- Money assertions compare **exact strings or BigInts**, never floats.
- Integration tests get their own user via `createTestUser` — never a shared fixture.
- Anything asserting a security property must connect as `app_user`, not `postgres`.
- Idempotency tests use `Promise.all` to create genuine concurrency; a sequential loop proves
  nothing about a race.
