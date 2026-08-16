# Architecture

> Personal financial-management system delivered as a Telegram Bot + Telegram Mini App.
> Single-owner (multi-user capable), watch-only-first crypto portfolio, manual cash ledger,
> scheduled payments, and Telegram-native notifications.

---

## 1. Design goals, in priority order

1. **Security.** This system knows how much money you have and where it lives. Everything else
   is negotiable; this is not.
2. **Financial correctness.** No floating point anywhere near money. Exact integer arithmetic
   end to end, rounding only at the presentation layer.
3. **Reliable blockchain monitoring.** At-least-once delivery from chain indexers, exactly-once
   effect in our ledger.
4. **Telegram integration.** The bot must work whether or not the Mini App is open.
5. **Excellent mobile UX.** It should feel like a native Telegram surface, not a web admin panel.
6. **Deployability.** Fresh clone → running system with documented steps.
7. **Maintainability.** Small, typed, testable modules. Few dependencies.

---

## 2. System topology

```
                         ┌──────────────────────────────┐
                         │        Telegram              │
                         │  (client + Bot API servers)  │
                         └───────┬──────────────┬───────┘
                    initData     │              │  updates / sendMessage
                    (signed)     │              │
                                 ▼              ▼
             ┌───────────────────────┐   ┌────────────────────────┐
   Vercel    │  apps/web             │   │  apps/bot     (Railway)│
             │  Next.js Mini App     │   │  grammY, webhook/poll  │
             │  + /api route handlers│   │  commands + notifier   │
             └───────────┬───────────┘   └────────────┬───────────┘
                         │                            │
                         │   both use the same domain services
                         │                            │
                         ▼                            ▼
             ┌────────────────────────────────────────────────────┐
             │  packages/core  — domain services (pure TypeScript) │
             │  ledger · wallets · fx · send · schedule · notify   │
             └───────────┬───────────────────────┬────────────────┘
                         │                       │
                         ▼                       ▼
        ┌────────────────────────┐   ┌──────────────────────────────┐
        │ Supabase PostgreSQL    │   │ packages/blockchain          │
        │  data + RLS + job queue│   │  TronProvider / TonProvider  │
        └───────────▲────────────┘   └──────────────┬───────────────┘
                    │                               │ HTTPS (allow-listed hosts)
                    │                               ▼
        ┌───────────┴────────────┐        TronGrid · TronScan
        │ apps/worker  (Railway) │        TonCenter · TonAPI
        │  chain scan · fx · jobs│        Frankfurter · ER-API
        │  reminders · scheduler │        CoinGecko · Binance
        └───────────┬────────────┘
                    │  HMAC-signed, private network only
                    ▼
        ┌────────────────────────────────────┐
        │ apps/signer  (Railway, private)    │
        │  isolated signing. DISABLED by     │
        │  default. Never reachable from web.│
        └────────────────────────────────────┘
```

Four deployables, one database, one shared domain layer. The web app and the bot never
duplicate business logic — they are both thin transports over `packages/core`.

---

## 3. Technology choices and why

