'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import type { WalletDetailDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import { AssetRow } from '@/components/dashboard/AssetRow';
import { Badge, Button, Card, Divider, EmptyState, SkeletonList } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { api } from '@/lib/api';
import { useApiQuery, useMutation } from '@/hooks/useApi';
import { fiat, relativeTime } from '@/lib/format';
import { copyText } from '@/lib/telegram';
import { useApp } from '@/providers/AppProvider';

export default function WalletDetailPage() {
  const params = useParams<{ id: string }>();
  const walletId = params?.id ?? '';
  const { t, locale, toast } = useApp();
  const { data, loading, refetch } = useApiQuery<WalletDetailDto>(
    walletId ? `/api/wallets/${walletId}` : null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  const rescan = useMutation(() => api.post(`/api/wallets/${walletId}/rescan`), {
    successMessage: t('wallets.rescan'),
    onSuccess: () => void refetch(),
  });

  const remove = useMutation(() => api.delete(`/api/wallets/${walletId}`), {
    onSuccess: () => {
      setConfirmDelete(false);
      window.history.back();
    },
  });

  if (loading || !data) {
    return (
      <Screen title={t('wallets.title')} back>
        <SkeletonList rows={4} />
      </Screen>
    );
  }

  return (
    <Screen title={data.name} subtitle={data.network.toUpperCase()} back>
      <div className="space-y-5">
        <Card className="p-5">
          <p className="text-[13px] text-muted">{t('wallets.balances')}</p>
          <p className="numeric mt-1 text-[30px] font-bold text-text">
            <span className="bidi-isolate">{fiat(data.totalUsd, locale)}</span>
          </p>
          <p className="numeric text-[15px] text-muted">
            <span className="bidi-isolate">{fiat(data.totalIls, locale)}</span>
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {data.isWatchOnly ? <Badge>{t('wallets.watchOnly')}</Badge> : null}
            <Badge tone={data.isActive ? 'positive' : 'neutral'}>
              {data.isActive ? t('wallets.active') : t('wallets.inactive')}
            </Badge>
            {data.env === 'testnet' ? <Badge tone="warning">testnet</Badge> : null}
          </div>

          <button
            type="button"
            onClick={() => {
              void copyText(data.address).then((ok) => {
                if (ok) toast(t('common.copied'), 'success');
              });
            }}
            className="mt-4 flex w-full items-center gap-2 rounded-2xl bg-surface-sunken px-3.5 py-3 text-start"
          >
            <span className="numeric min-w-0 flex-1 truncate text-[13px] text-muted" dir="ltr">
              {data.address}
            </span>
            <Icon name="copy" size={16} className="shrink-0 text-link" />
          </button>

          <p className="mt-3 text-[12px] text-subtle">
            {t('wallets.lastScanned')}:{' '}
            {data.lastScannedAt ? relativeTime(data.lastScannedAt, t) : t('wallets.neverScanned')}
          </p>
        </Card>

        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            icon="refresh"
            loading={rescan.pending}
            onClick={() => void rescan.mutate(undefined)}
          >
            {t('wallets.rescan')}
          </Button>
          <Button
            variant="secondary"
            icon="external"
            onClick={() => {
              if (data.explorerUrl) window.open(data.explorerUrl, '_blank', 'noopener,noreferrer');
            }}
          >
            {t('wallets.viewOnExplorer')}
          </Button>
        </div>

        <section>
          <p className="px-1 pb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">
            {t('wallets.balances')}
          </p>
          <Card>
            {data.balances.length > 0 ? (
              data.balances.map((balance, index) => (
                <div key={balance.asset.id}>
                  {index > 0 ? <Divider /> : null}
                  <AssetRow asset={balance.asset} value={balance.value} hidden={false} />
                </div>
              ))
            ) : (
              <EmptyState icon="wallet" title={t('wallets.noBalances')} />
            )}
          </Card>
        </section>

        <Button variant="danger" fullWidth icon="trash" onClick={() => setConfirmDelete(true)}>
          {t('common.delete')}
        </Button>
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
        <p className="pb-4 text-[14px] leading-relaxed text-muted">{t('wallets.deleteConfirm')}</p>
      </Sheet>
    </Screen>
  );
}
