# Local development

---

## Prerequisites

- Node.js 22.14+
- pnpm 9.15+ (`corepack enable && corepack prepare pnpm@9.15.4 --activate`)
- PostgreSQL 15+ — either Docker, a local install, or a Supabase project

---

## First run

```bash
git clone <repo> && cd my_wallet_bot
pnpm install

cp .env.example .env
# Nothing needs editing to get a working app: the defaults use mock chain data,
# keyless FX providers, and sending disabled.

# Start PostgreSQL (or point DATABASE_URL at your own)
docker compose up -d db

pnpm run build:packages
pnpm run db:migrate
pnpm run db:seed -- --telegram-id <your telegram id>

pnpm dev
```

`pnpm dev` builds the workspace packages, then runs the Mini App, the worker and (if
`TELEGRAM_BOT_TOKEN` is set) the bot, with prefixed output. The Mini App is at
`http://localhost:3000`; the worker health endpoint at `http://localhost:8080/health`.

Find your Telegram id by messaging `@userinfobot`.

---

## Safe mode

With `APP_ENV=development` the system is inert by construction:

|                    |                                                                   |
| ------------------ | ----------------------------------------------------------------- |
| Blockchain         | `MockProvider` — deterministic fake data, cannot reach a network  |
| Sending            | `SENDING_ENABLED=false` — every send is refused before any work   |
| Signer             | `SIGNER_MODE=mock` — nothing is broadcast even if sending were on |
| Chain env          | `testnet`                                                         |
| Scheduled payments | Prepared and validated, then refused with `SENDING_DISABLED`      |

`useRemoteSigner()` additionally requires production **or** a testnet chain env, so a
development machine pointed at mainnet cannot broadcast whatever else is configured.

---

## Opening the Mini App

Telegram will not load `http://localhost` — it needs a public HTTPS URL.

```bash
# any tunnel works
cloudflared tunnel --url http://localhost:3000
# or: ngrok http 3000
```

Then in `@BotFather`: `/newapp`, point it at the tunnel URL, and set `TELEGRAM_WEBAPP_URL`
and `APP_URL` to match.

**In a plain browser** the app renders a "reopen from Telegram" screen. That is deliberate:
`initData` is the only way to authenticate, and there is no weaker fallback just to make the
page render.

---

## Common commands

```bash
pnpm dev                # everything, watch mode
pnpm dev:web            # Mini App only
pnpm dev:worker         # worker only
pnpm dev:bot            # bot only

pnpm run db:migrate     # apply pending migrations
pnpm run db:status      # what is applied
pnpm run db:reset       # drop and rebuild (development/test only, needs CONFIRM_RESET=yes)
pnpm run db:seed        # demo data

pnpm test               # everything
pnpm run test:watch
pnpm run test:coverage

pnpm run verify         # format:check + lint + typecheck + test — run before pushing
pnpm run build          # production build of every package and app
pnpm run clean
```

---

## Repository layout

```
apps/
  web/       Next.js Mini App + /api route handlers        → Vercel
  bot/       grammY bot, notification delivery             → Railway
  worker/    job runner: scanning, FX, scheduling          → Railway
  signer/    isolated signing service (disabled by default) → Railway, private
packages/
  shared/    money, errors, enums, schemas, i18n           (no app imports)
  db/        postgres.js client, RLS binding, repositories
  blockchain/ providers, address validation, explorers
  currency/  FX and crypto price services
  telegram/  initData verification, Bot API, templates
  core/      domain services — all business logic lives here
supabase/migrations/   SQL, applied in order
tests/       unit + integration
```

Dependencies flow one way: `apps → core → {db, blockchain, currency, telegram} → shared`.
Nothing imports an app; `shared` imports only `zod`.

---

## Adding things

**A network.** Implement `BlockchainProvider`, add an address validator, add an explorer
registry entry, insert `assets` rows, register it in `ProviderRegistry`. Nothing else moves.

**A language.** Add `packages/shared/src/i18n/<code>.ts` typed as
`Messages & Record<string, string>`, add it to `LOCALES` and the catalogue map. The i18n test
fails until every key is present — that is the point.

**An endpoint.** Add a Zod schema in `packages/shared/src/schemas/api.ts`, a method on a
core service, and a route handler that wraps it in `route()`. Authentication, rate limiting,
validation, error shaping and logging come from the wrapper; there is nothing to remember.

---

## Conventions that are enforced, not suggested

- `any` is an ESLint **error**.
- `parseFloat` is a banned global; `Number(...)` is flagged by `no-restricted-syntax`. Use
  `bigintToNumber` (checked) or `parseCount` (row counts) — both say what they are.
- Money never crosses a boundary as a JSON number. Amounts are decimal **strings** in, exact
  minor/base units out.
- Zod objects are `.strict()`. Unknown keys are rejected, not stripped.
- Every mutating endpoint that creates money movement takes a client idempotency key.
