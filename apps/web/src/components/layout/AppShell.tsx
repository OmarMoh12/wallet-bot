'use client';

import type { ReactNode } from 'react';
import { useApp } from '@/providers/AppProvider';
import { BottomNav } from './BottomNav';
import { Toaster } from '@/components/ui/Toaster';
import { Button, Spinner } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';

/**
 * Application shell.
 *
 * Gates the whole app on authentication. There is no partial state: either the Telegram
 * session verified server-side, or the user sees why not. Rendering financial UI in an
 * indeterminate auth state is exactly the kind of ambiguity to avoid here.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { authState, t, error, retry, isTelegram } = useApp();

  if (authState === 'loading') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 text-muted">
        <Spinner size={26} />
        <p className="text-[14px]">{t('common.loading')}</p>
      </div>
    );
  }

  if (authState === 'unauthenticated' && !isTelegram) {
    // Opened in a plain browser. The Mini App cannot authenticate without Telegram, and we
    // deliberately do not offer a weaker fallback just to make the page render.
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface text-accent">
          <Icon name="lock" size={28} />
        </div>
        <h1 className="text-[20px] font-semibold text-text">{t('app.name')}</h1>
        <p className="max-w-[320px] text-[14px] leading-relaxed text-muted">
          {t('error.UNAUTHORIZED')}
        </p>
      </div>
    );
  }

  if (authState === 'error' || authState === 'unauthenticated') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-negative/12 text-negative">
          <Icon name="warning" size={28} />
        </div>
        <p className="max-w-[320px] text-[15px] leading-relaxed text-text">
          {t(error ? `error.${error}` : 'error.generic')}
        </p>
        <Button variant="secondary" icon="refresh" onClick={retry}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  return (
    <>
      {children}
      <BottomNav />
      <Toaster />
    </>
  );
}
