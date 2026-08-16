'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AssetDto, SendQuoteDto, SendResultDto, WalletDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import {
  AmountInput,
  Button,
  Card,
  Divider,
  EmptyState,
  Field,
  Input,
  cx,
} from '@/components/ui/primitives';
import { Icon, AssetGlyph } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { api, newIdempotencyKey } from '@/lib/api';
import { useApiQuery, useMutation } from '@/hooks/useApi';
import { fiat, token } from '@/lib/format';
import { useApp } from '@/providers/AppProvider';

/**
 * Send.
 *
 * A two-phase flow that mirrors the server: quote, then confirm. The confirmation sheet
 * shows exactly what will happen and echoes the quote fingerprint back, so the numbers the
 * user approved are provably the numbers that get executed.
 *
 * When sending is disabled — the default for this deployment — the screen says so plainly
 * instead of failing at the last step.
 */
export default function SendPage() {
  const router = useRouter();
  const { t, locale, session } = useApp();

  const sendingEnabled = session?.features.sendingEnabled ?? false;
  const simulated = session?.features.simulatedSending ?? true;

  const [walletId, setWalletId] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [pin, setPin] = useState('');
  const [quote, setQuote] = useState<SendQuoteDto | null>(null);
  const [result, setResult] = useState<SendResultDto | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey('send'));

  const { data: wallets } = useApiQuery<WalletDto[]>('/api/wallets');
  const { data: assets } = useApiQuery<{ items: AssetDto[] }>(
    walletId ? '/api/assets' : null,
    walletId ? { walletId } : undefined,
  );

  useEffect(() => {
    if (!walletId && wallets && wallets.length > 0) setWalletId(wallets[0]?.id ?? null);
  }, [wallets, walletId]);

  useEffect(() => {
    if (assets && assets.items.length > 0 && !assets.items.some((asset) => asset.id === assetId)) {
      setAssetId(assets.items[0]?.id ?? null);
    }
  }, [assets, assetId]);

  const requestQuote = useMutation(
    (input: Record<string, unknown>) => api.post<SendQuoteDto>('/api/send/quote', input),
    { onSuccess: setQuote },
  );

  const confirm = useMutation(
    (input: Record<string, unknown>) => api.post<SendResultDto>('/api/send/confirm', input),
    {
      onSuccess: (value) => {
        setResult(value);
        setQuote(null);
        // A fresh key for the next transfer; the old one is spent.
        setIdempotencyKey(newIdempotencyKey('send'));
      },
    },
  );

  if (!sendingEnabled) {
    return (
      <Screen title={t('send.title')} back>
        <EmptyState
          icon="lock"
          title={t('send.disabled')}
          hint={t('send.disabledHint')}
          action={
            <Button variant="secondary" onClick={() => router.push('/receive')}>
              {t('receive.title')}
            </Button>
          }
        />
      </Screen>
    );
  }

  if (!wallets || wallets.length === 0) {
    return (
      <Screen title={t('send.title')} back>
        <EmptyState icon="wallet" title={t('wallets.empty')} hint={t('wallets.emptyHint')} />
      </Screen>
    );
  }

  const valid =
    Boolean(walletId) &&
    Boolean(assetId) &&
    toAddress.trim().length >= 20 &&
    /^\d+(\.\d+)?$/.test(amount) &&
    /[1-9]/.test(amount);

  return (
    <Screen title={t('send.title')} back>
      <div className="space-y-4">
        {simulated ? (
          <div className="flex items-start gap-2 rounded-2xl border border-warning/25 bg-warning/10 px-4 py-3 text-[13px] text-warning">
            <Icon name="info" size={16} className="mt-px shrink-0" />
            <span>{t('send.simulated')}</span>
          </div>
        ) : null}

        <Field label={t('send.selectWallet')}>
          <Card>
            {wallets.map((wallet, index) => (
              <button
                key={wallet.id}
                type="button"
                onClick={() => setWalletId(wallet.id)}
                className={cx(
                  'row-press flex w-full items-center gap-3 px-4 py-3 text-start',
                  index > 0 && 'border-t border-border',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium text-text">
                    {wallet.name}
                  </span>
                  <span className="block text-[12px] text-muted">
                    {wallet.network.toUpperCase()}
                  </span>
                </span>
                {walletId === wallet.id ? (
                  <Icon name="check" size={18} className="text-accent" />
                ) : null}
              </button>
            ))}
          </Card>
        </Field>

        {assets && assets.items.length > 0 ? (
          <Field label={t('send.selectAsset')}>
            <div className="flex flex-wrap gap-2">
              {assets.items.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => setAssetId(asset.id)}
                  aria-pressed={assetId === asset.id}
                  className={cx(
                    'flex items-center gap-2 rounded-full border px-3 py-2 text-[13px] font-medium',
                    assetId === asset.id
                      ? 'border-accent bg-accent/12 text-accent'
                      : 'border-border bg-surface text-muted',
                  )}
                >
                  <AssetGlyph symbol={asset.symbol} size={20} />
                  {asset.symbol}
                </button>
              ))}
            </div>
          </Field>
        ) : null}

        <Field label={t('send.recipient')} htmlFor="to" required>
          <Input
            id="to"
            value={toAddress}
            onChange={(event) => setToAddress(event.target.value.trim())}
            dir="ltr"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="numeric text-[14px]"
            placeholder="T… / UQ…"
          />
        </Field>

        <Field label={t('send.amount')} htmlFor="send-amount" required>
          <AmountInput
            id="send-amount"
            value={amount}
            dir="ltr"
            onChange={(event) => {
              const next = event.target.value.replace(/[^\d.]/g, '');
              const parts = next.split('.');
              setAmount(parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : next);
            }}
            placeholder="0.00"
          />
        </Field>

        <Field label={t('send.memo')} htmlFor="memo" hint={t('send.memoHint')}>
          <Input
            id="memo"
            value={memo}
            maxLength={120}
            onChange={(event) => setMemo(event.target.value)}
          />
        </Field>

        <Button
          fullWidth
          size="lg"
          loading={requestQuote.pending}
          disabled={!valid}
          onClick={() =>
            void requestQuote.mutate({
              walletId,
              assetId,
              toAddress: toAddress.trim(),
              amount,
              ...(memo.trim() ? { memo: memo.trim() } : {}),
              idempotencyKey,
            })
          }
        >
          {t('send.review')}
        </Button>
      </div>

      {/* ------------------------------------------------- confirmation -- */}
      <Sheet
        open={Boolean(quote)}
        onClose={() => setQuote(null)}
        title={t('send.confirmTitle')}
        dismissible={!confirm.pending}
        footer={
          <Button
            fullWidth
            size="lg"
            loading={confirm.pending}
            disabled={pin.length !== 6}
            onClick={() => {
              if (!quote) return;
              void confirm.mutate({
                sendRequestId: quote.sendRequestId,
                quoteFingerprint: quote.fingerprint,
                pin,
              });
            }}
          >
            {t('common.confirm')}
          </Button>
        }
      >
        {quote ? (
          <div className="space-y-3 pb-2">
            <Card>
              <ConfirmRow label={t('tx.network')} value={quote.wallet.network.toUpperCase()} />
              <Divider />
              <ConfirmRow label={t('send.selectAsset')} value={quote.asset.symbol} />
              <Divider />
              <ConfirmRow label={t('send.amount')} value={token(quote.amount, locale)} strong />
              <Divider />
              <ConfirmRow label={t('tx.to')} value={quote.toAddress} mono />
              <Divider />
              <ConfirmRow
                label={t('send.estimatedFee')}
                value={quote.estimatedFee ? token(quote.estimatedFee, locale) : '—'}
              />
              <Divider />
              <ConfirmRow
                label={t('send.total')}
                value={`${token(quote.total, locale)}${
                  quote.amountUsd ? ` · ${fiat(quote.amountUsd, locale)}` : ''
                }`}
                strong
              />
            </Card>

            {quote.warnings.map((warning) => (
              <div
                key={warning}
                className="flex items-start gap-2 rounded-2xl border border-warning/25 bg-warning/10 px-3.5 py-2.5 text-[12.5px] leading-snug text-warning"
              >
                <Icon name="warning" size={15} className="mt-px shrink-0" />
                <span>{t(warning, { network: quote.wallet.network.toUpperCase() })}</span>
              </div>
            ))}

            <Field label={t('send.enterPin')} htmlFor="pin">
              <Input
                id="pin"
                value={pin}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                dir="ltr"
                className="numeric text-center tracking-[0.5em]"
                onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="······"
              />
            </Field>
          </div>
        ) : null}
      </Sheet>

      {/* -------------------------------------------------------- result -- */}
      <Sheet open={Boolean(result)} onClose={() => setResult(null)} title={t('send.success')}>
        {result ? (
          <div className="space-y-4 pb-4 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-positive/15 text-positive">
              <Icon name="check" size={26} />
            </span>
            <p className="text-[14px] leading-relaxed text-muted">{t('send.successHint')}</p>
            {result.simulated ? (
              <p className="text-[13px] text-warning">{t('send.simulated')}</p>
            ) : null}
            {result.explorerUrl ? (
              <Button
                variant="secondary"
                icon="external"
                onClick={() =>
                  window.open(result.explorerUrl ?? '', '_blank', 'noopener,noreferrer')
                }
              >
                {t('wallets.viewOnExplorer')}
              </Button>
            ) : null}
            <Button fullWidth onClick={() => router.push('/activity')}>
              {t('common.ok')}
            </Button>
          </div>
        ) : null}
      </Sheet>
    </Screen>
  );
}

function ConfirmRow({
  label,
  value,
  strong,
  mono,
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <span className="shrink-0 text-[13.5px] text-muted">{label}</span>
      <span
        className={cx(
          'min-w-0 break-all text-end text-[14px]',
          strong ? 'font-semibold text-text' : 'text-text',
          mono && 'numeric text-[12.5px]',
        )}
        dir={mono ? 'ltr' : undefined}
      >
        {value}
      </span>
    </div>
  );
}