| Concern               | Choice                                                                                                     | Why this and not the obvious alternative                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Language              | TypeScript 5.7, `strict`, `noUncheckedIndexedAccess`                                                       | Non-negotiable for a financial domain. `any` is an ESLint **error**.                                                                                                                                                                                                                                                                                                                                                                                               |
| Monorepo              | pnpm workspaces, no Turborepo                                                                              | pnpm already builds in topological order. Turborepo would add a build daemon and remote-cache config for a 10-package repo. Not worth it.                                                                                                                                                                                                                                                                                                                          |
| Module system         | ESM everywhere (`"type": "module"`, `NodeNext`)                                                            | Matches Node 22 and Next 15 natively; no interop shims.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Mini App / web        | Next.js 15 App Router, React 19                                                                            | Route Handlers give us one deployable for UI + API on Vercel, with Node-runtime crypto for initData verification.                                                                                                                                                                                                                                                                                                                                                  |
| Styling               | Tailwind CSS v4 (CSS-first config)                                                                         | v4 reads design tokens from CSS custom properties, which is exactly how Telegram delivers its theme (`--tg-theme-*`). The theme system becomes ~30 lines instead of a runtime JS theme provider.                                                                                                                                                                                                                                                                   |
| UI components         | Hand-rolled, shadcn-_style_                                                                                | shadcn/ui pulls in Radix primitives we would use ~4 of. Native `<dialog>`, CSS scroll-snap and `popover` cover the sheets/modals we need. Smaller bundle, full RTL control.                                                                                                                                                                                                                                                                                        |
| Telegram Mini App SDK | Thin typed wrapper over `window.Telegram.WebApp` (`packages/telegram` types + `apps/web/src/lib/telegram`) | `@telegram-apps/sdk-react` is good, but the official `telegram-web-app.js` must be loaded from telegram.org regardless. A ~200-line typed wrapper gives us exact control over theme events and viewport, with no extra dependency to track.                                                                                                                                                                                                                        |
| Charts                | Hand-rolled SVG                                                                                            | Recharts/visx are ~100 kB for four small mobile charts. Inline SVG is a few hundred bytes, accessible, and RTL-aware.                                                                                                                                                                                                                                                                                                                                              |
| Bot framework         | grammY                                                                                                     | Actively maintained, TS-first, first-class webhook + `Bot API` typing. Telegraf's typings are weaker.                                                                                                                                                                                                                                                                                                                                                              |
| Database              | Supabase PostgreSQL                                                                                        | Managed Postgres with RLS, migrations, and a free tier.                                                                                                                                                                                                                                                                                                                                                                                                            |
| DB driver             | `postgres` (porsager)                                                                                      | Tagged-template literals make SQL injection _structurally_ impossible — every interpolation becomes a bind parameter. No ORM means no hidden N+1 and no query-builder foot-guns on money columns.                                                                                                                                                                                                                                                                  |
| Job queue             | **PostgreSQL** (`FOR UPDATE SKIP LOCKED`), not Redis/BullMQ                                                | The decisive argument is transactional consistency: a chain-scan job can insert the transaction row, update the balance, enqueue the notification, and mark itself complete **in one commit**. With Redis the queue and the ledger can disagree after a crash, which is exactly the failure mode that produces duplicate or lost money records. It also removes an entire service from the deployment. `REDIS_URL` remains optional for distributed rate limiting. |
| Validation            | Zod                                                                                                        | One schema, reused for API validation, env parsing, and provider-response validation (untrusted chain data).                                                                                                                                                                                                                                                                                                                                                       |
| Money                 | Custom BigInt fixed-point (`packages/shared/money`)                                                        | `decimal.js`/`dinero.js` are fine, but our needs are narrow (integer minor units, token base units, scaled rates) and BigInt is exact and dependency-free. See §6.                                                                                                                                                                                                                                                                                                 |
| Auth                  | Telegram `initData` HMAC → short-lived server-issued session token, memory-only on the client              | See §5. Removes CSRF as a class of bug.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Logging               | `pino`                                                                                                     | Structured JSON, fast, with a redaction allow-list for secrets.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Tests                 | Vitest                                                                                                     | Native ESM + TS, fast, no Babel.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Hosting               | Vercel (web) · Railway (bot, worker, signer) · Supabase (db)                                               | As specified. Each has a health endpoint and a documented env matrix.                                                                                                                                                                                                                                                                                                                                                                                              |

### Dependency budget

Runtime dependencies across the whole repo: `next`, `react`, `react-dom`, `postgres`, `zod`,
`grammy`, `pino`, `qrcode`, `tailwindcss`. Everything else is devDependencies. This is deliberate —
each runtime dependency is an unaudited path into a process that can move money.

---

## 4. Package layout

