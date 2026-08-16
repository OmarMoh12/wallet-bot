import {
  FiatAmount,
  TokenAmount,
  assetKey,
  bigintToNumber,
  clamp,
  daysBetween,
  type AssetDto,
  type CategoryDto,
  type ExchangeRateDto,
  type ExpectedIncomeDto,
  type FiatCurrency,
  type FiatMoneyDto,
  type GoalDto,
  type ScheduledPaymentDto,
  type TokenMoneyDto,
  type TransactionDto,
  type ValuedTokenDto,
  type WalletDto,
} from '@wallet/shared';
import { addressUrl, networkLabel, transactionUrl } from '@wallet/blockchain';
import type { RateResult } from '@wallet/currency';
import type {
  AssetRow,
  CategoryRow,
  ExpectedIncomeRow,
  FinancialGoalRow,
  ScheduledPaymentRow,
  TransactionWithRelationsRow,
  WalletRow,
} from '@wallet/db';

/**
 * Row → DTO mapping.
 *
 * The one rule: money crosses the wire as exact integer units *plus* a pre-rendered exact
 * decimal string. The client never has to reconstruct precision, and never has a reason to
 * do arithmetic on a formatted string.
 */

export function toFiatDto(amount: FiatAmount): FiatMoneyDto {
  return {
    currency: amount.currency,
    minor: amount.minor.toString(),
    decimal: amount.toDecimalString(),
  };
}

export function fiatFromMinor(
  minor: string | bigint | null,
  currency: FiatCurrency,
): FiatMoneyDto | null {
  if (minor === null) return null;
  return toFiatDto(FiatAmount.fromMinor(minor, currency));
}

export function toTokenDto(amount: TokenAmount, assetId: string): TokenMoneyDto {
  return {
    assetId,
    symbol: amount.symbol,
    decimals: amount.decimals,
    raw: amount.raw.toString(),
    decimal: amount.toDecimalString(),
  };
}

export function tokenAmountFromRow(raw: string | bigint, asset: AssetRow): TokenAmount {
  return TokenAmount.fromRaw(raw, {
    assetKey: assetKey({
      network: asset.network,
      env: asset.env,
      contractAddress: asset.contract_address,
      symbol: asset.symbol,
    }),
    symbol: asset.symbol,
    decimals: asset.decimals,
  });
}

export function toAssetDto(asset: AssetRow): AssetDto {
  return {
    id: asset.id,
    network: asset.network,
    env: asset.env,
    kind: asset.kind,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    contractAddress: asset.contract_address,
    iconKey: asset.icon_key,
  };
}

export function toCategoryDto(
  row: Pick<CategoryRow, 'id' | 'key' | 'name' | 'kind' | 'icon' | 'color' | 'is_system'>,
  translate: (key: string) => string,
): CategoryDto {
  return {
    id: row.id,
    key: row.key,
    // Built-in categories carry a localisation key; custom ones carry a literal name.
    name: row.key ? translate(row.key) : (row.name ?? ''),
    kind: row.kind,
    icon: row.icon,
    color: row.color,
    isSystem: row.is_system,
  };
}

export interface WalletScanPolicy {
  /** Scans older than this mark the wallet degraded in the UI. */
  degradedAfterSeconds: number;
}

export function toWalletDto(row: WalletRow, policy: WalletScanPolicy): WalletDto {
  const lastScanned = row.last_scanned_at;
  let scanState: WalletDto['scanState'] = 'ok';
  if (!lastScanned) scanState = 'never_scanned';
  else if (
    row.consecutive_failures > 0 ||
    Date.now() - lastScanned.getTime() > policy.degradedAfterSeconds * 1000
  ) {
    scanState = 'degraded';
  }

  return {
    id: row.id,
    name: row.name,
    network: row.network,
    env: row.env,
    address: row.address,
    type: row.type,
    isWatchOnly: row.type === 'watch_only',
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    lastScannedAt: lastScanned?.toISOString() ?? null,
    scanState,
    explorerUrl: addressUrl(row.network, row.env, row.address) ?? '',
  };
}

export function toValuedTokenDto(params: {
  token: TokenMoneyDto;
  usd: FiatAmount | null;
  ils: FiatAmount | null;
  pricedAt: Date | null;
}): ValuedTokenDto {
  return {
    token: params.token,
    usd: params.usd ? toFiatDto(params.usd) : null,
    ils: params.ils ? toFiatDto(params.ils) : null,
    pricedAt: params.pricedAt?.toISOString() ?? null,
  };
}

