'use client';

import { useEffect } from 'react';
import { Button, EmptyState } from '@/components/ui/primitives';

/**
 * Route error boundary.
 *
 * Deliberately shows no message from the error object: a rendering failure can carry
 * internal detail, and this is a financial app. The digest identifies the occurrence in the
 * server logs without exposing anything.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Reported to the console only; server-side logging already captured the cause.
    console.error('render error', error.digest ?? 'no-digest');
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <EmptyState
        icon="warning"
        title="Something went wrong"
        hint={error.digest ? `Reference: ${error.digest}` : undefined}
        action={
          <Button icon="refresh" onClick={reset}>
            Try again
          </Button>
        }
      />
    </div>
  );
}