```
packages/
  shared/      Money math, branded types, error codes, Zod schemas, i18n message
               catalogues, state machines. Depends on `zod` and nothing else.
  db/          postgres.js client, RLS session binding, migration runner,
               repositories (the only place SQL is written).
  blockchain/  BlockchainProvider interface + TronProvider, TonProvider,
               MockProvider. Address validation, explorer URL registry.
  currency/    FX (USD/ILS) and crypto spot price services with caching,
               fallbacks, sanity bounds and a manual-rate escape hatch.
  telegram/    initData verification, Bot API client, notification templates.
  core/        Domain services. Depends on db + blockchain + currency + telegram.
               Contains every business rule. No HTTP, no framework.
apps/
  web/         Next.js Mini App + /api route handlers (thin controllers).
  bot/         grammY bot: commands, inline keyboards, notification delivery.
  worker/      Job runner: chain scanning, FX refresh, reminders, scheduler.
  signer/      Isolated signing service. Separate process, private network,
               separate secret, disabled by default.
```

**Dependency direction is strictly one-way**: `apps → core → {db, blockchain, currency, telegram} → shared`.
No package imports an app; `shared` imports nothing.

---

## 5. Authentication and session model

Telegram Mini Apps run in a WebView where third-party cookie behaviour is inconsistent
(especially iOS). Rather than fight that, we use a model that also happens to eliminate CSRF:

1. The Mini App reads `window.Telegram.WebApp.initData` — an opaque signed string.
2. It `POST`s it to `/api/auth/telegram`.
3. The server recomputes the HMAC-SHA256 per Telegram's published algorithm
   (`secret = HMAC_SHA256("WebAppData", bot_token)`, then check `hash` over the sorted
   `key=value` pairs) using **constant-time comparison**, and rejects `auth_date` older than
   `TELEGRAM_INITDATA_MAX_AGE_SECONDS`.
4. The `initData` hash is recorded in `processed_events` — the same initData cannot be
   replayed to mint a second session.
5. On success the server upserts the user and issues a **short-lived session token**
   (HMAC-signed, `SESSION_TTL_SECONDS`, hash stored in `sessions` for revocation).
6. The client keeps that token **in memory only** — not in `localStorage`, not in a cookie.
   Every API call sends `Authorization: Bearer <token>`.

Consequences:

- **No ambient credential** → a cross-site request cannot carry authority → CSRF is structurally
  impossible for the API. (Endpoints still send `SameSite=Strict` on the one cookie we do set,
  the `__Host-rid` request-correlation cookie, which carries no authority.)
- A page reload silently re-authenticates from `initData`. Users never see a login screen.
- `initDataUnsafe` is used **only** for pre-render niceties (locale guess, avatar). It is never
  trusted for identity or authorization. The user id in the session comes exclusively from
  server-verified `initData`.

Sensitive actions (send, scheduled-payment creation, admin operations) additionally require a
**PIN** (`scrypt` + per-user salt + server pepper) with lockout, and a fresh confirmation token.

---

## 6. Money representation

Three numeric domains, all exact:

| Domain          | Storage                                                      | TypeScript                                        |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| Fiat (USD, ILS) | `BIGINT` **minor units** (cents, agorot)                     | `FiatAmount { currency, minor: bigint }`          |
| Crypto          | `NUMERIC(78,0)` **base units** (integer, per-token decimals) | `TokenAmount { assetKey, decimals, raw: bigint }` |
| Rates / prices  | `NUMERIC(30,12)` in the DB; scaled `bigint` (1e12) in code   | `Rate { scaled: bigint }`                         |

Rules enforced by lint and review:

- `parseFloat` is a banned global; `Number(...)` is flagged by a `no-restricted-syntax` rule.
- Conversions use `mulDiv(a, b, denominator, rounding)` — a single audited helper implementing
  half-up / half-even / floor / ceil on BigInt.
- Rounding happens **once**, at the boundary where a value becomes a display string or a
  persisted minor-unit amount. Intermediate values keep full precision.
- Token amounts always carry their `decimals`; there is no "amount as number" anywhere.

See `packages/shared/src/money/` and its test suite for the full contract.

---

## 7. Blockchain architecture

### Provider abstraction

```ts
interface BlockchainProvider {
  readonly network: Network; // 'tron' | 'ton'
  readonly env: NetworkEnv; // 'mainnet' | 'testnet'
  validateAddress(address: string): AddressValidation;
  getNativeBalance(address: string): Promise<TokenAmount>;
  getTokenBalances(address: string): Promise<TokenBalance[]>;
  listTransfers(address: string, cursor?: ScanCursor): Promise<TransferPage>;
  getTransaction(hash: string): Promise<ChainTransaction | null>;
  estimateFee(req: FeeRequest): Promise<FeeEstimate>;
  buildTransfer(req: TransferRequest): Promise<UnsignedTransfer>; // never signs
  broadcast(signed: SignedTransfer): Promise<BroadcastResult>;
}
```

