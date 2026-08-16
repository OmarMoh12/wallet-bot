'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { getWebApp } from '@/lib/telegram';

/**
 * Screen scaffold.
 *
 * Provides the page title, the back affordance, and bottom padding that clears the nav bar.
 *
 * On a secondary screen it also drives Telegram's **native** back button, so the app behaves
 * like the rest of the client rather than showing a second, web-looking back arrow. The
 * in-page button remains for desktop browsers where the native one does not exist.
 */
export function Screen({
  title,
  subtitle,
  back,
  action,
  children,
  padded = true,
}: {
  title?: string;
  subtitle?: string;
  back?: boolean;
  action?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!back) return;
    const webApp = getWebApp();
    const button = webApp?.BackButton;
    if (!button) return;

    const handler = (): void => router.back();
    button.onClick(handler);
    button.show();

    return () => {
      button.offClick(handler);
      button.hide();
    };
  }, [back, router]);

  return (
    <div
      className="mx-auto w-full max-w-[560px]"
      style={{ paddingBottom: 'calc(var(--nav-height) + var(--safe-bottom) + 24px)' }}
    >
      {title ? (
        <header
          className="sticky top-0 z-30 bg-bg/85 px-4 pb-3 backdrop-blur-xl"
          style={{ paddingTop: 'calc(var(--safe-top) + 12px)' }}
        >
          <div className="flex items-center gap-2">
            {back ? (
              <button
                type="button"
                onClick={() => router.back()}
                aria-label="Back"
                className="-ms-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text active:bg-surface rtl:rotate-180"
              >
                <Icon name="arrow-left" size={20} />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[22px] font-bold tracking-tight text-text">{title}</h1>
              {subtitle ? <p className="truncate text-[13px] text-muted">{subtitle}</p> : null}
            </div>
            {action}
          </div>
        </header>
      ) : (
        <div style={{ height: 'calc(var(--safe-top) + 8px)' }} />
      )}

      <main className={padded ? 'px-4' : undefined}>{children}</main>
    </div>
  );
}
