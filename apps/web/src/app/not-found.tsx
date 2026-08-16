'use client';

import Link from 'next/link';
import { Button, EmptyState } from '@/components/ui/primitives';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <EmptyState
        icon="search"
        title="Not found"
        action={
          <Link href="/">
            <Button>Home</Button>
          </Link>
        }
      />
    </div>
  );
}
