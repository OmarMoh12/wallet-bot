# Security

> Read this before enabling outgoing transfers, changing the authentication flow, or adding
> an endpoint. It is the threat model, not a checklist.

---

## 1. What this system is protecting

One person's financial position: cash balances, crypto holdings, transaction history, and —
if signing is ever enabled — the ability to move funds. The realistic adversaries are:

| Adversary                            | Capability                                        | Primary defence                                                                       |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Someone who found the Mini App URL   | Can load the page, call the API                   | Telegram `initData` verification; no unauthenticated data path                        |
| A malicious Telegram user            | Can craft `startapp` links, send crafted payloads | Server-side validation of every input; `start_param` allow-list                       |
| A compromised blockchain indexer     | Returns hostile data                              | Zod schemas on every response; asset registry allow-list; SSRF-hardened HTTP client   |
| Someone with the database            | Read/write SQL                                    | Session tokens and PINs stored hashed; **no key material in the database at all**     |
| A compromised web/bot/worker process | Code execution in the app tier                    | Signing isolated in a separate process with its own secret; kill switches; spend caps |
| A network attacker                   | Can observe/intercept                             | HTTPS everywhere; HSTS; no secrets in URLs                                            |

---

## 2. Authentication

### The flow

```
Mini App                     API                              Telegram
   │  window.Telegram.WebApp.initData (signed by Telegram)
   ├──POST /api/auth/telegram──────────►
   │                          │ 1. HMAC-SHA256 verify with bot token (constant-time)
   │                          │ 2. reject auth_date older than TELEGRAM_INITDATA_MAX_AGE_SECONDS
   │                          │ 3. claim the initData hash in processed_events (replay gate)
   │                          │ 4. upsert user, issue opaque session token
   │◄────{ token, user, settings, features }
   │
   │  Authorization: Bearer <token>  on every subsequent request
```

### Why there is no CSRF defence

Because there is nothing to defend. The session token lives in **module scope in the
browser** — not `localStorage`, not a cookie. A cross-site request therefore carries no
identity, and the API rejects it as unauthenticated. This is stronger than a CSRF token,
which only works if you remember to check it on every route.

The one cookie the app can set (`__Host-` request correlation) carries no authority.

### What is never trusted

- `window.Telegram.WebApp.initDataUnsafe` — used only for a pre-render locale guess.
- A user id in a request body, query string or header.
- The `Origin` header as authorization (it is used only to reject obvious cross-origin calls).

### Session tokens

32 random bytes. The database stores only `HMAC-SHA256(SESSION_SECRET, token)`, so a
database dump yields nothing usable — without the server secret an attacker cannot even
verify a guess offline. Sessions are short-lived (`SESSION_TTL_SECONDS`, default 1 hour) and
revocable.

### PIN

Six digits is a 10^6 space, which is only defensible in depth:

- per-user random salt, stored;
- server-side **pepper** (`PIN_PEPPER`) that never touches the database, so a database-only
  compromise does not permit offline cracking;
- `scrypt` with N=32768 (~50 ms per attempt);
- hard lockout after 5 failures for 15 minutes;
- changing the PIN revokes every other session.

---

## 3. Authorization and data isolation

Every user-scoped table has Row Level Security, keyed off a session variable the database
layer sets per transaction:

```sql
SELECT set_config('app.user_id', $1, true);   -- transaction-local
```

The application connects as `app_user`, a role **without** `BYPASSRLS`. That matters: RLS
constrains our own repositories, so a forgotten `WHERE user_id = ...` returns zero rows
rather than another user's finances. `tests/integration/rls.test.ts` proves this by
connecting as that same non-superuser role and attempting IDOR directly.

`set_config(..., true)` is transaction-scoped rather than session-scoped, so a pooled
connection cannot leak identity from one request into the next — also asserted by a test.

### The system plane

