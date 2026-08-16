'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { WalletDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import { AddWalletSheet } from '@/components/wallets/AddWalletSheet';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  SkeletonList,
  cx,
} from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { useApiQuery } from '@/hooks/useApi';
import { relativeTime, shortenAddress } from '@/lib/format';
import { useApp } from '@/providers/AppProvider';

export default function WalletsPage() {
  const { t } = useApp();
  const { data, loading, refetch } = useApiQuery<WalletDto[]>('/api/wallets');
  const [adding, setAdding] = useState(false);

  return (
    <Screen
      title={t('wallets.title')}
      action={
        <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
          {t('wallets.add')}
        </Button>
      }
    >
      {loading ? (
        <SkeletonList rows={3} />
      ) : data && data.length > 0 ? (
        <Card>
          {data.map((wallet, index) => (
            <div key={wallet.id}>
              {index > 0 ? <Divider /> : null}
              <WalletRow wallet={wallet} />
            </div>
          ))}
        </Card>
      ) : (
        <EmptyState
          icon="wallet"
          title={t('wallets.empty')}
          hint={t('wallets.emptyHint')}
          action={
            <Button icon="plus" onClick={() => setAdding(true)}>
              {t('wallets.add')}
            </Button>
          }
        />
      )}

      {/* Stated on the list screen, not buried in a form: this app never wants a seed phrase. */}
      <p className="mt-5 px-2 text-center text-[12px] leading-relaxed text-subtle">
        {t('wallets.addressHelp')}
      </p>

      <AddWalletSheet
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={() => {
          setAdding(false);
          void refetch();
        }}
      />
    </Screen>
  );
}

/** One tone per network, so a glance down the list distinguishes them without reading. */
const NETWORK_TONE: Partial<Record<WalletDto['network'], string>> = {
  tron: 'bg-negative/12 text-negative',
  ton: 'bg-accent/14 text-accent',
  bsc: 'bg-warning/15 text-warning',
};

function WalletRow({ wallet }: { wallet: WalletDto }) {
  const { t } = useApp();

  const state =
    wallet.scanState === 'degraded'
      ? { tone: 'warning' as const, label: t('wallets.scanDegraded') }
      : wallet.scanState === 'never_scanned'
        ? { tone: 'neutral' as const, label: t('wallets.neverScanned') }
        : null;

  return (
    <Link href={`/wallets/${wallet.id}`} className="row-press flex items-center gap-3 px-4 py-3.5">
      <span
        className={cx(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-full',
          NETWORK_TONE[wallet.network] ?? 'bg-accent/14 text-accent',
        )}
        aria-hidden="true"
      >
        <Icon name="wallet" size={20} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[15px] font-semibold text-text">{wallet.name}</p>
          {wallet.isWatchOnly ? (
            <Badge>{t('wallets.watchOnly')}</Badge>
          ) : (
            <Badge tone="accent">{t('wallets.managed')}</Badge>
          )}
        </div>
        <p className="numeric truncate text-[12.5px] text-muted">
          <span className="bidi-isolate">{shortenAddress(wallet.address, 8, 6)}</span>
        </p>
        <p className="mt-0.5 text-[11.5px] text-subtle">
          {wallet.network.toUpperCase()}
          {wallet.env === 'testnet' ? ' · testnet' : ''}
          {wallet.lastScannedAt ? ` · ${relativeTime(wallet.lastScannedAt, t)}` : ''}
        </p>
      </div>

      {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
      <Icon name="chevron" size={16} className="shrink-0 text-subtle rtl:rotate-180" />
    </Link>
  );
}
