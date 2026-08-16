import type {
  ActorType,
  AssetKind,
  CategoryKind,
  ExpectedIncomeStatus,
  FxMode,
  GoalStatus,
  JobStatus,
  Network,
  NetworkEnv,
  NotificationStatus,
  ScheduledPaymentStatus,
  SendRequestStatus,
  ThemePreference,
  TxDirection,
  TxKind,
  TxSource,
  TxStatus,
  TxType,
  WalletType,
} from '@wallet/shared';

/**
 * Row shapes as they come back from PostgreSQL: snake_case, and every exact-integer money
 * column typed as `string`.
 *
 * That last part is the important one. `BIGINT` and `NUMERIC` arrive as strings from the
 * driver and stay strings until an explicit `BigInt(...)` conversion in the mapping layer.
 * If these were typed `number`, TypeScript would happily let arithmetic happen on a value
 * that has already lost precision.
 */

export type FiatCode = 'USD' | 'ILS';

export interface UserRow {
  id: string;
  telegram_id: string;
  username: string | null;
  first_name: string;
  last_name: string | null;
  photo_url: string | null;
  language_code: string | null;
  is_admin: boolean;
  is_active: boolean;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface UserSettingsRow {
  user_id: string;
  locale: string;
  theme_preference: ThemePreference;
  primary_fiat: FiatCode;
  reporting_fiat: FiatCode;
  fx_mode: FxMode;
  manual_usd_ils: string | null;
  timezone: string;
  hide_balances: boolean;
  pin_hash: string | null;
  pin_salt: string | null;
  pin_set_at: Date | null;
  pin_failed_count: number;
  pin_locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface NotificationPreferencesRow {
  user_id: string;
  enabled_types: Record<string, boolean>;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  min_crypto_value_usd_minor: string;
  fx_alert_threshold_bps: number;
  created_at: Date;
  updated_at: Date;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  ip_hash: string | null;
  user_agent: string | null;
}

export interface AssetRow {
  id: string;
  network: Network;
  env: NetworkEnv;
  kind: AssetKind;
  symbol: string;
  name: string;
  decimals: number;
  contract_address: string | null;
  price_id: string | null;
  icon_key: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface WalletRow {
  id: string;
  user_id: string;
  name: string;
  network: Network;
  env: NetworkEnv;
  address: string;
  address_canonical: string;
  type: WalletType;
  is_active: boolean;
  scan_cursor: Record<string, unknown> | null;
  last_scanned_at: Date | null;
  last_scan_error: string | null;
  consecutive_failures: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface WalletBalanceRow {
  id: string;
  wallet_id: string;
  asset_id: string;
  raw_amount: string;
  source: string | null;
  updated_at: Date;
}

export interface CashAccountRow {
  id: string;
  user_id: string;
  name: string;
  currency: FiatCode;
  balance_minor: string;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface CategoryRow {
  id: string;
  user_id: string | null;
  key: string | null;
  name: string | null;
  kind: CategoryKind;
  icon: string | null;
  color: string | null;
  is_system: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface TransactionRow {
  id: string;
  user_id: string;
  kind: TxKind;
  type: TxType;
  direction: TxDirection;
  status: TxStatus;
  source: TxSource;
  title: string;
  description: string | null;
  notes: string | null;
  category_id: string | null;
  occurred_at: Date;
  cash_account_id: string | null;
  fiat_currency: FiatCode | null;
  fiat_amount_minor: string | null;
  wallet_id: string | null;
  asset_id: string | null;
  raw_amount: string | null;
  network: Network | null;
  env: NetworkEnv | null;
  tx_hash: string | null;
  log_index: number | null;
  counterparty_address: string | null;
  memo: string | null;
  fee_asset_id: string | null;
  fee_raw_amount: string | null;
  confirmations: number | null;
  required_confirmations: number | null;
  block_number: string | null;
  block_time: Date | null;
  value_usd_minor: string | null;
  value_ils_minor: string | null;
  usd_ils_rate: string | null;
  unit_price_usd: string | null;
  valued_at: Date | null;
  external_ref: string | null;
  attachment_url: string | null;
  idempotency_key: string | null;
  send_request_id: string | null;
  scheduled_payment_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/** A transaction row joined with the display data the API needs. */
export interface TransactionWithRelationsRow extends TransactionRow {
  asset_symbol: string | null;
  asset_name: string | null;
  asset_decimals: number | null;
  asset_contract: string | null;
  asset_icon: string | null;
  asset_kind: AssetKind | null;
  fee_asset_symbol: string | null;
  fee_asset_decimals: number | null;
  wallet_name: string | null;
  category_key: string | null;
  category_name: string | null;
  category_kind: CategoryKind | null;
  category_icon: string | null;
  category_color: string | null;
  category_is_system: boolean | null;
}

export interface ExpectedIncomeRow {
  id: string;
  user_id: string;
  name: string;
  reason: string | null;
  amount_minor: string;
  currency: FiatCode;
  expected_date: string;
  status: ExpectedIncomeStatus;
  remind_at: Date | null;
  reminded_at: Date | null;
  overdue_notified_at: Date | null;
  category_id: string | null;
  notes: string | null;
  received_transaction_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ScheduledPaymentRow {
  id: string;
  user_id: string;
  wallet_id: string;
  asset_id: string;
  title: string | null;
  to_address: string;
  to_address_canonical: string;
  raw_amount: string;
  memo: string | null;
  scheduled_at: Date;
  status: ScheduledPaymentStatus;
  attempts: number;
  max_attempts: number;
  last_error_code: string | null;
  last_error_at: Date | null;
  next_attempt_at: Date | null;
  locked_by: string | null;
  locked_until: Date | null;
  executed_transaction_id: string | null;
  send_request_id: string | null;
  upcoming_notified_at: Date | null;
  idempotency_key: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface SendRequestRow {
  id: string;
  user_id: string;
  wallet_id: string;
  asset_id: string;
  to_address: string;
  to_address_canonical: string;
  raw_amount: string;
  memo: string | null;
  status: SendRequestStatus;
  quote_fingerprint: string;
  fee_asset_id: string | null;
  fee_raw_amount: string | null;
  value_usd_minor: string | null;
  expires_at: Date;
  confirmed_at: Date | null;
  broadcast_at: Date | null;
  completed_at: Date | null;
  tx_hash: string | null;
  transaction_id: string | null;
  scheduled_payment_id: string | null;
  simulated: boolean;
  error_code: string | null;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
}

export interface FinancialGoalRow {
  id: string;
  user_id: string;
  name: string;
  target_minor: string;
  current_minor: string;
  currency: FiatCode;
  deadline: string | null;
  status: GoalStatus;
  icon: string | null;
  color: string | null;
  notes: string | null;
  achieved_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  dedupe_key: string;
  deliver_after: Date;
  attempts: number;
  sent_at: Date | null;
  telegram_message_id: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface JobRow {
  id: string;
  type: string;
  queue: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_until: Date | null;
  last_error: string | null;
  dedupe_key: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AuditLogRow {
  id: string;
  user_id: string | null;
  actor_type: ActorType;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface ExchangeRateRow {
  id: string;
  base: FiatCode;
  quote: FiatCode;
  rate: string;
  source: string;
  is_manual: boolean;
  fetched_at: Date;
  created_at: Date;
}

export interface AssetPriceRow {
  id: string;
  asset_id: string;
  quote: FiatCode;
  price: string;
  source: string;
  fetched_at: Date;
}

export interface AppSettingRow {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: Date;
}

export interface BlockchainScanRow {
  id: string;
  wallet_id: string;
  provider: string;
  status: 'running' | 'ok' | 'failed';
  started_at: Date;
  finished_at: Date | null;
  transfers_seen: number;
  transfers_new: number;
  cursor_before: Record<string, unknown> | null;
  cursor_after: Record<string, unknown> | null;
  error: string | null;
}