Unbound transactions (`withSystem`) can read across users. This is deliberate and documented
in migration `0009`: the auth bootstrap must create a user before an identity exists, and
the worker (chain scanning, reminders, notification dispatch) acts for the platform rather
than a session. **No request handler can produce an unbound transaction** — every API route
resolves a bearer token and calls `withUser` before touching user data.

### Admin

Admin RLS policies are **SELECT-only**. An admin can inspect, but mutating another user's
financial rows has no code path. Admin operations are all audited.

---

## 4. Input handling

| Vector              | Defence                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL injection       | `postgres.js` tagged templates — every interpolation is a bind parameter. No string concatenation reaches the planner. Dynamic identifiers go through `sql()`, which quotes.                                                             |
| Mass assignment     | Every Zod object is `.strict()` — unknown keys are **rejected**, not stripped. Repositories name every column explicitly; there is no spread-into-UPDATE anywhere.                                                                       |
| XSS                 | React escapes by default. The one HTML surface is Telegram messages, where every interpolated value goes through `escapeHtml`. CSP blocks inline event handlers and third-party script.                                                  |
| IDOR                | RLS (above) plus explicit `user_id` predicates. Path parameters are UUID-validated before use.                                                                                                                                           |
| SSRF                | Outbound HTTP has a host allow-list, `redirect: 'manual'`, DNS resolution checked against private ranges, HTTPS-only outside development.                                                                                                |
| Path traversal      | No user input reaches the filesystem. The only file paths are the migration directory and the signer keystore, both operator-configured.                                                                                                 |
| Command injection   | Nothing in the runtime spawns a shell.                                                                                                                                                                                                   |
| Prototype pollution | `redact()` skips `__proto__`/`constructor`/`prototype` and walks own properties only. JSON parsing feeds Zod, which builds fresh objects.                                                                                                |
| Log forging         | `x-request-id` is accepted only if it matches `[A-Za-z0-9_-]{8,64}`.                                                                                                                                                                     |
| Bidi spoofing       | Control and bidi-override characters (U+202A–U+202E, U+2066–U+2069) are stripped from all user text. This matters specifically because the UI renders Arabic: those characters can visually reverse an address in a confirmation screen. |
| Oversized payloads  | 64 KB body cap, enforced before parsing; 2 MB cap on provider responses, enforced while streaming.                                                                                                                                       |

---

## 5. Idempotency and double-spend

Three independent mechanisms, because this is where money is actually lost:

1. **Chain ingestion** — `processed_events` claim on `chain:<network>:<env>:<hash>:<logIndex>`,
   plus a unique index on `transactions (network, env, tx_hash, log_index)`. Both are decided
   by the index, never by a preceding `SELECT`, so concurrent workers cannot both win.
2. **Client mutations** — `UNIQUE (user_id, idempotency_key)`. A retry returns the original
   row.
3. **Outgoing transfers** — the `quoted → confirmed` transition is a single conditional
   `UPDATE`. Exactly one caller can claim a quote; a second confirmation finds no row in
   `quoted` state and is refused.

Scheduled payments add a fourth: `FOR UPDATE SKIP LOCKED` with a lease, so two workers never
claim the same payment, and a crashed worker's claim expires rather than sticking.

---

## 6. Signing architecture

### The default: no keys at all

This application stores **no private key material**. There is no column for it in the
database — `tests/integration/evm-chain.test.ts` asserts that by inspecting
`information_schema.columns`. Wallets are public addresses. Everything except outgoing
transfers works in this mode, and this is what ships.

### EVM keys, when you do generate one

EVM is the one network where the system can create a keypair for you, because an EVM address
is useless for receiving until it exists. The boundary is drawn so that "the user never sees
the private key" is a **structural** property rather than a policy:

- the key is generated **inside the signer process**, by `POST /generate`, using the OS CSPRNG
  with rejection sampling over `[1, n)` — reducing 32 random bytes modulo the curve order
  introduces a bias, and that shortcut has broken real wallets;
- it is encrypted with AES-256-GCM before it touches disk, with the address and network as
  additional authenticated data;
