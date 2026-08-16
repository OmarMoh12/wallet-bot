'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Locale, ThemePreference, UserSettingsDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import {
  Badge,
  Button,
  Card,
  Divider,
  Field,
  Input,
  Segmented,
  SkeletonList,
  cx,
} from '@/components/ui/primitives';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { api } from '@/lib/api';
import { useMutation } from '@/hooks/useApi';
import { useApp } from '@/providers/AppProvider';

/**
 * Settings.
 *
 * Theme and language apply immediately — a preference that needs a save button feels broken
 * on a phone. Each change is a `PATCH` whose response replaces local state, so the UI never
 * shows a value the server did not accept.
 */
export default function SettingsPage() {
  const { t, settings, session, applySettings } = useApp();
  const [pinOpen, setPinOpen] = useState(false);

  const update = useMutation(
    (input: Record<string, unknown>) => api.patch<UserSettingsDto>('/api/settings', input),
    { onSuccess: applySettings },
  );

  if (!settings) {
    return (
      <Screen title={t('settings.title')}>
        <SkeletonList rows={4} />
      </Screen>
    );
  }

  return (
    <Screen title={t('settings.title')}>
      <div className="space-y-5">
        {/* ---------------------------------------------------- appearance -- */}
        <section>
          <p className="px-1 pb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">
            {t('settings.appearance')}
          </p>
          <Card className="p-4 space-y-4">
            <Field label={t('settings.theme')}>
              <Segmented
                ariaLabel={t('settings.theme')}
                value={settings.themePreference}
                onChange={(value: ThemePreference) =>
                  void update.mutate({ themePreference: value })
                }
                options={[
                  { value: 'system', label: t('settings.theme.system') },
                  { value: 'dark', label: t('settings.theme.dark') },
                  { value: 'light', label: t('settings.theme.light') },
                ]}
              />
            </Field>

            <Field label={t('settings.language')}>
              <Segmented
                ariaLabel={t('settings.language')}
                value={settings.locale}
                onChange={(value: Locale) => void update.mutate({ locale: value })}
                options={[
                  { value: 'en', label: t('settings.language.en') },
                  { value: 'ar', label: t('settings.language.ar') },
                ]}
              />
            </Field>
          </Card>
        </section>

        {/* ------------------------------------------------------ currency -- */}
        <section>
          <p className="px-1 pb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">
            {t('settings.currency')}
          </p>
          <Card className="p-4 space-y-4">
            <Field label={t('settings.primaryFiat')}>
              <Segmented
                ariaLabel={t('settings.primaryFiat')}
                value={settings.primaryFiat}
                onChange={(value) => void update.mutate({ primaryFiat: value })}
                options={[
                  { value: 'ILS', label: '₪ ILS' },
                  { value: 'USD', label: '$ USD' },
                ]}
              />
            </Field>

            <Field label={t('settings.fxMode')}>
              <Segmented
                ariaLabel={t('settings.fxMode')}
                value={settings.fxMode}
                onChange={(value) => {
                  // Switching to manual needs a rate; keep the current one if present.
                  if (value === 'manual' && !settings.manualUsdIls) return;
                  void update.mutate({ fxMode: value });
                }}
                options={[
                  { value: 'auto', label: t('settings.fxMode.auto') },
                  { value: 'manual', label: t('settings.fxMode.manual') },
                ]}
              />
            </Field>

            <ManualRateField
              current={settings.manualUsdIls}
              onSave={(rate) => void update.mutate({ fxMode: 'manual', manualUsdIls: rate })}
            />
          </Card>
        </section>

        {/* ------------------------------------------------------ security -- */}
        <section>
          <p className="px-1 pb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">
            {t('settings.security')}
          </p>
          <Card>
            <button
              type="button"
              onClick={() => setPinOpen(true)}
              className="row-press flex w-full items-center gap-3 px-4 py-3.5 text-start"
            >
              <RowIcon name="lock" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] text-text">{t('settings.pin')}</span>
                <span className="block text-[12.5px] text-muted">
                  {settings.pinSet ? t('settings.pinSet') : t('settings.pinNotSet')}
                </span>
              </span>
              {settings.pinSet ? <Badge tone="positive">{t('common.ok')}</Badge> : null}
              <Icon name="chevron" size={16} className="text-subtle rtl:rotate-180" />
            </button>
          </Card>
        </section>

        {/* --------------------------------------------------------- lists -- */}
        <Card>
          <NavRow href="/settings/categories" icon="tag" label={t('categories.title')} />
          <Divider />
          <NavRow href="/settings/goals" icon="target" label={t('goals.title')} />
          <Divider />
          <NavRow href="/settings/notifications" icon="bell" label={t('settings.notifications')} />
          {session?.user.isAdmin ? (
            <>
              <Divider />
              <NavRow href="/settings/admin" icon="settings" label="Admin" />
            </>
          ) : null}
        </Card>

        {/* ----------------------------------------------------------- about -- */}
        <Card className="p-4">
          <p className="text-[12.5px] leading-relaxed text-muted">{t('settings.dataPrivacy')}</p>
          <p className="mt-3 text-[12px] text-subtle">
            {t('settings.version', { version: '1.0.0' })}
            {session?.features.chainEnv === 'testnet' ? ' · testnet' : ''}
            {session?.features.simulatedSending ? ' · simulated sending' : ''}
          </p>
        </Card>
      </div>

      <PinSheet open={pinOpen} onClose={() => setPinOpen(false)} hasPin={settings.pinSet} />
    </Screen>
  );
}