Implementations: `TronProvider` (TronGrid primary, TronScan fallback), `TonProvider`
(TonCenter primary, TonAPI fallback), `MockProvider` (deterministic, used in dev and tests).

A `FallbackProvider` decorator wraps primary+secondary with per-provider circuit breaking, so a
single indexer outage degrades rather than breaks. All provider responses are parsed through Zod
schemas — chain data is **untrusted input** (see `docs/security.md` on malicious token metadata).

### Monitoring pipeline

```
worker tick (every CHAIN_SCAN_INTERVAL_SECONDS)
  └─ for each active wallet, enqueue job `chain.scan` (dedupe_key = wallet:cursor)
       └─ provider.listTransfers(address, cursor)
            └─ for each transfer, in ONE transaction:
                 1. INSERT INTO processed_events (network, env, event_id)   -- ON CONFLICT DO NOTHING
                 2. if 0 rows inserted -> already handled, skip (idempotent)
                 3. INSERT INTO transactions (..., tx_hash, event_index)
                    UNIQUE (network, env, tx_hash, event_index) as a second guard
                 4. UPDATE wallet_balances
                 5. INSERT INTO jobs ('notify.transaction')
                 6. UPDATE wallets SET last_cursor = ...
```

Every step is inside one Postgres transaction, so a crash at any point leaves no partial state.
The `processed_events` insert is the idempotency gate; the `transactions` unique index is the
belt-and-braces guard. Balances are additionally reconciled from `getTokenBalances` on a slower
cadence so drift is self-healing.

Confirmation tracking runs as a separate job (`chain.confirm`) that walks `detected`/`confirming`
transactions until they reach the network's finality threshold, then fires the "confirmed"
notification.

### Explorer links

Explorer URLs live in a single registry (`packages/blockchain/src/explorers.ts`) keyed by
`network × env`, never string-concatenated at call sites:

- TRON mainnet — `https://tronscan.org/#/transaction/{hash}`
- TRON Shasta testnet — `https://shasta.tronscan.org/#/transaction/{hash}`
- TON mainnet — `https://tonviewer.com/transaction/{hash}`
- TON testnet — `https://testnet.tonviewer.com/transaction/{hash}`

---

## 8. Outgoing transfers — the key security decision

**Default architecture is watch-only.** Storing private keys is not required for anything in
sections 1–15 and 17–24 of the requirements, so by default this application stores **no key
material at all**. Wallets are public addresses. The portfolio, history, notifications, analytics,
goals and expected-income features are fully functional in this mode.

Sending is implemented as a **three-actor protocol** with the key material isolated in its own
process that the public API cannot reach:

```
  Mini App            web API                signer service            chain
     │  quote request     │                        │                     │
     ├───────────────────>│  validate address,     │                     │
     │                    │  balance, limits, fee  │                     │
     │<───────────────────┤  send_requests(status=quoted, idem_key)      │
     │  confirm + PIN     │                        │                     │
     ├───────────────────>│  re-validate, check    │                     │
     │                    │  kill switch + limits  │                     │
     │                    │  build UNSIGNED tx     │                     │
     │                    ├───HMAC-signed────────> │  decrypt key,       │
     │                    │  (private network)     │  verify policy,     │
     │                    │                        │  sign, broadcast ───┤
     │                    │<───────────────────────┤  tx hash            │
     │<───────────────────┤  status=broadcast      │                     │
```

Controls, all independently enforced:

- `SENDING_ENABLED=false` master kill switch (default) — the API refuses before anything else.
- `SIGNER_MODE=mock` (default) — nothing is ever broadcast; a deterministic fake hash is returned.
- The signer binds to `127.0.0.1` / private network by default and requires an HMAC signature
  with a timestamp and nonce (replay-protected).