- **only the address is returned.** There is no field in `GenerateAddressResult`, in the
  `WalletDto`, or in any API response that could carry key material;
- the buffer is zeroed immediately after storage;
- generation is idempotent on a client key, so a retry cannot strand a second funded address
  nobody knows about;
- the audit entry records the address — which is public — and nothing else.

Signing adds one further check that the other chains cannot have: the signer **recomputes the
transaction bytes** from the structured fields and compares them byte-for-byte against what
the caller sent. A payload altered between the API building it and the signer receiving it —
a swapped recipient, a raised amount — fails to match and nothing is signed. It also verifies
that the stored key actually derives the address it is filed under, and that the chain id
matches the chain the signer is provisioned for (EIP-155, so a signature is valid on exactly
one chain).

### If you enable sending

Eight independent controls, each sufficient on its own to stop a transfer:

1. `SENDING_ENABLED=false` (default) — refused before any work happens.
2. `app_settings.sending_enabled` — a database kill switch that is **ANDed** with the
   environment variable. It can only tighten, never loosen: a compromised admin session
   cannot enable outbound transfers.
3. The wallet must be `type = 'managed'`. The ordinary wallet-creation schema hard-codes
   `watch_only`; the only path that produces a managed wallet is EVM key generation, which
   goes through the signer and is itself gated on `SIGNER_ENABLED`.
4. PIN required (`SEND_REQUIRE_PIN`, mandatory in production).
5. Per-transaction and rolling-24h USD caps, enforced in the API **and again** in the signer.
6. Quote fingerprint — confirmation must echo a digest of exactly the numbers displayed.
7. Idempotency key — a retry returns the original result.
8. `SIGNER_MODE=mock` (default) — nothing is broadcast even if all of the above pass.

Additionally, `useRemoteSigner()` requires production **or** a testnet chain env, so a
development machine pointed at mainnet cannot broadcast regardless of configuration.

### Threat model for the signer

The signer assumes **the calling service may already be compromised**.

- Separate process, private network, bound to `127.0.0.1` unless
  `SIGNER_ALLOW_PUBLIC_BIND=true` is set deliberately (it refuses to start otherwise).
- Requests are HMAC-signed over `METHOD\npath\ntimestamp\nnonce\nsha256(body)`. Including
  method and path stops a signed body being replayed against a different endpoint.
- Timestamp window (±60 s) plus a nonce cache, so a captured request cannot be replayed.
- Its **own** spend caps and recipient allow-list, independent of anything the API says.
- Its own idempotency memory: a repeated key is refused rather than re-signed.
- `SIGNER_MASTER_KEY` exists only in the signer's environment. The web app cannot decrypt
  key material even if fully compromised.

### Encryption at rest

`AES-256-GCM`, key derived from `SIGNER_MASTER_KEY`. The AAD binds each entry to its address
and network, so swapping ciphertext between entries fails authentication — an attacker with
write access to the keystore file cannot make the signer sign for address B using key A.

File permissions are forced to `0600`.

### Key management, rotation, backup, emergency disable

| Concern           | Procedure                                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provisioning      | `pnpm --filter @wallet/signer keystore add --network tron --env testnet --address T...` — the key is read from stdin so it never enters shell history or the process list. Then set the wallet to `type='managed'`.           |
| Backup            | Back up the encrypted keystore file **and** `SIGNER_MASTER_KEY` separately, to different places. Either alone is useless; together they are the funds.                                                                        |
| Rotation          | `keystore rotate --new-key <base64>` re-encrypts every entry, then swap `SIGNER_MASTER_KEY` and restart. Old ciphertext is not left in the file.                                                                              |
| Emergency disable | Any of: set `SENDING_ENABLED=false` and redeploy; toggle `sending_enabled` off in the admin panel (takes effect immediately, no deploy); set `SIGNER_ENABLED=false` and restart the signer; stop the signer service entirely. |

### The recommendation

