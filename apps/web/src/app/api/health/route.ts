import { NextResponse } from 'next/server';
import { healthReport } from '@wallet/core';
import { getAppContext } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Health endpoint for the platform.
 *
 * Unauthenticated by necessity, so it reports component status and nothing else — no
 * versions of dependencies, no configuration values, no counts that would reveal usage.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const report = await healthReport(getAppContext(), 'web');
    return NextResponse.json(report, {
      status: report.status === 'down' ? 503 : 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      { status: 'down', service: 'web' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
