'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import type { TransactionDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import { Button, Card, Divider, SkeletonList, cx } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { api } from '@/lib/api';
import { useApiQuery, useMutation } from '@/hooks/useApi';
import { fiat, formatDateTime, shortenAddress, token } from '@/lib/format';
import { copyText } from '@/lib/telegram';
import { useApp } from '@/providers/AppProvider';

export default function TransactionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const router = useRouter();
  const { t, locale, toast } = useApp();
  const { data, loading } = useApiQuery<TransactionDto>(id ? `/api/transactions/${id}` : null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const remove = useMutation(() => api.delete(`/api/transactions/${id}`), {
    onSuccess: () => {
      setConfirmDelete(false);
      router.replace('/activity');
    },
  });

  if (loading || !data) {
    return (
      <Screen title={t('tx.details')} back>
        <SkeletonList rows={3} />
      </Screen>
    );
  }

  const incoming = data.direction === 'in';
  const amount = data.fiat
    ? fiat(data.fiat, locale, { signDisplay: 'always' })
    : token(data.token, locale, { signDisplay: 'always' });

  return (
    <Screen title={t('tx.details')} back>
      <div className="space-y-4">
        <Card className="p-6 text-center">
          <span
            className={cx(
              'mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full',
              incoming ? 'bg-positive/14 text-positive' : 'bg-negative/12 text-negative',
            )}
            aria-hidden="true"
          >
            <Icon name={incoming ? 'arrow-down' : 'arrow-up'} size={24} />
          </span>
          <p
            className={cx(
              'numeric text-[32px] font-bold',
              incoming ? 'text-positive' : 'text-text',
            )}
          >
            <span className="bidi-isolate">{amount}</span>
          </p>
          <p className="mt-1 text-[15px] text-muted">{data.title}</p>
          {data.valueUsd && data.kind === 'crypto' ? (
            <p className="numeric mt-1 text-[13px] text-subtle">
              <span className="bidi-isolate">
                {fiat(data.valueUsd, locale, { signDisplay: 'never' })}
              </span>
              {' · '}
              {t('tx.valueAtTime')}
            </p>
          ) : null}
        </Card>

        <Card>
          <DetailRow label={t('tx.status')} value={t(`tx.status.${data.status}`)} />
          <Divider />
          <DetailRow label={t('tx.type')} value={t(`tx.type.${data.type}`)} />
          <Divider />
          <DetailRow label={t('tx.date')} value={formatDateTime(data.occurredAt, locale)} />
          {data.category ? (
            <>
              <Divider />
              <DetailRow label={t('tx.category')} value={data.category.name} />
            </>
          ) : null}
          <Divider />
          <DetailRow label={t('common.more')} value={t(`tx.source.${data.source}`)} />
        </Card>

        {data.kind === 'crypto' ? (
          <Card>
            {data.network ? (
              <DetailRow label={t('tx.network')} value={data.network.toUpperCase()} />
            ) : null}
            {data.walletName ? (
              <>
                <Divider />
                <DetailRow label={t('tx.wallet')} value={data.walletName} />
              </>
            ) : null}
            {data.counterpartyAddress ? (
              <>
                <Divider />
                <DetailRow
                  label={incoming ? t('tx.from') : t('tx.to')}
                  value={shortenAddress(data.counterpartyAddress, 10, 8)}
                  onCopy={() => {
                    void copyText(data.counterpartyAddress ?? '').then((ok) => {
                      if (ok) toast(t('common.copied'), 'success');
                    });
                  }}
                />
              </>
            ) : null}
            {data.txHash ? (
              <>
                <Divider />
                <DetailRow
                  label={t('tx.hash')}
                  value={shortenAddress(data.txHash, 10, 8)}
                  onCopy={() => {
                    void copyText(data.txHash ?? '').then((ok) => {
                      if (ok) toast(t('common.copied'), 'success');
                    });
                  }}
                />
              </>
            ) : null}
            {data.confirmations !== null && data.requiredConfirmations ? (
              <>
                <Divider />
                <DetailRow
                  label={t('common.more')}
                  value={t('tx.confirmations', {
                    current: data.confirmations,
                    required: data.requiredConfirmations,
                  })}
                />
              </>
            ) : null}
            {data.fee ? (
              <>
                <Divider />
                <DetailRow label={t('tx.fee')} value={token(data.fee, locale)} />
              </>
            ) : null}
          </Card>
        ) : null}

        {data.notes ? (
          <Card className="p-4">
            <p className="text-[12.5px] font-medium text-muted">{t('tx.notes')}</p>
            <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-text">
              {data.notes}
            </p>
          </Card>
        ) : null}

        {data.explorerUrl ? (
          <Button
            fullWidth
            variant="secondary"
            icon="external"
            onClick={() => window.open(data.explorerUrl ?? '', '_blank', 'noopener,noreferrer')}
          >
            {t('wallets.viewOnExplorer')}
          </Button>
        ) : null}

        {/* Chain-detected rows are immutable: they record something that demonstrably happened. */}
        {data.source !== 'chain' ? (
          <Button variant="danger" fullWidth icon="trash" onClick={() => setConfirmDelete(true)}>
            {t('common.delete')}
          </Button>
        ) : null}
      </div>

      <Sheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('common.delete')}
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={remove.pending}
              onClick={() => void remove.mutate(undefined)}
            >
              {t('common.delete')}
            </Button>
          </div>
        }
      >
        <p className="pb-4 text-[14px] leading-relaxed text-muted">{t('tx.deleteConfirm')}</p>
      </Sheet>
    </Screen>
  );
}

function DetailRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="shrink-0 text-[13.5px] text-muted">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="numeric truncate text-[14px] font-medium text-text">
          <span className="bidi-isolate">{value}</span>
        </span>
        {onCopy ? (
          <button type="button" onClick={onCopy} aria-label="Copy" className="shrink-0 text-link">
            <Icon name="copy" size={15} />
          </button>
        ) : null}
      </span>
    </div>
  );
}
