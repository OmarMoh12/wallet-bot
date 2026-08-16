# Deployment

Three platforms, four deployables:

| Deployable                  | Platform | Public?                                       |
| --------------------------- | -------- | --------------------------------------------- |
| `apps/web` — Mini App + API | Vercel   | yes (HTTPS, required by Telegram)             |
| `apps/bot`                  | Railway  | webhook endpoint only                         |
| `apps/worker`               | Railway  | health endpoint only                          |
| `apps/signer`               | Railway  | **no** — private network, disabled by default |
| Database                    | Supabase | no                                            |

---

## 1. Supabase

1. Create a project. Note the region — put Vercel and Railway near it.
2. **Settings → Database → Connection string**. You need two:
   - _Session pooler_ (port 6543) → `DATABASE_URL` for the runtime.
   - _Direct_ (port 5432) → `DATABASE_MIGRATION_URL` for migrations. Poolers do not handle
     DDL and advisory locks reliably.
3. Create the least-privilege runtime role. In the SQL editor:

```sql
CREATE ROLE app_user LOGIN PASSWORD '<a strong password>';
-- Grants and RLS policies are created by migration 0007.
```

Point `DATABASE_URL` at `app_user`, not `postgres`. This is what makes Row Level Security
apply to the application's own queries — a superuser bypasses every policy, so using
`postgres` at runtime would silently disable the isolation the tests verify.

4. Apply migrations:

```bash
DATABASE_MIGRATION_URL='postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres' \
  pnpm run db:migrate

pnpm run db:status   # confirm every migration is applied
```

5. Set `DATABASE_SSL=true`.

Supabase's own `anon` key is never used: there is no client-side database access at all.

---

## 2. Vercel

**Import the repository**, then set:

| Setting          | Value                                                              |
| ---------------- | ------------------------------------------------------------------ |
| Framework        | Next.js                                                            |
| Root directory   | _repository root_ (not `apps/web` — the build needs the workspace) |
| Build command    | `pnpm run build:packages && pnpm --filter @wallet/web build`       |
| Install command  | `pnpm install --frozen-lockfile`                                   |
| Output directory | `apps/web/.next`                                                   |

`vercel.json` already encodes this.

### Environment variables

Set these for **Production** and **Preview**:

```
APP_ENV=production
APP_URL=https://your-app.vercel.app
CORS_ALLOWED_ORIGINS=https://your-app.vercel.app

DATABASE_URL=postgresql://app_user:...@...pooler.supabase.com:6543/postgres
DATABASE_SSL=true

TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=my_wallet_dashboard_bot
TELEGRAM_WEBAPP_URL=https://your-app.vercel.app
TELEGRAM_MINIAPP_SHORT_NAME=wallet
TELEGRAM_ADMIN_IDS=123456789

SESSION_SECRET=<openssl rand -base64 32>
PIN_PEPPER=<openssl rand -base64 32>
ENCRYPTION_KEY=<openssl rand -base64 32>

CHAIN_ENV=testnet          # switch to mainnet only when you are ready
BLOCKCHAIN_MOCK=false
TRONGRID_API_KEY=...
TONCENTER_API_KEY=...

SENDING_ENABLED=false      # leave false
SIGNER_MODE=mock
```

The config loader **refuses to boot** in production without `TELEGRAM_BOT_TOKEN`,
`SESSION_SECRET`, `PIN_PEPPER`, an HTTPS `APP_URL`, and `BLOCKCHAIN_MOCK=false`. A
misconfigured deployment fails loudly at startup rather than running insecurely.

### After deploying

```bash
node scripts/check-env-leaks.mjs
```

It reads the built client bundle and looks for the actual values of every server-only
variable. It runs in CI too.

---

## 3. Railway

Create **one project with three services**, all from this repository, all with the root
directory set to the repository root (the Docker build context needs the workspace).

Each uses the same `Dockerfile` and differs only in its start command:

| Service | Start command                                                               | Health               |
| ------- | --------------------------------------------------------------------------- | -------------------- |
| worker  | `node packages/db/dist/cli/migrate.js up && node apps/worker/dist/index.js` | `/health` on `$PORT` |
| bot     | `node apps/bot/dist/index.js`                                               | `/health` on `$PORT` |
| signer  | `node apps/signer/dist/index.js`                                            | none (private)       |

