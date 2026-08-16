'use client';

import { NOTIFICATION_TYPES, type NotificationType, type UserSettingsDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import { Card, Divider, Skeleton, cx } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useMutation } from '@/hooks/useApi';
import { useApp } from '@/providers/AppProvider';

/**
 * Notification preferences.
 *
 * Every type is on by default. A person who has just been paid should not discover that the
 * alert was opt-in.
 */
const LABELS: Record<NotificationType, string> = {
  crypto_received: 'notify.cryptoReceived.title',
  crypto_sent: 'notify.cryptoSent.title',
  crypto_confirmed: 'notify.cryptoConfirmed.title',
  crypto_failed: 'notify.cryptoFailed.title',
  expected_income_due: 'notify.expectedIncomeDue.title',
  expected_income_overdue: 'notify.expectedIncomeOverdue.title',
  scheduled_payment_upcoming: 'notify.scheduledUpcoming.title',
  scheduled_payment_executed: 'notify.scheduledExecuted.title',
  scheduled_payment_failed: 'notify.scheduledFailed.title',
  fx_rate_alert: 'notify.fxAlert.title',
  balance_alert: 'notify.balanceAlert.title',
  goal_reached: 'notify.goalReached.title',
  security_alert: 'notify.securityAlert.title',
};

export default function NotificationSettingsPage() {
  const { t, settings, applySettings } = useApp();

  const update = useMutation(
    (input: Record<string, unknown>) =>
      api.patch<UserSettingsDto>('/api/settings/notifications', input),
    { onSuccess: applySettings },
  );

  if (!settings) {
    return (
      <Screen title={t('settings.notifications')} back>
        <Skeleton className="h-72 w-full rounded-3xl" />
      </Screen>
    );
  }

  return (
    <Screen title={t('settings.notifications')} back>
      <Card>
        {NOTIFICATION_TYPES.map((type, index) => {
          const enabled = settings.notifications[type] !== false;
          return (
            <div key={type}>
              {index > 0 ? <Divider /> : null}
              <label className="flex cursor-pointer items-center gap-3 px-4 py-3.5">
                <span className="flex-1 text-[14.5px] text-text">
                  {t(LABELS[type]).replace(/^[^\p{L}]*/u, '')}
                </span>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) =>
                    void update.mutate({ types: { [type]: event.target.checked } })
                  }
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={cx(
                    'relative h-[30px] w-[50px] shrink-0 rounded-full transition-colors',
                    enabled ? 'bg-accent' : 'bg-surface-sunken',
                  )}
                >
                  <span
                    className={cx(
                      'absolute top-[3px] h-6 w-6 rounded-full bg-white transition-[inset-inline-start]',
                      enabled ? 'start-[23px]' : 'start-[3px]',
                    )}
                  />
                </span>
              </label>
            </div>
          );
        })}
      </Card>
    </Screen>
  );
}
