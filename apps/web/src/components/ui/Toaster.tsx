'use client';

import { useApp } from '@/providers/AppProvider';
import { Icon } from './Icon';
import { cx } from './primitives';

/**
 * Toasts.
 *
 * `role="status"` with `aria-live="polite"` so a screen reader announces the result of an
 * action without interrupting whatever it is currently reading.
 */
export function Toaster() {
  const { toasts, dismissToast } = useApp();

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4"
      style={{ bottom: 'calc(var(--nav-height) + var(--safe-bottom) + 16px)' }}
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismissToast(toast.id)}
          className={cx(
            'animate-fade pointer-events-auto flex w-full max-w-[420px] items-center gap-2.5 rounded-2xl px-4 py-3',
            'border border-border bg-surface-raised text-start text-[14px] shadow-lg',
            toast.tone === 'error' && 'border-negative/30 text-negative',
            toast.tone === 'success' && 'border-positive/30 text-positive',
            toast.tone === 'info' && 'text-text',
          )}
        >
          <Icon
            name={toast.tone === 'error' ? 'warning' : toast.tone === 'success' ? 'check' : 'info'}
            size={17}
          />
          <span className="flex-1">{toast.message}</span>
        </button>
      ))}
    </div>
  );
}
