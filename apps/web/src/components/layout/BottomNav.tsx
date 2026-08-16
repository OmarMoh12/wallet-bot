'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '@/components/ui/Icon';
import { cx } from '@/components/ui/primitives';
import { haptics } from '@/lib/telegram';
import { useApp } from '@/providers/AppProvider';

/**
 * Bottom navigation.
 *
 * Five destinations, fixed to the bottom, clearing the iOS home indicator via
 * `env(safe-area-inset-bottom)`. Order is stable across locales; the strip itself flips with
 * `dir="rtl"` because it is a plain flex row.
 */
const TABS: Array<{ href: string; icon: IconName; labelKey: string }> = [
  { href: '/', icon: 'home', labelKey: 'nav.home' },
  { href: '/wallets', icon: 'wallet', labelKey: 'nav.wallets' },
  { href: '/activity', icon: 'activity', labelKey: 'nav.transactions' },
  { href: '/payments', icon: 'calendar', labelKey: 'nav.payments' },
  { href: '/settings', icon: 'settings', labelKey: 'nav.settings' },
];

export function BottomNav() {
  const pathname = usePathname();
  const { t } = useApp();

  return (
    <nav
      aria-label={t('a11y.openMenu')}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-header/95 backdrop-blur-xl"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      <ul className="mx-auto flex max-w-[560px] items-stretch">
        {TABS.map((tab) => {
          const active = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                onClick={() => haptics.selection()}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex h-[58px] flex-col items-center justify-center gap-1 transition-colors',
                  active ? 'text-accent' : 'text-subtle',
                )}
              >
                <Icon name={tab.icon} size={22} />
                <span className="text-[10px] font-medium leading-none">{t(tab.labelKey)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
