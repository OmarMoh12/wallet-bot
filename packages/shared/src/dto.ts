import type {
  AssetKind,
  CategoryKind,
  ExpectedIncomeStatus,
  FxMode,
  GoalStatus,
  Locale,
  Network,
  NetworkEnv,
  NotificationType,
  ScheduledPaymentStatus,
  SendRequestStatus,
  ThemePreference,
  TxDirection,
  TxKind,
  TxSource,
  TxStatus,
  TxType,
  WalletType,
} from './domain/enums.js';
import type { FiatCurrency } from './money/fiat.js';

/**
 * Wire types shared by the API and the Mini App.
 *
 * Money crosses the boundary in a self-describing envelope: exact integer units for
 * arithmetic, plus a pre-rendered display string so the client never has to reimplement
 * rounding rules. The client is free to re-derive display from the exact fields, but it must
 * never do arithmetic on the display string.
 */

export interface FiatMoneyDto {
  currency: FiatCurrency;
  /** Signed integer minor units (cents/agorot), as a string to survive JSON. */
  minor: string;
  /** Exact decimal representation, e.g. "1842.32". */
  decimal: string;
}

export interface TokenMoneyDto {
  assetId: string;
  symbol: string;
  decimals: number;
  /** Signed integer base units, as a string. */
  raw: string;
  /** Exact decimal representation at full token precision. */
  decimal: string;
}

/** A crypto amount with its fiat valuations attached at a known rate. */
export interface ValuedTokenDto {
  token: TokenMoneyDto;
  usd: FiatMoneyDto | null;
  ils: FiatMoneyDto | null;
  /** Null when pricing was unavailable — the UI must show "—", never zero. */
  pricedAt: string | null;
}

export interface AssetDto {
  id: string;
  network: Network;
  env: NetworkEnv;
  kind: AssetKind;
  symbol: string;
  name: string;
  decimals: number;
  contractAddress: string | null;
  iconKey: string | null;
}

export interface WalletDto {
  id: string;
  name: string;
  network: Network;
  env: NetworkEnv;
  address: string;
  type: WalletType;
  isWatchOnly: boolean;
  isActive: boolean;
  createdAt: string;
  lastScannedAt: string | null;
  scanState: 'ok' | 'never_scanned' | 'degraded';
  explorerUrl: string;
}

export interface WalletBalanceDto {
  asset: AssetDto;
  value: ValuedTokenDto;
  updatedAt: string | null;
}

export interface WalletDetailDto extends WalletDto {
  balances: WalletBalanceDto[];
  totalUsd: FiatMoneyDto | null;
  totalIls: FiatMoneyDto | null;
}

export interface CategoryDto {
  id: string;
  key: string | null;
  name: string;
  kind: CategoryKind;
  icon: string | null;
  color: string | null;
  isSystem: boolean;
}

export interface CashAccountDto {
  id: string;
  name: string;
  currency: FiatCurrency;
  balance: FiatMoneyDto;
  isDefault: boolean;
}

export interface TransactionDto {
  id: string;
  kind: TxKind;
  type: TxType;
  direction: TxDirection;
  status: TxStatus;
  source: TxSource;
  title: string;
  description: string | null;
  notes: string | null;
  category: CategoryDto | null;
  occurredAt: string;
  createdAt: string;

  /** Present when `kind === 'cash'`. */
  fiat: FiatMoneyDto | null;
  cashAccountId: string | null;

  /** Present when `kind === 'crypto'`. */
  token: TokenMoneyDto | null;
  asset: AssetDto | null;
  walletId: string | null;
  walletName: string | null;
  network: Network | null;
  env: NetworkEnv | null;
  txHash: string | null;
  counterpartyAddress: string | null;
  memo: string | null;
  confirmations: number | null;
  requiredConfirmations: number | null;
  blockNumber: string | null;
  fee: TokenMoneyDto | null;
  explorerUrl: string | null;

  /** Valuation at the time the row was recorded, for both reporting currencies. */
  valueUsd: FiatMoneyDto | null;
  valueIls: FiatMoneyDto | null;
}

export interface ExpectedIncomeDto {
  id: string;
  name: string;
  reason: string | null;
  amount: FiatMoneyDto;
  amountUsd: FiatMoneyDto | null;
  expectedDate: string;
  status: ExpectedIncomeStatus;
  remindAt: string | null;
  isOverdue: boolean;
  daysUntil: number;
  category: CategoryDto | null;
  notes: string | null;
  receivedTransactionId: string | null;
}

export interface ScheduledPaymentDto {
  id: string;
  title: string | null;
  wallet: { id: string; name: string; network: Network; env: NetworkEnv };
  asset: AssetDto;
  amount: TokenMoneyDto;
  amountUsd: FiatMoneyDto | null;
  toAddress: string;
  memo: string | null;
  scheduledAt: string;
  status: ScheduledPaymentStatus;
  attempts: number;
  lastError: string | null;
  executedTransactionId: string | null;
  /** False while `SENDING_ENABLED=false`; the UI explains why. */
  executable: boolean;
  createdAt: string;
}

