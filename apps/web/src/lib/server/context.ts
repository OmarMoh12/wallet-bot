import 'server-only';
import { createAppContext, createServices, type AppContext, type Services } from '@wallet/core';

/**
 * Server-side singletons.
 *
 * On Vercel each warm lambda reuses this module, so the database pool, the provider registry
 * and the currency caches survive between requests. A cold start pays for one construction.
 *
 * `import 'server-only'` makes it a **build error** for any client component to reach this
 * module — which is the mechanism that keeps `DATABASE_URL`, `TELEGRAM_BOT_TOKEN` and
 * `SESSION_SECRET` out of the browser bundle, rather than relying on care.
 */

let cachedContext: AppContext | null = null;
let cachedServices: Services | null = null;

export function getAppContext(): AppContext {
  if (!cachedContext) {
    cachedContext = createAppContext({ service: 'web' });
  }
  return cachedContext;
}

export function getServices(): Services {
  if (!cachedServices) {
    cachedServices = createServices(getAppContext());
  }
  return cachedServices;
}
