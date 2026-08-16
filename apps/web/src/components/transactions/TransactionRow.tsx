'use client';

import Link from 'next/link';
import type { TransactionDto } from '@wallet/shared';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/components/ui/primitives';
import { fiat, relativeTime, token } from '@/lib/format';
import { useApp } from '@/providers/AppProvider';

/**
 * A transaction row.
 *
 * Direction is conveyed three ways — colour, an explicit sign, and an arrow icon — because
 * colour alone fails for colour-blind users and in high-contrast modes.
 */
export function TransactionRow({ transaction }: { transaction: TransactionDto }) {
  const { locale, t } = useApp();
  const incoming = transaction.direction === 'in';

  const amount = transaction.fiat
    ? fiat(transaction.fiat, locale, { signDisplay: 'always' })
    : token(transaction.token, locale, { signDisplay: 'always', maxFractionDigits: 4 });

  const secondary =
    transaction.kind === 'crypto' && transaction.valueUsd
      ? fiat(transaction.valueUsd, locale, { signDisplay: 'never' })
      : (transaction.category?.name ?? t(`tx.source.${transaction.source}`));

  const pending = transaction.status !== 'confirmed';

  return (
    <Link
      href={`/activity/${transaction.id}`}
      className="row-press flex items-center gap-3 px-4 py-3"
      aria-label={t('a11y.transactionRow', {
        title: transaction.title,
        amount,
        status: t(`tx.status.${transaction.status}`),
      })}
    >
      <span
        className={cx(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
          incoming ? 'bg-positive/14 text-positive' : 'bg-negative/12 text-negative',
        )}
        aria-hidden="true"
      >
        <Icon name={incoming ? 'arrow-down' : 'arrow-up'} size={18} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium text-text">{transaction.title}</p>
        <p className="flex items-center gap-1.5 truncate text-[12.5px] text-muted">
          <span className="truncate">{secondary}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{relativeTime(transaction.occurredAt, t)}</span>
        </p>
      </div>

      <div className="shrink-0 text-end">
        <p
          className={cx(
            'numeric text-[15px] font-semibold',
            incoming ? 'text-positive' : 'text-text',
          )}
        >
          <span className="bidi-isolate">{amount}</span>
        </p>
        {pending ? (
          <p className="text-[11.5px] text-warning">{t(`tx.status.${transaction.status}`)}</p>
        ) : null}
      </div>
    </Link>
  );
}
