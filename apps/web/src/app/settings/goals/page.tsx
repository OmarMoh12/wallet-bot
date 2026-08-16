'use client';

import { useState } from 'react';
import type { FiatCurrency, GoalDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import { Sheet } from '@/components/ui/Sheet';
import {
  AmountInput,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Segmented,
  SkeletonList,
} from '@/components/ui/primitives';
import { api, newIdempotencyKey } from '@/lib/api';
import { useApiQuery, useMutation } from '@/hooks/useApi';
import { fiat } from '@/lib/format';
import { useApp } from '@/providers/AppProvider';

export default function GoalsPage() {
  const { t, locale, settings } = useApp();
  const { data, loading, refetch } = useApiQuery<{ items: GoalDto[] }>('/api/goals');
  const [adding, setAdding] = useState(false);
  const [contributing, setContributing] = useState<GoalDto | null>(null);

  return (
    <Screen
      title={t('goals.title')}
      back
      action={
        <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
          {t('goals.add')}
        </Button>
      }
    >
      {loading ? (
        <SkeletonList rows={2} />
      ) : data && data.items.length > 0 ? (
        <div className="space-y-3">
          {data.items.map((goal) => (
            <Card key={goal.id} className="p-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="truncate text-[16px] font-semibold text-text">{goal.name}</p>
                <p className="numeric shrink-0 text-[13px] text-muted">
                  <span className="bidi-isolate">
                    {t('goals.progress', { percent: goal.progressPercent })}
                  </span>
                </p>
              </div>

              <div
                className="mt-3 h-2.5 overflow-hidden rounded-full bg-surface-sunken"
                role="progressbar"
                aria-valuenow={goal.progressPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={goal.name}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{
                    width: `${goal.progressPercent}%`,
                    background: goal.color ?? 'var(--color-accent)',
                  }}
                />
              </div>

              <div className="mt-3 flex items-center justify-between">
                <p className="numeric text-[13.5px] text-muted">
                  <span className="bidi-isolate">
                    {fiat(goal.current, locale)} / {fiat(goal.target, locale)}
                  </span>
                </p>
                <Button size="sm" variant="secondary" onClick={() => setContributing(goal)}>
                  {t('goals.contribute')}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="target"
          title={t('goals.empty')}
          hint={t('goals.emptyHint')}
          action={
            <Button icon="plus" onClick={() => setAdding(true)}>
              {t('goals.add')}
            </Button>
          }
        />
      )}

      <AddGoalSheet
        open={adding}
        onClose={() => setAdding(false)}
        defaultCurrency={settings?.primaryFiat ?? 'ILS'}
        onCreated={() => {
          setAdding(false);
          void refetch();
        }}
      />

      <ContributeSheet
        goal={contributing}
        onClose={() => setContributing(null)}
        onDone={() => {
          setContributing(null);
          void refetch();
        }}
      />
    </Screen>
  );
}

function AddGoalSheet({
  open,
  onClose,
  onCreated,
  defaultCurrency,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  defaultCurrency: FiatCurrency;
}) {
  const { t } = useApp();
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [currency, setCurrency] = useState<FiatCurrency>(defaultCurrency);

  const create = useMutation(
    (input: Record<string, unknown>) => api.post<GoalDto>('/api/goals', input),
    {
      onSuccess: () => {
        setName('');
        setTarget('');
        onCreated();
      },
    },
  );

  const valid = name.trim().length > 0 && /^\d+(\.\d{1,2})?$/.test(target) && /[1-9]/.test(target);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('goals.add')}
      footer={
        <Button
          fullWidth
          size="lg"
          loading={create.pending}
          disabled={!valid}
          onClick={() => void create.mutate({ name: name.trim(), targetAmount: target, currency })}
        >
          {t('common.save')}
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        <Field label={t('goals.title')} htmlFor="goal-name" required>
          <Input
            id="goal-name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="New PC"
          />
        </Field>
        <Field label={t('goals.target')} htmlFor="goal-target" required>
          <div className="flex items-center gap-2">
            <AmountInput
              id="goal-target"
              value={target}
              dir="ltr"
              onChange={(event) => setTarget(event.target.value.replace(/[^\d.]/g, ''))}
              placeholder="0.00"
            />
            <div className="w-24 shrink-0">
              <Segmented
                ariaLabel={t('settings.currency')}
                value={currency}
                onChange={setCurrency}
                options={[
                  { value: 'ILS', label: '₪' },
                  { value: 'USD', label: '$' },
                ]}
              />
            </div>
          </div>
        </Field>
      </div>
    </Sheet>
  );
}

function ContributeSheet({
  goal,
  onClose,
  onDone,
}: {
  goal: GoalDto | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useApp();
  const [amount, setAmount] = useState('');

  const contribute = useMutation(
    (input: { id: string; amount: string }) =>
      api.post<GoalDto>(`/api/goals/${input.id}/contribute`, {
        amount: input.amount,
        idempotencyKey: newIdempotencyKey('goal'),
      }),
    {
      onSuccess: () => {
        setAmount('');
        onDone();
      },
    },
  );

  return (
    <Sheet
      open={Boolean(goal)}
      onClose={onClose}
      title={goal?.name ?? ''}
      footer={
        <Button
          fullWidth
          size="lg"
          loading={contribute.pending}
          disabled={!goal || !/^\d+(\.\d{1,2})?$/.test(amount) || !/[1-9]/.test(amount)}
          onClick={() => {
            if (goal) void contribute.mutate({ id: goal.id, amount });
          }}
        >
          {t('goals.contribute')}
        </Button>
      }
    >
      <div className="pb-2">
        <Field label={t('goals.contribute')} htmlFor="contribute-amount">
          <AmountInput
            id="contribute-amount"
            value={amount}
            dir="ltr"
            onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0.00"
          />
        </Field>
      </div>
    </Sheet>
  );
}