For anything beyond small balances, do not use the file keystore. Point `SIGNER_URL` at an
HSM- or KMS-backed service implementing the same HMAC interface. The `Keystore` class is the
seam for that, and no caller changes.

---

## 7. Rate limiting and abuse

Application-level, per bucket, keyed on the authenticated user where there is one and a
hashed IP otherwise:

| Bucket  | Default | Window   |
| ------- | ------- | -------- |
| `auth`  | 10      | minute   |
| `read`  | 120     | minute   |
| `write` | 30      | minute   |
| `send`  | 10      | **hour** |

Two tiers: an in-process counter (absorbs bursts without a round trip) backed by an atomic
PostgreSQL upsert (so limits hold across serverless instances). A failure of the shared
counter degrades to per-instance limiting and logs at **error** level — because a silently
degraded rate limiter is exactly how a control stops working unnoticed. That is not
hypothetical: migration `0010` fixes a PL/pgSQL name collision that had this effect, and
`tests/integration/rate-limit.test.ts` now asserts the counter is genuinely persisted.

### What this is not

Volumetric DDoS mitigation. That is Vercel's and Railway's edge, and it is where it belongs.
The split:

| Layer                                      | Handled by                              |
| ------------------------------------------ | --------------------------------------- |
| Network/volumetric floods, TLS termination | Vercel / Railway edge                   |
| Bot filtering, WAF rules                   | Vercel (optional Attack Challenge Mode) |
| Per-user and per-endpoint quotas           | This application                        |
| Body-size caps, query timeouts             | This application                        |
| Database connection exhaustion             | Pool limits + `statement_timeout`       |

---

## 8. Secrets

- Server-only modules carry `import 'server-only'`, which makes a client-component import a
  **build error** rather than a silent leak.
- `scripts/check-env-leaks.mjs` scans the built client bundle for the actual values of every
  secret variable, plus patterns (bot tokens, Postgres URLs). It runs in CI.
- Logs are redacted twice: pino path redaction, and a value scan that catches bot tokens,
  long key blobs and credentialed Postgres URLs in free text.
- Audit logs store hashed IPs, never raw addresses.

---

## 9. Known limitations

Stated plainly rather than buried:

- **`'unsafe-inline'` in the script CSP.** Next.js's inline bootstrap requires it for a
  client-component app; a nonce-based policy would need every page to be dynamically
  rendered. `frame-ancestors` still restricts embedding to Telegram origins.
- **DNS rebinding is not fully closed.** The SSRF guard resolves and checks the address, but
  Node re-resolves on connect. The host allow-list is the primary control; the DNS check is
  defence in depth.
- **The signer's daily spend tracker is in memory.** Restarting it resets the rolling total.
  The per-transaction cap is the hard limit; the daily cap is secondary. A persistent
  tracker would need the signer to have its own storage, which is a deliberate trade against
  keeping it minimal.
- **The bot channel is weaker than the Mini App.** Bot updates authenticate the _transport_,
  not the individual request. That is why the bot is read-only and everything that moves
  money is confirmed in the Mini App.
- **TON sending needs an adapter.** `signTon` fails closed with `TON_ADAPTER_REQUIRED` unless
  a pre-built message cell is supplied; assembling a TON BOC needs the wallet contract ABI
  and seqno. TRON and EVM signing are complete.
- **EVM nonce management is single-writer.** The nonce comes from `eth_getTransactionCount`
  with the `pending` tag at build time and the quote expires after two minutes. Two transfers
  from the same address prepared concurrently could collide on a nonce; the second would be
  rejected by the node rather than mis-sent, but it is a real limitation of not running a
  nonce allocator.
- **Native BNB transfers are not indexed by history.** `eth_getLogs` only sees ERC-20 events;
  a plain BNB transfer emits none. The balance reconciliation pass keeps the BNB balance
  correct, but individual native transfers do not appear as ledger rows. Adding them needs a
  trace-capable RPC endpoint (`debug_traceBlock` or an indexer), which most public nodes do
  not offer.
