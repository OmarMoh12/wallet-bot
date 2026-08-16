'use client';

import { useState } from 'react';
import { isEvmNetwork, type Network, type WalletDto } from '@wallet/shared';
import { Sheet } from '@/components/ui/Sheet';
import { Icon } from '@/components/ui/Icon';
import { Button, Field, Input, Segmented, cx } from '@/components/ui/primitives';
import { api, newIdempotencyKey } from '@/lib/api';
import { useMutation } from '@/hooks/useApi';
import { useApp } from '@/providers/AppProvider';

/**
 * Add a wallet.
 *
 * Two modes, and the distinction matters enough to be the first choice on the screen:
 *
 *   * **Track an existing address** — watch-only. Paste a public address; nothing can be
 *     sent from it. This is the default and covers every network.
 *   * **Create a wallet** — EVM only. The signing service generates a keypair, keeps the
 *     private key encrypted, and returns only the address. The key is never displayed here,
 *     never returned by the API, and never written to the database.
 *
 * The copy is explicit about that, because a user who expects to be shown a seed phrase and
 * is not shown one should understand why rather than assume something failed.
 */

type Mode = 'track' | 'create';

const NETWORKS: Array<{ value: Network; label: string }> = [
  { value: 'tron', label: 'TRON' },
  { value: 'ton', label: 'TON' },
  { value: 'bsc', label: 'BSC' },
];

const PLACEHOLDERS: Record<Network, string> = {
  tron: 'T…',
  ton: 'UQ…',
  bsc: '0x…',
};

const DEFAULT_NAMES: Record<Network, string> = {
  tron: 'Personal TRON Wallet',
  ton: 'Personal TON Wallet',
  bsc: 'Personal BSC Wallet',
};

export function AddWalletSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (wallet: WalletDto) => void;
}) {
  const { t } = useApp();
  const [mode, setMode] = useState<Mode>('track');
  const [network, setNetwork] = useState<Network>('tron');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  // One key per sheet instance, so a double tap cannot generate two funded addresses.
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey('wallet'));

  const reset = (): void => {
    setName('');
    setAddress('');
    setIdempotencyKey(newIdempotencyKey('wallet'));
  };

  const track = useMutation<{ name: string; network: Network; address: string }, WalletDto>(
    (input) => api.post<WalletDto>('/api/wallets', input),
    {
      onSuccess: (wallet) => {
        reset();
        onCreated(wallet);
      },
    },
  );

  const create = useMutation<{ name: string; network: 'bsc'; idempotencyKey: string }, WalletDto>(
    (input) => api.post<WalletDto>('/api/wallets/generate', input),
    {
      onSuccess: (wallet) => {
        reset();
        onCreated(wallet);
      },
    },
  );

  const error = mode === 'track' ? track.error : create.error;
  const pending = mode === 'track' ? track.pending : create.pending;

  const addressError =
    error?.code === 'INVALID_ADDRESS'
      ? t('error.INVALID_ADDRESS')
      : error?.code === 'ADDRESS_NETWORK_MISMATCH'
        ? t('error.ADDRESS_NETWORK_MISMATCH')
        : error?.code === 'WALLET_ALREADY_EXISTS'
          ? t('error.WALLET_ALREADY_EXISTS')
          : undefined;

  // Creating a key is only meaningful on EVM chains; the others are provisioned out of band.
  const canCreate = isEvmNetwork(network);
  const effectiveMode: Mode = canCreate ? mode : 'track';

  const valid =
    name.trim().length > 0 && (effectiveMode === 'create' ? canCreate : address.trim().length > 0);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={effectiveMode === 'create' ? t('wallets.generate') : t('wallets.add')}
      footer={
        <Button
          fullWidth
          size="lg"
          loading={pending}
          disabled={!valid}
          onClick={() => {
            if (effectiveMode === 'create') {
              void create.mutate({ name: name.trim(), network: 'bsc', idempotencyKey });
            } else {
              void track.mutate({ name: name.trim(), network, address: address.trim() });
            }
          }}
        >
          {effectiveMode === 'create' ? t('wallets.generateConfirm') : t('common.save')}
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        <Field label={t('wallets.network')}>
          <Segmented
            ariaLabel={t('wallets.network')}
            value={network}
            onChange={(value) => {
              setNetwork(value);
              // A non-EVM network has no creation path; fall back rather than leaving a
              // disabled-looking button the user cannot explain.
              if (!isEvmNetwork(value)) setMode('track');
            }}
            options={NETWORKS}
          />
        </Field>

        {canCreate ? (
          <Segmented
            ariaLabel={t('wallets.add')}
            value={effectiveMode}
            onChange={setMode}
            options={[
              { value: 'track', label: t('wallets.addExisting') },
              { value: 'create', label: t('wallets.generate') },
            ]}
          />
        ) : null}

        <Field label={t('wallets.name')} htmlFor="wallet-name" required>
          <Input
            id="wallet-name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder={DEFAULT_NAMES[network]}
          />
        </Field>

        {effectiveMode === 'track' ? (
          <Field
            label={t('wallets.address')}
            htmlFor="wallet-address"
            required
            hint={t('wallets.addressHelp')}
            {...(addressError ? { error: addressError } : {})}
          >
            <Input
              id="wallet-address"
              value={address}
              maxLength={120}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              dir="ltr"
              className="numeric text-[14px]"
              onChange={(event) => setAddress(event.target.value)}
              placeholder={PLACEHOLDERS[network]}
            />
          </Field>
        ) : (
          <div
            className={cx(
              'flex items-start gap-2.5 rounded-2xl border border-accent/25 bg-accent/8',
              'px-4 py-3.5 text-[13px] leading-relaxed text-muted',
            )}
          >
            <Icon name="lock" size={17} className="mt-px shrink-0 text-accent" />
            <span>{t('wallets.generateHint')}</span>
          </div>
        )}

        {network === 'bsc' ? (
          <p className="px-1 text-[12px] leading-relaxed text-subtle">
            {t('wallets.gasNote', { network: 'BNB Smart Chain', symbol: 'BNB' })}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
