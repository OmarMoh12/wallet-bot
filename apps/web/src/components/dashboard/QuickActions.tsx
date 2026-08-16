'use client';

import { useRouter } from 'next/navigation';
import { Icon, type IconName } from '@/components/ui/Icon';
import { haptics } from '@/lib/telegram';
import { useApp } from '@/providers/AppProvider';

/**
 * Primary actions.
 *
 * Four circular buttons under the balance, the way a wallet app does it. "Send" stays
 * visible even when sending is disabled — hiding it would leave the user wondering whether
 * the feature exists; the send screen explains the state clearly instead.
 */
const ACTIONS: Array<{ key: string; icon: IconName; labelKey: string; href: string }> = [
  { key: 'send', icon: 'arrow-up', labelKey: 'dashboard.quickSend', href: '/send' },
  { key: 'receive', icon: 'arrow-down', labelKey: 'dashboard.quickReceive', href: '/receive' },
  { key: 'add', icon: 'plus', labelKey: 'dashboard.quickAdd', href: '/activity/new' },
  { key: 'stats', icon: 'chart', labelKey: 'dashboard.quickAnalytics', href: '/analytics' },
];

export function QuickActions() {
  const router = useRouter();
  const { t } = useApp();

  return (
    <div className="grid grid-cols-4 gap-2">
      {ACTIONS.map((action) => (
        <button
          key={action.key}
          type="button"
          onClick={() => {
            haptics.impact('light');
            router.push(action.href);
          }}
          className="flex flex-col items-center gap-2 rounded-2xl py-3 transition-transform active:scale-[0.96]"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/14 text-accent">
            <Icon name={action.icon} size={21} />
          </span>
          <span className="text-[11.5px] font-medium text-muted">{t(action.labelKey)}</span>
        </button>
      ))}
    </div>
  );
}