export function toTransactionDto(
  row: TransactionWithRelationsRow,
  translate: (key: string) => string,
): TransactionDto {
  const asset: AssetDto | null =
    row.asset_id && row.asset_symbol && row.asset_decimals !== null
      ? {
          id: row.asset_id,
          network: row.network ?? 'tron',
          env: row.env ?? 'mainnet',
          kind: row.asset_kind ?? 'native',
          symbol: row.asset_symbol,
          name: row.asset_name ?? row.asset_symbol,
          decimals: row.asset_decimals,
          contractAddress: row.asset_contract,
          iconKey: row.asset_icon,
        }
      : null;

  const token: TokenMoneyDto | null =
    row.raw_amount !== null && asset
      ? {
          assetId: asset.id,
          symbol: asset.symbol,
          decimals: asset.decimals,
          raw: row.raw_amount,
          decimal: TokenAmount.fromRaw(row.raw_amount, {
            assetKey: asset.id,
            symbol: asset.symbol,
            decimals: asset.decimals,
          }).toDecimalString(),
        }
      : null;

  const fee: TokenMoneyDto | null =
    row.fee_raw_amount !== null && row.fee_asset_symbol && row.fee_asset_decimals !== null
      ? {
          assetId: row.fee_asset_id ?? '',
          symbol: row.fee_asset_symbol,
          decimals: row.fee_asset_decimals,
          raw: row.fee_raw_amount,
          decimal: TokenAmount.fromRaw(row.fee_raw_amount, {
            assetKey: row.fee_asset_id ?? '',
            symbol: row.fee_asset_symbol,
            decimals: row.fee_asset_decimals,
          }).toDecimalString(),
        }
      : null;

  const category: CategoryDto | null = row.category_id
    ? toCategoryDto(
        {
          id: row.category_id,
          key: row.category_key,
          name: row.category_name,
          kind: row.category_kind ?? 'both',
          icon: row.category_icon,
          color: row.category_color,
          is_system: row.category_is_system ?? false,
        },
        translate,
      )
    : null;

  return {
    id: row.id,
    kind: row.kind,
    type: row.type,
    direction: row.direction,
    status: row.status,
    source: row.source,
    title: row.title,
    description: row.description,
    notes: row.notes,
    category,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),

    fiat:
      row.fiat_amount_minor !== null && row.fiat_currency
        ? fiatFromMinor(row.fiat_amount_minor, row.fiat_currency)
        : null,
    cashAccountId: row.cash_account_id,

    token,
    asset,
    walletId: row.wallet_id,
    walletName: row.wallet_name,
    network: row.network,
    env: row.env,
    txHash: row.tx_hash,
    counterpartyAddress: row.counterparty_address,
    memo: row.memo,
    confirmations: row.confirmations,
    requiredConfirmations: row.required_confirmations,
    blockNumber: row.block_number,
    fee,
    explorerUrl:
      row.tx_hash && row.network && row.env
        ? transactionUrl(row.network, row.env, row.tx_hash)
        : null,

    valueUsd: fiatFromMinor(row.value_usd_minor, 'USD'),
    valueIls: fiatFromMinor(row.value_ils_minor, 'ILS'),
  };
}

export function toExpectedIncomeDto(
  row: ExpectedIncomeRow,
  extras: { usdMinor: bigint | null; category: CategoryDto | null; today?: Date },
): ExpectedIncomeDto {
  const today = extras.today ?? new Date();
  const expected = new Date(`${row.expected_date}T00:00:00Z`);
  const daysUntil = daysBetween(today, expected);

  return {
    id: row.id,
    name: row.name,
    reason: row.reason,
    amount: toFiatDto(FiatAmount.fromMinor(row.amount_minor, row.currency)),
    amountUsd: extras.usdMinor === null ? null : fiatFromMinor(extras.usdMinor, 'USD'),
    expectedDate: row.expected_date,
    status: row.status,
    remindAt: row.remind_at?.toISOString() ?? null,
    isOverdue: daysUntil < 0 && (row.status === 'pending' || row.status === 'delayed'),
    daysUntil,
    category: extras.category,
    notes: row.notes,
    receivedTransactionId: row.received_transaction_id,
  };
}

export function toScheduledPaymentDto(
  row: ScheduledPaymentRow,
  extras: {
    wallet: WalletRow;
    asset: AssetRow;
    usdMinor: bigint | null;
    executable: boolean;
  },
): ScheduledPaymentDto {
  const amount = tokenAmountFromRow(row.raw_amount, extras.asset);
  return {
    id: row.id,
    title: row.title,
    wallet: {
      id: extras.wallet.id,
      name: extras.wallet.name,
      network: extras.wallet.network,
      env: extras.wallet.env,
    },
    asset: toAssetDto(extras.asset),
    amount: toTokenDto(amount, extras.asset.id),
    amountUsd: extras.usdMinor === null ? null : fiatFromMinor(extras.usdMinor, 'USD'),
    toAddress: row.to_address,
    memo: row.memo,
    scheduledAt: row.scheduled_at.toISOString(),
    status: row.status,
    attempts: row.attempts,
    // Error CODES only. Internal messages never reach a client.
    lastError: row.last_error_code,
    executedTransactionId: row.executed_transaction_id,
    executable: extras.executable,
    createdAt: row.created_at.toISOString(),
  };
}

export function toGoalDto(row: FinancialGoalRow): GoalDto {
  const target = FiatAmount.fromMinor(row.target_minor, row.currency);
  const current = FiatAmount.fromMinor(row.current_minor, row.currency);
  const percent =
    target.minor === 0n
      ? 0
      : clamp(bigintToNumber((current.minor * 100n) / target.minor, 'goal.progress'), 0, 100);

  return {
    id: row.id,
    name: row.name,
    target: toFiatDto(target),
    current: toFiatDto(current),
    progressPercent: percent,
    deadline: row.deadline,
    status: row.status,
    icon: row.icon,
    color: row.color,
    notes: row.notes,
  };
}

export function toExchangeRateDto(
  result: RateResult,
  maxStalenessSeconds: number,
): ExchangeRateDto {
  return {
    base: result.rate.base,
    quote: result.rate.quote,
    rate: result.rate.toDecimalString(4),
    source: result.rate.source,
    updatedAt: result.rate.asOf.toISOString(),
    ageSeconds: result.ageSeconds,
    isStale: result.stale || result.ageSeconds > maxStalenessSeconds,
    isManual: result.isManual,
  };
}

export function networkDisplay(
  network: Parameters<typeof networkLabel>[0],
  env: Parameters<typeof networkLabel>[1],
): string {
  return networkLabel(network, env);
}
