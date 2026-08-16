'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { Page, TransactionDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import { TransactionRow } from '@/components/transactions/TransactionRow';
import {
  Button,
  Card,
  Chip,
  ChipRow,
  Divider,
  EmptyState,
  Input,
  SkeletonList,
} from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { useApiQuery } from '@/hooks/useApi';
import { dayLabel } from '@/lib/format';
import { useApp } from '@/providers/AppProvider';

type Filter = 'all' | 'income' | 'expense' | 'crypto' | 'cash';

/**
 * Transaction history.
 *
 * Filters map to server-side query parameters — with keyset pagination the filtering has to
 * happen in the database, not in a client-side `.filter()` over one page.
 */
export default function ActivityPage() {
  const { t, locale } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  // Debounce so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useMemo(() => {
    const params: Record<string, string> = { limit: '40' };
    if (filter === 'income') params.direction = 'in';
    if (filter === 'expense') params.direction = 'out';
    if (filter === 'crypto') params.kind = 'crypto';
    if (filter === 'cash') params.kind = 'cash';
    if (debounced.length >= 2) params.search = debounced;
    return params;
  }, [filter, debounced]);

  const { data, loading } = useApiQuery<Page<TransactionDto>>('/api/transactions', query);

  const grouped = useMemo(() => {
    const groups = new Map<string, TransactionDto[]>();
    for (const item of data?.items ?? []) {
      const key = item.occurredAt.slice(0, 10);
      const bucket = groups.get(key);
      if (bucket) bucket.push(item);
      else groups.set(key, [item]);
    }
    return [...groups.entries()];
  }, [data]);

  return (
    <Screen
      title={t('tx.title')}
      action={
        <Link href="/activity/new">
          <Button size="sm" icon="plus">
            {t('tx.add')}
          </Button>
        </Link>
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <Icon
            name="search"
            size={17}
            className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-subtle"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('tx.searchPlaceholder')}
            className="ps-10"
            inputMode="search"
            aria-label={t('common.search')}
          />
        </div>

        <ChipRow>
          {(
            [
              ['all', 'tx.filter.all'],
              ['income', 'tx.filter.income'],
              ['expense', 'tx.filter.expense'],
              ['crypto', 'tx.filter.crypto'],
              ['cash', 'tx.filter.cash'],
            ] as Array<[Filter, string]>
          ).map(([value, key]) => (
            <Chip key={value} active={filter === value} onClick={() => setFilter(value)}>
              {t(key)}
            </Chip>
          ))}
        </ChipRow>

        {loading ? (
          <SkeletonList rows={5} />
        ) : grouped.length > 0 ? (
          <div className="space-y-4">
            {grouped.map(([day, items]) => (
              <section key={day}>
                <h2 className="px-1 pb-1.5 text-[12.5px] font-medium text-muted">
                  {dayLabel(`${day}T00:00:00Z`, locale, t)}
                </h2>
                <Card>
                  {items.map((transaction, index) => (
                    <div key={transaction.id}>
                      {index > 0 ? <Divider /> : null}
                      <TransactionRow transaction={transaction} />
                    </div>
                  ))}
                </Card>
              </section>
            ))}
          </div>
        ) : (
          <EmptyState icon="activity" title={t('tx.empty')} hint={t('tx.emptyHint')} />
        )}
      </div>
    </Screen>
  );
}
