'use client';

import { useState } from 'react';
import type { ExpectedIncomeDto, FiatCurrency } from '@wallet/shared';
import { Sheet } from '@/components/ui/Sheet';
import { AmountInput, Button, Field, Input, Segmented } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useMutation } from '@/hooks/useApi';
import { useApp } from '@/providers/AppProvider';

/** Record money you are waiting for, so the bot can remind you when it is due. */
export function AddIncomeSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t, settings } = useApp();
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<FiatCurrency>(settings?.primaryFiat ?? 'ILS');
  const [expectedDate, setExpectedDate] = useState(() => new Date().toISOString().slice(0, 10));

  const create = useMutation(
    (input: Record<string, unknown>) => api.post<ExpectedIncomeDto>('/api/expected-income', input),
    {
      onSuccess: () => {
        setName('');
        setReason('');
        setAmount('');
        onCreated();
      },
    },
  );

  const valid = name.trim().length > 0 && /^\d+(\.\d{1,2})?$/.test(amount) && /[1-9]/.test(amount);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('income.add')}
      footer={
        <Button
          fullWidth
          size="lg"
          loading={create.pending}
          disabled={!valid}
          onClick={() =>
            void create.mutate({
              name: name.trim(),
              ...(reason.trim() ? { reason: reason.trim() } : {}),
              amount,
              currency,
              expectedDate,
            })
          }
        >
          {t('common.save')}
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        <Field label={t('income.name')} htmlFor="income-name" required>
          <Input
            id="income-name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="Client Payment"
          />
        </Field>

        <Field label={t('income.amount')} htmlFor="income-amount" required>
          <div className="flex items-center gap-2">
            <AmountInput
              id="income-amount"
              value={amount}
              dir="ltr"
              onChange={(event) => {
                const next = event.target.value.replace(/[^\d.]/g, '');
                const parts = next.split('.');
                setAmount(parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : next);
              }}
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

        <Field label={t('income.expectedDate')} htmlFor="income-date" required>
          <Input
            id="income-date"
            type="date"
            value={expectedDate}
            onChange={(event) => setExpectedDate(event.target.value)}
          />
        </Field>

        <Field label={t('income.reason')} htmlFor="income-reason">
          <Input
            id="income-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Website project"
          />
        </Field>
      </div>
    </Sheet>
  );
}