- `SIGNER_MASTER_KEY` exists **only** in the signer's environment. The web app cannot decrypt key
  material even if fully compromised.
- Per-transaction and rolling-24h USD caps, enforced in both the API and the signer.
- Idempotency key on every send request; a retry returns the original result, never a second send.
- Recipient address must pass network-specific validation _and_ checksum verification.
- Every step writes an audit log entry.

If you later choose to enable real sending, `docs/security.md` documents the threat model,
encryption scheme, key management, backup, rotation and emergency-disable procedure. The
recommended production posture is an external signer (hardware/HSM/KMS) implementing the same
HMAC interface, so the database never holds key material at all.

---

## 9. Scheduled payments

`scheduled_payments` rows are picked up by the worker's `schedule.tick` job. Execution is guarded:

1. Advisory lock on the row (`FOR UPDATE SKIP LOCKED`) → no double execution across workers.
2. State machine transition `scheduled → processing` must succeed atomically, or the tick aborts.
3. Pre-flight validation: kill switch, wallet still active, recipient valid, balance sufficient
   _including estimated fee_, provider reachable, USD limits.
4. **If any check fails, nothing is sent.** The row moves to `failed` with a reason and the user
   gets a Telegram notification with a "review" button. It is never retried blindly.
5. Success moves to `completed` and links `executed_transaction_id`.

With `SENDING_ENABLED=false` (the default), step 3 always fails closed with
`SENDING_DISABLED`, so a fresh deployment can never move real funds.

---

## 10. Notifications

`packages/core/notifications` writes rows to `notifications` with a `dedupe_key`
(`UNIQUE (user_id, dedupe_key)`) — the anti-spam primitive. The bot process drains the table via
the `notify.dispatch` job and calls the Bot API. Because delivery is a database row and not an
in-memory event, notifications work when the Mini App is closed, survive restarts, and retry
with exponential backoff.

Templates are localized (ar/en) from the same catalogue the Mini App uses, honour per-type user
preferences and quiet hours, and attach inline keyboards with deep links
(`https://t.me/<bot>/<app>?startapp=tx_<id>`) that open the Mini App on the right screen.

---

## 11. Data model summary

Ten migrations, applied in order and immutable once applied (the runner records a checksum
and refuses to proceed if a file changed). Full DDL and rationale in
[`docs/database.md`](./database.md). Highlights:

- One **unified `transactions` ledger** with `kind ∈ {cash, crypto}` rather than two parallel
  tables, plus `CHECK` constraints that make the crypto columns mandatory-together and the cash
  columns mandatory-together. History, search, filters and analytics become single-table queries.
- UUID primary keys, `created_at/updated_at` triggers, soft delete via `deleted_at`.
- Enums for every state machine, with transition validity enforced in SQL functions.
- RLS on every user-scoped table, keyed off `current_setting('app.user_id')`, which the DB layer
  sets with `SET LOCAL` inside each transaction. The application's own role is therefore _also_
  constrained by RLS — a bug in a repository cannot read another user's rows.

---

## 12. Failure and degradation policy

| Failure                    | Behaviour                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FX API down                | Serve last cached rate; mark `stale`. Past `FX_MAX_STALENESS_SECONDS`, the UI shows converted values as unavailable rather than wrong. Never silently substitutes. |
| Primary chain indexer down | Circuit breaker → fallback provider. Both down → wallet marked `scan_degraded`, banner in UI, no data invented.                                                    |
| Signer unreachable         | Send fails closed with `SIGNER_UNAVAILABLE`. No retry that could double-send.                                                                                      |
| Worker crash mid-job       | Job lease expires, another worker retries. All handlers are idempotent.                                                                                            |
| Telegram Bot API 429       | Backoff honouring `retry_after`; notifications stay queued.                                                                                                        |

---

## 13. What is intentionally _not_ built

- No custodial multi-tenant key storage. See §8.
- No exchange/trading integration.
- No DIY DDoS mitigation — that is Vercel's and Railway's edge layer. We implement
  application-level rate limiting, body-size caps and query timeouts, and document the split in
  [`docs/security.md`](./security.md).
- No client-side Supabase access. The anon key is never shipped; all data access is server-side.
