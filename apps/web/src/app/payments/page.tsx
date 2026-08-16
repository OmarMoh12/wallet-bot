'use client';

import { useState } from 'react';
import type { ExpectedIncomeDto, ScheduledPaymentDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import { AddIncomeSheet } from '@/components/payments/AddIncomeSheet';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  Segmented,
  SkeletonList,
  cx,
} from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { api } from '@/lib/api';
import { useApiQuery, useMutation } from '@/hooks/useApi';
import { fiat, formatDate, formatDateTime, shortenAddress } from '@/lib/format';
import { useApp } from '@/providers/AppProvider';

type Tab = 'income' | 'scheduled';

/**
 * Payments: money expected in, and transfers scheduled out.
 *
 * Grouped on one screen because they answer the same question — "what is going to happen to
 * my money soon?" — and both live in the same mental slot for the person using this.
 */
export default function PaymentsPage() {
  const { t, locale, session } = useApp();
  const [tab, setTab] = useState<Tab>('income');
  const [addingIncome, setAddingIncome] = useState(false);

  const income = useApiQuery<{ items: ExpectedIncomeDto[] }>('/api/expected-income');
  const scheduled = useApiQuery<{ items: ScheduledPaymentDto[] }>('/api/scheduled-payments');

  return (
    <Screen
      title={t('nav.payments')}
      action={
        tab === 'income' ? (
          <Button size="sm" icon="plus" onClick={() => setAddingIncome(true)}>
            {t('common.more')}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <Segmented
          ariaLabel={t('nav.payments')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'income', label: t('income.title') },
            { value: 'scheduled', label: t('schedule.title') },
          ]}
        />

        {tab === 'income' ? (
          income.loading ? (
            <SkeletonList rows={3} />
          ) : income.data && income.data.items.length > 0 ? (
            <Card>
              {income.data.items.map((entry, index) => (
                <div key={entry.id}>
                  {index > 0 ? <Divider /> : null}
                  <IncomeRow entry={entry} onChanged={() => void income.refetch()} />
                </div>
              ))}
            </Card>
          ) : (
            <EmptyState
              icon="clock"
              title={t('income.empty')}
              hint={t('income.emptyHint')}
              action={
                <Button icon="plus" onClick={() => setAddingIncome(true)}>
                  {t('income.add')}
                </Button>
              }
            />
          )
        ) : scheduled.loading ? (
          <SkeletonList rows={3} />
        ) : scheduled.data && scheduled.data.items.length > 0 ? (
          <>
            <Card>
              {scheduled.data.items.map((payment, index) => (
                <div key={payment.id}>
                  {index > 0 ? <Divider /> : null}
                  <ScheduledRow payment={payment} onChanged={() => void scheduled.refetch()} />
                </div>
              ))}
            </Card>
            {!session?.features.sendingEnabled ? (
              <p className="px-2 text-center text-[12px] leading-relaxed text-subtle">
                {t('schedule.disabledNote')}
              </p>
            ) : null}
          </>
        ) : (
          <EmptyState icon="calendar" title={t('schedule.empty')} hint={t('schedule.emptyHint')} />
        )}
      </div>

      <AddIncomeSheet
        open={addingIncome}
        onClose={() => setAddingIncome(false)}
        onCreated={() => {
          setAddingIncome(false);
          void income.refetch();
        }}
      />
    </Screen>
  );

  function IncomeRow({ entry, onChanged }: { entry: ExpectedIncomeDto; onChanged: () => void }) {
    const [open, setOpen] = useState(false);

    const setStatus = useMutation(
      (status: 'received' | 'delayed' | 'cancelled') =>
        api.post(`/api/expected-income/${entry.id}/status`, {
          status,
          createTransaction: status === 'received',
        }),
      {
        onSuccess: () => {
          setOpen(false);
          onChanged();
        },
      },
    );

    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="row-press flex w-full items-center gap-3 px-4 py-3.5 text-start"
        >
          <span
            className={cx(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
              entry.isOverdue ? 'bg-warning/15 text-warning' : 'bg-positive/12 text-positive',
            )}
            aria-hidden="true"
          >
            <Icon name="clock" size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[15px] font-medium text-text">{entry.name}</span>
              {entry.status !== 'pending' ? (
                <Badge tone={entry.status === 'received' ? 'positive' : 'neutral'}>
                  {t(`income.status.${entry.status}`)}
                </Badge>
              ) : null}
            </span>
            <span className="block truncate text-[12.5px] text-muted">
              {formatDate(entry.expectedDate, locale)}
              {entry.isOverdue ? ` · ${t('income.overdue')}` : ''}
            </span>
          </span>
          <span className="numeric shrink-0 text-[15px] font-semibold text-text">
            <span className="bidi-isolate">{fiat(entry.amount, locale)}</span>
          </span>
        </button>

        <Sheet open={open} onClose={() => setOpen(false)} title={entry.name}>
          <div className="space-y-2 pb-4">
            <p className="numeric px-1 pb-2 text-[28px] font-bold text-text">
              <span className="bidi-isolate">{fiat(entry.amount, locale)}</span>
            </p>
            {entry.reason ? (
              <p className="px-1 pb-3 text-[14px] leading-relaxed text-muted">{entry.reason}</p>
            ) : null}

            {entry.status === 'pending' || entry.status === 'delayed' ? (
              <div className="space-y-2">
                <Button
                  fullWidth
                  icon="check"
                  loading={setStatus.pending}
                  onClick={() => void setStatus.mutate('received')}
                >
                  {t('income.markReceived')}
                </Button>
                <Button
                  fullWidth
                  variant="secondary"
                  icon="clock"
                  onClick={() => void setStatus.mutate('delayed')}
                >
                  {t('income.markDelayed')}
                </Button>
                <Button
                  fullWidth
                  variant="danger"
                  icon="close"
                  onClick={() => void setStatus.mutate('cancelled')}
                >
                  {t('income.markCancelled')}
                </Button>
              </div>
            ) : null}
          </div>
        </Sheet>
      </>
    );
  }

  function ScheduledRow({
    payment,
    onChanged,
  }: {
    payment: ScheduledPaymentDto;
    onChanged: () => void;
  }) {
    const [open, setOpen] = useState(false);

    const cancel = useMutation(() => api.delete(`/api/scheduled-payments/${payment.id}`), {
      onSuccess: () => {
        setOpen(false);
        onChanged();
      },
    });

    const tone =
      payment.status === 'failed'
        ? 'negative'
        : payment.status === 'completed'
          ? 'positive'
          : 'neutral';

    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="row-press flex w-full items-center gap-3 px-4 py-3.5 text-start"
        >
          <span
            className={cx(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
              payment.status === 'failed'
                ? 'bg-negative/12 text-negative'
                : 'bg-surface-raised text-muted',
            )}
            aria-hidden="true"
          >
            <Icon name="calendar" size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="numeric block truncate text-[15px] font-medium text-text">
              <span className="bidi-isolate">
                {payment.amount.decimal} {payment.amount.symbol}
              </span>
            </span>
            <span className="numeric block truncate text-[12.5px] text-muted" dir="ltr">
              {shortenAddress(payment.toAddress)}
            </span>
            <span className="block text-[11.5px] text-subtle">
              {formatDateTime(payment.scheduledAt, locale)}
            </span>
          </span>
          <Badge tone={tone}>{t(`schedule.status.${payment.status}`)}</Badge>
        </button>

        <Sheet open={open} onClose={() => setOpen(false)} title={t('schedule.title')}>
          <div className="space-y-3 pb-4">
            <Card>
              <Row
                label={t('send.amount')}
                value={`${payment.amount.decimal} ${payment.amount.symbol}`}
              />
              <Divider />
              <Row label={t('tx.to')} value={payment.toAddress} mono />
              <Divider />
              <Row label={t('schedule.when')} value={formatDateTime(payment.scheduledAt, locale)} />
              <Divider />
              <Row label={t('tx.status')} value={t(`schedule.status.${payment.status}`)} />
              {payment.lastError ? (
                <>
                  <Divider />
                  <Row label={t('schedule.lastError')} value={t(`error.${payment.lastError}`)} />
                </>
              ) : null}
            </Card>

            {payment.status === 'scheduled' || payment.status === 'failed' ? (
              <Button
                fullWidth
                variant="danger"
                icon="close"
                loading={cancel.pending}
                onClick={() => void cancel.mutate(undefined)}
              >
                {t('schedule.cancel')}
              </Button>
            ) : null}
          </div>
        </Sheet>
      </>
    );
  }
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <span className="shrink-0 text-[13.5px] text-muted">{label}</span>
      <span
        className={cx(
          'min-w-0 break-all text-end text-[14px] text-text',
          mono && 'numeric text-[12.5px]',
        )}
        dir={mono ? 'ltr' : undefined}
      >
        {value}
      </span>
    </div>
  );
}