Running migrations from the **worker** start command means they apply once per deploy, before
the worker takes work. They are idempotent and guarded by an advisory lock, so a concurrent
deploy serialises rather than collides.

### Worker variables

Same database, Telegram and chain variables as Vercel, plus:

```
WORKER_CONCURRENCY=4
CHAIN_SCAN_INTERVAL_SECONDS=60
WORKER_HEALTH_PORT=8080
```

### Bot variables

```
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_URL=https://<bot-service>.up.railway.app/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
WORKER_HEALTH_PORT=8080
```

Generate a public domain for the bot service; the worker and signer do not need one.

### Signer

Leave it off unless you have read `docs/security.md` §6. When you do enable it:

```
SIGNER_ENABLED=true
SIGNER_MASTER_KEY=<openssl rand -base64 32>   # ONLY here, never in web/bot/worker
SIGNER_HMAC_SECRET=<openssl rand -base64 48>  # shared with web + worker
SIGNER_CHAIN_ENV=testnet
SIGNER_ALLOWED_NETWORKS=tron
SIGNER_MAX_USD_PER_TX=100
SIGNER_MAX_USD_PER_DAY=250
SIGNER_BIND=0.0.0.0
SIGNER_ALLOW_PUBLIC_BIND=true                 # required for Railway's private network
```

**Do not generate a public domain for this service.** Reach it over Railway's private network
(`http://signer.railway.internal:8090`) and set `SIGNER_URL` accordingly on web and worker.

The service refuses to start bound to `0.0.0.0` without the explicit acknowledgement flag,
because a publicly reachable signer is the single worst misconfiguration available here.

---

## 4. Enabling real transfers

Deliberately multi-step. Each is reversible.

1. Deploy the signer with `SIGNER_ENABLED=true` and a master key.
2. Provision a key **on the signer host**:
   ```bash
   pnpm --filter @wallet/signer keystore add --network tron --env testnet --address T...
   # the key is read from stdin — never in argv, never in shell history
   ```
3. Mark the wallet as managed:
   ```sql
   UPDATE wallets SET type = 'managed' WHERE id = '<uuid>';
   ```
4. On web and worker: `SIGNER_MODE=remote`, `SIGNER_URL=...`, matching `SIGNER_HMAC_SECRET`.
5. Set `SENDING_ENABLED=true` and redeploy.
6. Turn on the database switch in the admin panel (both must be on).
7. **Send a minimal amount on testnet first**, and confirm it appears on the explorer.
8. Only then consider `CHAIN_ENV=mainnet`, with `SEND_MAX_USD_PER_TX` set low.

To stop everything instantly: toggle sending off in the admin panel. It takes effect on the
next request, with no deploy.

---

## 5. Docker (self-hosting)

```bash
docker compose up -d db
pnpm run db:migrate
docker compose up -d worker bot
pnpm dev:web
```

The image is multi-stage, runs as a non-root user, and contains production dependencies only.
The web app is excluded from it entirely, which keeps Next.js and React out of the service
image.

---

## 6. Operations

### Health

| Endpoint                | Reports                                                  |
| ----------------------- | -------------------------------------------------------- |
| `GET /api/health` (web) | database, queue depth, FX freshness, Telegram configured |
| `GET /health` (worker)  | the above plus worker id and job counters                |
| `GET /health` (bot)     | the above                                                |
| `GET /api/admin/health` | deep check including provider and signer connectivity    |

`degraded` and `down` are distinguished on purpose: a market-data outage means totals are
stale but the app works; a database outage means it does not. Health returns 503 only for
`down`, so the platform does not restart a worker that is merely waiting on an upstream.

### Logs

Structured JSON via pino, redacted twice (path-based and value-scanning). Every request
carries a `requestId`, echoed in the `x-request-id` response header — quote it when
investigating.

### Backups

Supabase takes daily backups. Additionally back up, separately from the database:

- `SIGNER_MASTER_KEY` and the signer keystore file (if signing is enabled);
- `SESSION_SECRET` and `PIN_PEPPER` — losing the pepper invalidates every PIN.
