# Wallet — Telegram financial dashboard

A private financial-management system for one person, delivered as a **Telegram Bot** plus a
**Telegram Mini App**. It tracks cash in shekels, a watch-only crypto portfolio across TRON
and TON, expected income, scheduled payments and goals — and tells you about it in Telegram,
in Arabic or English, whether or not the app is open.

> **Sending cryptocurrency is disabled by default and the system stores no private keys.**
> Everything else works fully in that mode. Enabling transfers is a deliberate, multi-step
> operation described in [`docs/deployment.md`](docs/deployment.md) §4.

---

## What it does

- **Two kinds of money, kept separate.** Cash you physically hold (managed manually, mainly
  ILS) and a crypto portfolio (detected automatically, reported in USD). The dashboard shows
  both, and the total in both currencies.
- **Automatic blockchain monitoring.** Addresses on TRON (TRX, USDT-TRC20), TON, and
  BNB Smart Chain (BNB, USDT/USDC/BUSD BEP-20) are scanned continuously; incoming and
  outgoing transfers become ledger entries with explorer links, and you get a Telegram
  message.
- **EVM wallets with in-app address creation.** The signing service generates the keypair,
  keeps the private key encrypted, and returns only the address — ready to receive
  immediately. The key is never displayed, never returned by the API, and never stored in the
  database.
- **Manual cash ledger.** Income, expenses, adjustments, categories, notes, search, filters.
- **Expected income and scheduled payments**, with reminders.
- **Analytics** — income vs expense over time, category breakdown, period comparisons.
- **Goals** with progress tracking.
- **Arabic and English**, with real RTL, and a theme that follows Telegram's live.

## What it deliberately does not do

- Store private keys anywhere in the application or database.
- Trust `initDataUnsafe`, a user id from a request body, or chain-reported token metadata.
- Show a total assembled from a stale or missing exchange rate. It shows "—" instead.
- Let the bot channel authorise anything that moves money.

---

## Quick start

```bash
pnpm install
cp .env.example .env            # defaults are safe: mock chain, keyless FX, sending off
docker compose up -d db
pnpm run build:packages
pnpm run db:migrate
pnpm run db:seed -- --telegram-id <your telegram id>
pnpm dev
```

Mini App on `http://localhost:3000`, worker health on `http://localhost:8080/health`.
Telegram needs a public HTTPS URL to load the app — see
[`docs/development.md`](docs/development.md).

---

## Stack

| Layer      | Choice                                                             |
| ---------- | ------------------------------------------------------------------ |
| Mini App   | Next.js 15 (App Router), React 19, Tailwind CSS v4                 |
| API        | Next.js Route Handlers, Node runtime                               |
| Bot        | grammY                                                             |
| Worker     | Plain Node, PostgreSQL-backed job queue                            |
| Database   | Supabase PostgreSQL, `postgres.js`, Row Level Security             |
| Validation | Zod                                                                |
| Money      | Custom BigInt fixed-point — no floats anywhere near an amount      |
| Hosting    | Vercel (web) · Railway (bot, worker, signer) · Supabase (database) |

Runtime dependencies across the whole repository: `next`, `react`, `react-dom`, `postgres`,
`zod`, `grammy`, `pino`, `qrcode`, `tailwindcss`, `@noble/curves` (signer only). Each one is
an unaudited path into a process that can see money, so the list is kept short on purpose.

Rationale for every choice — including why the job queue is PostgreSQL rather than
Redis/BullMQ, and why the Telegram SDK is a hand-written wrapper — is in
[`docs/architecture.md`](docs/architecture.md) §3.

---

## Layout

```
apps/web      Mini App + /api route handlers      → Vercel
apps/bot      Commands and notification delivery  → Railway
apps/worker   Scanning, FX, scheduling, reminders → Railway
apps/signer   Isolated signing, disabled by default → Railway (private)

packages/shared      money, errors, enums, schemas, i18n
packages/db          client, RLS binding, migrations, repositories
packages/blockchain  providers, address validation, explorers
packages/currency    FX and crypto prices
packages/telegram    initData verification, Bot API, templates
packages/core        every business rule
```

Dependencies flow one way: `apps → core → {db, blockchain, currency, telegram} → shared`.

---

## Verification

```bash
pnpm run verify   # format:check → lint → typecheck → test
pnpm run build
```

**193 tests** (131 unit, 62 integration). Integration tests run against a real PostgreSQL as
a non-superuser, because that is the only way to prove Row Level Security actually works.
They skip with a message if no test database is configured.

---

## Documentation

|                                         |                                                                 |
| --------------------------------------- | --------------------------------------------------------------- |
| [architecture.md](docs/architecture.md) | Topology, technology choices and why, failure policy            |
| [security.md](docs/security.md)         | **Threat model, auth, signing architecture, known limitations** |
| [database.md](docs/database.md)         | Schema, invariants, RLS, idempotency indexes                    |
| [blockchain.md](docs/blockchain.md)     | Provider abstraction, monitoring pipeline, hostile chain data   |
| [telegram.md](docs/telegram.md)         | BotFather setup, webhooks, notifications, theme                 |
| [deployment.md](docs/deployment.md)     | Supabase, Vercel, Railway, enabling transfers                   |
| [development.md](docs/development.md)   | Local setup, safe mode, conventions                             |
| [testing.md](docs/testing.md)           | What is covered, and three real bugs the tests caught           |

---

## Licence

Private project. Not licensed for redistribution.
