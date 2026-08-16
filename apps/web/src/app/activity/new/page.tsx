'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CategoryDto, FiatCurrency, TransactionDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import {
  AmountInput,
  Button,
  Card,
  Field,
  Input,
  Segmented,
  TextArea,
  cx,
} from '@/components/ui/primitives';
import { api, newIdempotencyKey } from '@/lib/api';
import { useApiQuery, useMutation } from '@/hooks/useApi';
import { useApp } from '@/providers/AppProvider';

type Kind = 'income' | 'expense';

/**
 * Record a cash transaction.
 *
 * The amount is kept as a **string** end to end — typed, transmitted and parsed exactly.
 * It is never put through `parseFloat`, which is what makes "0.1 + 0.2" problems impossible
 * here rather than merely unlikely.
 */
export default function NewTransactionPage() {
  const router = useRouter();
  const { t, settings, toast } = useApp();

  const [kind, setKind] = useState<Kind>('expense');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<FiatCurrency>(settings?.primaryFiat ?? 'ILS');
  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  // Generated once per form instance, so a double submit is one transaction.
  const [idempotencyKey] = useState(() => newIdempotencyKey('tx'));

  const { data: categories } = useApiQuery<{ items: CategoryDto[] }>('/api/categories');

  const create = useMutation(
    (input: Record<string, unknown>) => api.post<TransactionDto>('/api/transactions', input),
    {
      onSuccess: () => {
        toast(t('common.ok'), 'success');
        router.replace('/activity');
      },
    },
  );

  const valid = /^\d+(\.\d{1,2})?$/.test(amount) && /[1-9]/.test(amount) && title.trim().length > 0;

  const relevantCategories = (categories?.items ?? []).filter(
    (category) => category.kind === 'both' || category.kind === kind,
  );

  return (
    <Screen title={t('tx.add')} back>
      <div className="space-y-4">
        <Segmented
          ariaLabel={t('tx.type')}
          value={kind}
          onChange={(value) => {
            setKind(value);
            setCategoryId(null);
          }}
          options={[
            { value: 'expense', label: t('tx.addExpense') },
            { value: 'income', label: t('tx.addIncome') },
          ]}
        />

        <Card className="p-4">
          <Field label={t('tx.amount')} htmlFor="amount" required>
            <div className="flex items-center gap-2">
              <AmountInput
                id="amount"
                value={amount}
                onChange={(event) => {
                  // Only digits and one decimal point ever enter state.
                  const next = event.target.value.replace(/[^\d.]/g, '');
                  const parts = next.split('.');
                  setAmount(parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : next);
                }}
                placeholder="0.00"
                dir="ltr"
                aria-describedby="amount-currency"
              />
              <div id="amount-currency" className="w-24 shrink-0">
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
        </Card>

        <Field label={t('tx.description')} htmlFor="title" required>
          <Input
            id="title"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={kind === 'income' ? 'Payment for project' : 'Dinner'}
          />
        </Field>

        <Field label={t('tx.category')}>
          <div className="flex flex-wrap gap-2">
            {relevantCategories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => setCategoryId(categoryId === category.id ? null : category.id)}
                aria-pressed={categoryId === category.id}
                className={cx(
                  'rounded-full border px-3.5 py-2 text-[13px] font-medium transition-colors',
                  categoryId === category.id
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-border bg-surface text-muted',
                )}
              >
                {category.name}
              </button>
            ))}
          </div>
        </Field>

        <Field label={t('tx.notes')} htmlFor="notes">
          <TextArea
            id="notes"
            value={notes}
            maxLength={2000}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>

        <Button
          fullWidth
          size="lg"
          loading={create.pending}
          disabled={!valid}
          onClick={() =>
            void create.mutate({
              type: kind,
              amount,
              currency,
              title: title.trim(),
              ...(categoryId ? { categoryId } : {}),
              ...(notes.trim() ? { notes: notes.trim() } : {}),
              idempotencyKey,
            })
          }
        >
          {t('common.save')}
        </Button>
      </div>
    </Screen>
  );
}