export interface SendQuoteDto {
  sendRequestId: string;
  status: SendRequestStatus;
  wallet: { id: string; name: string; network: Network; env: NetworkEnv; address: string };
  asset: AssetDto;
  amount: TokenMoneyDto;
  amountUsd: FiatMoneyDto | null;
  toAddress: string;
  memo: string | null;
  estimatedFee: TokenMoneyDto | null;
  estimatedFeeUsd: FiatMoneyDto | null;
  /** amount + fee when they share an asset; otherwise just amount. */
  total: TokenMoneyDto;
  /** Opaque digest of everything above; must be echoed back on confirm. */
  fingerprint: string;
  expiresAt: string;
  /** True when the send would be simulated rather than broadcast. */
  simulated: boolean;
  warnings: string[];
}

export interface SendResultDto {
  sendRequestId: string;
  status: SendRequestStatus;
  txHash: string | null;
  explorerUrl: string | null;
  transactionId: string | null;
  simulated: boolean;
}

export interface ReceiveInfoDto {
  wallet: WalletDto;
  asset: AssetDto;
  address: string;
  /** Server-rendered SVG QR, delivered as a data URI. */
  qrSvgDataUri: string;
  networkLabel: string;
  warningKey: string;
}

export interface ExchangeRateDto {
  base: FiatCurrency;
  quote: FiatCurrency;
  rate: string;
  source: string;
  updatedAt: string;
  ageSeconds: number;
  isStale: boolean;
  isManual: boolean;
}

export interface GoalDto {
  id: string;
  name: string;
  target: FiatMoneyDto;
  current: FiatMoneyDto;
  /** Integer percent, 0–100, clamped. */
  progressPercent: number;
  deadline: string | null;
  status: GoalStatus;
  icon: string | null;
  color: string | null;
  notes: string | null;
}

export interface PortfolioSummaryDto {
  totalUsd: FiatMoneyDto | null;
  totalIls: FiatMoneyDto | null;
  cash: { usd: FiatMoneyDto | null; ils: FiatMoneyDto | null; native: FiatMoneyDto };
  crypto: { usd: FiatMoneyDto | null; ils: FiatMoneyDto | null };
  assets: Array<{
    asset: AssetDto;
    value: ValuedTokenDto;
    /** Share of the crypto portfolio in basis points (0–10000). */
    shareBps: number;
  }>;
  rate: ExchangeRateDto | null;
  /** True when any valuation could not be computed; the UI must not show a fake total. */
  partial: boolean;
  generatedAt: string;
}

export interface DashboardDto {
  summary: PortfolioSummaryDto;
  recentTransactions: TransactionDto[];
  upcomingIncome: ExpectedIncomeDto[];
  upcomingPayments: ScheduledPaymentDto[];
  goals: GoalDto[];
  alerts: Array<{
    key: string;
    severity: 'info' | 'warning' | 'critical';
    params?: Record<string, string>;
  }>;
}

export interface AnalyticsPointDto {
  /** ISO date (bucket start). */
  date: string;
  incomeMinor: string;
  expenseMinor: string;
  netMinor: string;
}

export interface AnalyticsDto {
  currency: FiatCurrency;
  period: 'week' | 'month' | 'quarter' | 'year';
  income: FiatMoneyDto;
  expense: FiatMoneyDto;
  net: FiatMoneyDto;
  previousIncome: FiatMoneyDto;
  previousExpense: FiatMoneyDto;
  /** Signed change vs previous period, in basis points. Null when previous was zero. */
  incomeChangeBps: number | null;
  expenseChangeBps: number | null;
  series: AnalyticsPointDto[];
  byCategory: Array<{ category: CategoryDto | null; amount: FiatMoneyDto; shareBps: number }>;
  cryptoValueUsd: FiatMoneyDto | null;
  cashBalance: FiatMoneyDto;
}

export interface UserSettingsDto {
  locale: Locale;
  themePreference: ThemePreference;
  primaryFiat: FiatCurrency;
  reportingFiat: FiatCurrency;
  fxMode: FxMode;
  manualUsdIls: string | null;
  timezone: string;
  hideBalances: boolean;
  pinSet: boolean;
  notifications: Record<NotificationType, boolean>;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

export interface SessionDto {
  token: string;
  expiresAt: string;
  user: {
    id: string;
    telegramId: string;
    firstName: string;
    lastName: string | null;
    username: string | null;
    photoUrl: string | null;
    isAdmin: boolean;
  };
  settings: UserSettingsDto;
  features: {
    sendingEnabled: boolean;
    simulatedSending: boolean;
    chainEnv: NetworkEnv;
    safeMode: boolean;
  };
}

export interface HealthDto {
  status: 'ok' | 'degraded' | 'down';
  service: string;
  version: string;
  uptimeSeconds: number;
  checks: Array<{
    name: string;
    status: 'ok' | 'degraded' | 'down';
    latencyMs: number | null;
    detail?: string;
  }>;
  timestamp: string;
}
