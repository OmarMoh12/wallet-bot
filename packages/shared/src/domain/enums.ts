/**
 * Domain enumerations. These mirror the PostgreSQL enum types exactly — if you change
 * one, change the other in the same migration.
 */

/**
 * Supported networks.
 *
 * `bsc` is the first EVM chain. Adding another (Ethereum, Polygon, Arbitrum...) means a
 * value here, a matching `ALTER TYPE network_t ADD VALUE` migration, and one entry in
 * `EVM_CHAINS` — the provider implementation is shared, because EVM chains differ only in
 * chain id, RPC endpoint, native symbol and explorer.
 */
export const NETWORKS = ['tron', 'ton', 'bsc'] as const;
export type Network = (typeof NETWORKS)[number];

/**
 * Networks that speak the Ethereum JSON-RPC dialect and use 20-byte hex addresses.
 *
 * Kept as an explicit list rather than inferred, so adding a network is a deliberate act:
 * address validation, fee semantics and transaction encoding all branch on this.
 */
export const EVM_NETWORKS = ['bsc'] as const;
export type EvmNetwork = (typeof EVM_NETWORKS)[number];

export function isEvmNetwork(network: Network): network is EvmNetwork {
  return (EVM_NETWORKS as readonly string[]).includes(network);
}

export const NETWORK_ENVS = ['mainnet', 'testnet'] as const;
export type NetworkEnv = (typeof NETWORK_ENVS)[number];

export const WALLET_TYPES = ['watch_only', 'managed'] as const;
export type WalletType = (typeof WALLET_TYPES)[number];

export const ASSET_KINDS = ['native', 'token'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const TX_KINDS = ['cash', 'crypto'] as const;
export type TxKind = (typeof TX_KINDS)[number];

export const TX_TYPES = ['income', 'expense', 'transfer', 'adjustment'] as const;
export type TxType = (typeof TX_TYPES)[number];

export const TX_DIRECTIONS = ['in', 'out', 'internal'] as const;
export type TxDirection = (typeof TX_DIRECTIONS)[number];

export const TX_STATUSES = [
  'pending',
  'detected',
  'confirming',
  'confirmed',
  'failed',
  'cancelled',
  'reversed',
] as const;
export type TxStatus = (typeof TX_STATUSES)[number];

export const TX_SOURCES = ['manual', 'chain', 'scheduled', 'system'] as const;
export type TxSource = (typeof TX_SOURCES)[number];

export const SCHEDULED_PAYMENT_STATUSES = [
  'scheduled',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ScheduledPaymentStatus = (typeof SCHEDULED_PAYMENT_STATUSES)[number];

export const EXPECTED_INCOME_STATUSES = ['pending', 'received', 'delayed', 'cancelled'] as const;
export type ExpectedIncomeStatus = (typeof EXPECTED_INCOME_STATUSES)[number];

export const SEND_REQUEST_STATUSES = [
  'quoted',
  'confirmed',
  'signing',
  'broadcast',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const;
export type SendRequestStatus = (typeof SEND_REQUEST_STATUSES)[number];

export const GOAL_STATUSES = ['active', 'achieved', 'archived'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const CATEGORY_KINDS = ['income', 'expense', 'both'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const THEME_PREFERENCES = ['system', 'dark', 'light'] as const;
/** `system` means "follow whatever theme Telegram reports right now". */
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

export const TEXT_DIRECTION_BY_LOCALE: Readonly<Record<Locale, 'ltr' | 'rtl'>> = Object.freeze({
  en: 'ltr',
  ar: 'rtl',
});

export const FX_MODES = ['auto', 'manual'] as const;
export type FxMode = (typeof FX_MODES)[number];

export const NOTIFICATION_TYPES = [
  'crypto_received',
  'crypto_sent',
  'crypto_confirmed',
  'crypto_failed',
  'expected_income_due',
  'expected_income_overdue',
  'scheduled_payment_upcoming',
  'scheduled_payment_executed',
  'scheduled_payment_failed',
  'fx_rate_alert',
  'balance_alert',
  'goal_reached',
  'security_alert',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed', 'suppressed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = [
  'chain.scan',
  'chain.confirm',
  'chain.reconcile',
  'fx.refresh',
  'price.refresh',
  'notify.dispatch',
  'schedule.tick',
  'schedule.execute',
  'income.remind',
  'cleanup.expire',
  'alerts.evaluate',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.session_revoked',
  'auth.pin_set',
  'auth.pin_failed',
  'auth.pin_locked',
  'wallet.created',
  'wallet.updated',
  'wallet.deleted',
  'wallet.rescan_requested',
  'wallet.generated',
  'transaction.created',
  'transaction.updated',
  'transaction.deleted',
  'cash_account.created',
  'cash_account.updated',
  'send.quoted',
  'send.confirmed',
  'send.cancelled',
  'send.broadcast',
  'send.failed',
  'schedule.created',
  'schedule.updated',
  'schedule.cancelled',
  'schedule.executed',
  'schedule.failed',
  'expected_income.created',
  'expected_income.updated',
  'goal.created',
  'goal.updated',
  'category.created',
  'category.updated',
  'category.deleted',
  'settings.updated',
  'admin.setting_changed',
  'admin.user_updated',
  'admin.rescan',
  'admin.sending_toggled',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const ACTOR_TYPES = ['user', 'admin', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
