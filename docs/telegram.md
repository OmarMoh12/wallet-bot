# Telegram setup

---

## 1. Create the bot

In `@BotFather`:

```
/newbot
  → name:     Wallet
  → username: my_wallet_dashboard_bot
```

Copy the token into `TELEGRAM_BOT_TOKEN`. Treat it as a password: it is the key that verifies
every `initData` payload, so anyone holding it can forge authentication.

Recommended follow-ups:

```
/setdescription   → Private financial dashboard
/setabouttext     → Track cash, crypto and scheduled payments
/setuserpic
/setprivacy       → Enable   (the bot does not need to read group messages)
```

---

## 2. Create the Mini App

```
/newapp
  → select your bot
  → title, description, 640x360 photo
  → Web App URL: https://your-app.vercel.app
  → short name:  wallet          ← this is TELEGRAM_MINIAPP_SHORT_NAME
```

Then set:

```bash
TELEGRAM_WEBAPP_URL=https://your-app.vercel.app
TELEGRAM_MINIAPP_SHORT_NAME=wallet
TELEGRAM_BOT_USERNAME=my_wallet_dashboard_bot
```

The short name enables direct links: `https://t.me/<bot>/<short_name>?startapp=tx_<id>`,
which is what notification buttons use to open the app on the right screen.

The app also sets a persistent menu button on startup, so there is a permanent "Wallet" entry
next to the message box.

---

## 3. Become the admin

Message `@userinfobot` to get your numeric id, then:

```bash
TELEGRAM_ADMIN_IDS=123456789
```

The **first** id listed is granted admin on first login. Admin status is only ever _granted_
by this variable, never revoked — removing an admin is a deliberate, audited operation.

---

## 4. Polling vs webhook

**Development** — `TELEGRAM_MODE=polling`. No public URL needed. The bot deletes any existing
webhook on startup, because Telegram refuses `getUpdates` while one is registered.

**Production** — `TELEGRAM_MODE=webhook`:

```bash
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_URL=https://your-bot.up.railway.app/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)
```

The bot registers the webhook itself on boot. Every delivery is verified against
`X-Telegram-Bot-Api-Secret-Token` **in constant time, before the body is parsed** — an
unauthenticated request never reaches the update router.

---

## 5. Authentication

The Mini App reads `window.Telegram.WebApp.initData` and posts it to `/api/auth/telegram`.
The server:

1. recomputes `HMAC-SHA256` per Telegram's published algorithm, compared in constant time;
2. rejects `auth_date` older than `TELEGRAM_INITDATA_MAX_AGE_SECONDS` (default 15 min);
3. records the initData hash in `processed_events`, so one payload mints at most one session;
4. issues a short-lived bearer token the client keeps **in memory only**.

`initDataUnsafe` is never trusted for identity. See `docs/security.md` §2.

---

## 6. Commands

Registered automatically on startup:

| Command         | Does                                                 |
| --------------- | ---------------------------------------------------- |
| `/start`        | Welcome + "Open dashboard" button                    |
| `/balance`      | Cash and crypto totals, with the FX rate and its age |
| `/transactions` | Latest activity                                      |
| `/wallets`      | Wallets with shortened addresses                     |
| `/income`       | Expected income, with overdue marked                 |
| `/scheduled`    | Scheduled payments and their status                  |
| `/receive`      | Opens the app on the receive screen                  |
| `/settings`     | Opens the app on settings                            |
| `/help`         | Command list                                         |

The bot is **read-only**. `/send` explains that transfers are confirmed inside the Mini App.
That boundary is deliberate: bot updates authenticate the transport, not the individual
request, so the weaker channel never authorises money movement.

---

## 7. Notifications

Queued as database rows and drained by the bot process (and by the worker's `notify.dispatch`
job — both use `FOR UPDATE SKIP LOCKED`, so they cooperate rather than duplicate).

Consequences: notifications work while the Mini App is closed, survive restarts, and retry
with backoff honouring Telegram's `retry_after`.

Each row stores **parameters**, never rendered text, so a message is translated at delivery
time — change the language in Settings and the next notification arrives in it, with no
migration of queued rows.

Anti-spam is a `UNIQUE (user_id, dedupe_key)` index: re-processing the same chain event, or
two workers racing on it, produces exactly one message. Quiet hours defer rather than drop
(except security alerts). Per-type preferences default to **on**, because someone who has
just been paid should not discover the alert was opt-in.

---

## 8. Theme and language

Telegram delivers its theme as `--tg-theme-*` CSS custom properties. Tailwind v4 reads its
tokens from CSS custom properties too, so the two meet directly: every colour is
`var(--tg-theme-x, <fallback>)`. "Follow Telegram" needs no JavaScript theme engine, and
`themeChanged` re-colours the whole UI live.

An explicit Dark/Light choice sets `data-theme` on `<html>`, which overrides the Telegram
variables.

Language follows `language_code` on first login, then the user's saved preference. Arabic
switches `dir="rtl"` at the document level; monetary values and addresses are wrapped in
`unicode-bidi: isolate` so the bidi algorithm cannot visually reverse an amount or an
address inside RTL text.

---

## 9. Troubleshooting

| Symptom                                  | Cause                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| "Could not verify your Telegram session" | `TELEGRAM_BOT_TOKEN` does not match the bot serving the Mini App                   |
| "Your Telegram session is too old"       | Clock skew, or the app sat open past the max age — reopening fixes it              |
| "This session was already used"          | The same `initData` was submitted twice (replay protection working)                |
| Mini App will not open                   | URL must be HTTPS and registered with `/newapp`                                    |
| Webhook 401s                             | `TELEGRAM_WEBHOOK_SECRET` differs between the registration and the running process |
| No notifications                         | Check the bot process is running and `notifications_enabled` in the admin panel    |