function RowIcon({ name }: { name: IconName }) {
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-raised text-muted"
      aria-hidden="true"
    >
      <Icon name={name} size={17} />
    </span>
  );
}

function NavRow({ href, icon, label }: { href: string; icon: IconName; label: string }) {
  return (
    <Link href={href} className="row-press flex items-center gap-3 px-4 py-3.5">
      <RowIcon name={icon} />
      <span className="flex-1 text-[15px] text-text">{label}</span>
      <Icon name="chevron" size={16} className="text-subtle rtl:rotate-180" />
    </Link>
  );
}

function ManualRateField({
  current,
  onSave,
}: {
  current: string | null;
  onSave: (rate: string) => void;
}) {
  const { t } = useApp();
  const [value, setValue] = useState(current ?? '');

  return (
    <Field label={t('settings.manualRate')} htmlFor="manual-rate">
      <div className="flex gap-2">
        <Input
          id="manual-rate"
          value={value}
          inputMode="decimal"
          dir="ltr"
          className="numeric"
          onChange={(event) => setValue(event.target.value.replace(/[^\d.]/g, ''))}
          placeholder="3.70"
        />
        <Button
          variant="secondary"
          disabled={!/^\d{1,3}(\.\d{1,8})?$/.test(value)}
          onClick={() => onSave(value)}
        >
          {t('common.save')}
        </Button>
      </div>
    </Field>
  );
}

function PinSheet({
  open,
  onClose,
  hasPin,
}: {
  open: boolean;
  onClose: () => void;
  hasPin: boolean;
}) {
  const { t, refreshSettings } = useApp();
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');

  const save = useMutation((input: Record<string, unknown>) => api.post('/api/auth/pin', input), {
    successMessage: t('common.ok'),
    onSuccess: () => {
      setPin('');
      setConfirmPin('');
      setCurrentPin('');
      void refreshSettings();
      onClose();
    },
  });

  const valid =
    /^\d{6}$/.test(pin) && pin === confirmPin && (!hasPin || /^\d{6}$/.test(currentPin));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={hasPin ? t('settings.changePin') : t('settings.setPin')}
      footer={
        <Button
          fullWidth
          size="lg"
          loading={save.pending}
          disabled={!valid}
          onClick={() => void save.mutate({ pin, ...(hasPin ? { currentPin } : {}) })}
        >
          {t('common.save')}
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        {hasPin ? (
          <PinInput label={t('settings.pin')} value={currentPin} onChange={setCurrentPin} />
        ) : null}
        <PinInput label={t('settings.setPin')} value={pin} onChange={setPin} />
        <PinInput label={t('common.confirm')} value={confirmPin} onChange={setConfirmPin} />
        <p className="px-1 text-[12px] leading-relaxed text-muted">{t('send.enterPin')}</p>
      </div>
    </Sheet>
  );
}

function PinInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Input
        value={value}
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        dir="ltr"
        className={cx('numeric text-center tracking-[0.5em]')}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="······"
      />
    </Field>
  );
}
