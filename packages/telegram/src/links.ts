/**
 * Deep links into the Mini App.
 *
 * Telegram passes `startapp` through to the Mini App as `start_param` inside initData, so a
 * notification button can open the app directly on the relevant screen. The payload is
 * restricted to `[A-Za-z0-9_-]` (Telegram's own constraint) and is treated as untrusted on
 * the receiving end — see `sanitizeStartParam`.
 */

export interface DeepLinkConfig {
  botUsername: string;
  /** Short name of the Mini App as configured in BotFather, when using a named app. */
  appShortName?: string;
}

const SAFE_PARAM = /^[A-Za-z0-9_-]{1,64}$/;

export function miniAppLink(config: DeepLinkConfig, startParam?: string): string {
  const base = config.appShortName
    ? `https://t.me/${config.botUsername}/${config.appShortName}`
    : `https://t.me/${config.botUsername}`;
  if (!startParam || !SAFE_PARAM.test(startParam)) return base;
  return `${base}?startapp=${startParam}`;
}

/** Route tokens embedded in `startapp`, kept short because Telegram caps the payload at 64. */
export const START_PARAM = {
  transaction: (id: string) => `tx_${compactUuid(id)}`,
  wallet: (id: string) => `w_${compactUuid(id)}`,
  scheduled: (id: string) => `sp_${compactUuid(id)}`,
  expectedIncome: (id: string) => `ei_${compactUuid(id)}`,
  screen: (name: 'home' | 'wallets' | 'activity' | 'payments' | 'settings' | 'receive' | 'send') =>
    `s_${name}`,
} as const;

/** UUID without dashes: 32 chars, comfortably inside the 64-character limit. */
function compactUuid(id: string): string {
  return id.replace(/-/g, '');
}

export interface ParsedStartParam {
  kind: 'transaction' | 'wallet' | 'scheduled' | 'expectedIncome' | 'screen';
  value: string;
}

/** Parse a `start_param` back into a route. Returns null for anything unrecognised. */
export function parseStartParam(param: string | null): ParsedStartParam | null {
  if (!param || !SAFE_PARAM.test(param)) return null;
  const [prefix, ...rest] = param.split('_');
  const value = rest.join('_');
  if (!value) return null;

  switch (prefix) {
    case 'tx':
      return expandUuid(value) ? { kind: 'transaction', value: expandUuid(value) as string } : null;
    case 'w':
      return expandUuid(value) ? { kind: 'wallet', value: expandUuid(value) as string } : null;
    case 'sp':
      return expandUuid(value) ? { kind: 'scheduled', value: expandUuid(value) as string } : null;
    case 'ei':
      return expandUuid(value)
        ? { kind: 'expectedIncome', value: expandUuid(value) as string }
        : null;
    case 's':
      return /^[a-z]{1,20}$/.test(value) ? { kind: 'screen', value } : null;
    default:
      return null;
  }
}

function expandUuid(compact: string): string | null {
  if (!/^[0-9a-f]{32}$/i.test(compact)) return null;
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20, 32),
  ].join('-');
}
