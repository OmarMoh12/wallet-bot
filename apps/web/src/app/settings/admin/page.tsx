'use client';

import { useState } from 'react';
import type { HealthDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import { Badge, Button, Card, Divider, EmptyState, Skeleton, cx } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { api } from '@/lib/api';
import { useApiQuery, useMutation } from '@/hooks/useApi';
import { relativeTime } from '@/lib/format';
import { useApp } from '@/providers/AppProvider';

interface SendingSettings {
  database: Record<string, unknown>;
  environment: {
    sendingEnabled: boolean;
    signerMode: string;
    chainEnv: string;
    blockchainMock: boolean;
    safeMode: boolean;
  };
}

interface QueueStats {
  byStatus: Record<string, number>;
  dead: Array<{
    id: string;
    type: string;
    attempts: number;
    lastError: string | null;
    finishedAt: string | null;
  }>;
}

interface AuditEntry {
  id: string;
  action: string;
  entityType: string | null;
  createdAt: string;
  actorType: string;
}

/**
 * Admin panel.
 *
 * Read-mostly on purpose. The one mutation — the sending kill switch — can only ever
 * *tighten* what the environment allows, so an admin session cannot enable outbound
 * transfers on a deployment configured with `SENDING_ENABLED=false`. The panel says so
 * explicitly rather than letting a toggle imply otherwise.
 */
export default function AdminPage() {
  const { t, session } = useApp();
  const health = useApiQuery<HealthDto>('/api/admin/health');
  const sending = useApiQuery<SendingSettings>('/api/admin/sending');
  const jobs = useApiQuery<QueueStats>('/api/admin/jobs');
  const audit = useApiQuery<{ items: AuditEntry[] }>('/api/admin/audit', { limit: '20' });
  const [reason, setReason] = useState('operator toggle');

  const toggle = useMutation(
    (enabled: boolean) =>
      api.post<{ effective: boolean }>('/api/admin/sending', { enabled, reason }),
    { onSuccess: () => void sending.refetch() },
  );

  if (!session?.user.isAdmin) {
    return (
      <Screen title="Admin" back>
        <EmptyState icon="lock" title={t('error.ADMIN_REQUIRED')} />
      </Screen>
    );
  }

  const env = sending.data?.environment;
  const dbEnabled = sending.data?.database.sending_enabled === true;

  return (
    <Screen title="Admin" back>
      <div className="space-y-4">
        {/* ------------------------------------------------------- health -- */}
        <section>
          <p className="px-1 pb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">
            System health
          </p>
          <Card>
            {health.loading ? (
              <Skeleton className="m-4 h-20" />
            ) : health.data ? (
              health.data.checks.map((check, index) => (
                <div key={check.name}>
                  {index > 0 ? <Divider /> : null}
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span
                      aria-hidden="true"
                      className={cx(
                        'h-2.5 w-2.5 shrink-0 rounded-full',
                        check.status === 'ok'
                          ? 'bg-positive'
                          : check.status === 'degraded'
                            ? 'bg-warning'
                            : 'bg-negative',
                      )}
                    />
                    <span className="flex-1 text-[14px] text-text">{check.name}</span>
                    <span className="text-[12px] text-muted">{check.detail ?? check.status}</span>
                  </div>
                </div>
              ))
            ) : null}
          </Card>
        </section>

        {/* ------------------------------------------------------ sending -- */}
        <section>
          <p className="px-1 pb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">
            Outgoing transfers
          </p>
          <Card className="p-4">
            {env ? (
              <>
                <dl className="space-y-2 text-[13px]">
                  <Line label="Environment SENDING_ENABLED" value={String(env.sendingEnabled)} />
                  <Line label="Database sending_enabled" value={String(dbEnabled)} />
                  <Line label="Signer mode" value={env.signerMode} />
                  <Line label="Chain" value={env.chainEnv} />
                  <Line label="Mock providers" value={String(env.blockchainMock)} />
                </dl>

                <div className="mt-4 rounded-2xl bg-surface-sunken px-3.5 py-3 text-[12.5px] leading-relaxed text-muted">
                  Effective state is the <strong className="text-text">AND</strong> of both flags.
                  Turning the database flag on has no effect while the environment flag is off —
                  that asymmetry is deliberate, so a compromised admin session cannot enable
                  outbound transfers.
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    loading={toggle.pending}
                    disabled={!dbEnabled}
                    onClick={() => {
                      setReason('operator disabled sending');
                      void toggle.mutate(false);
                    }}
                  >
                    Disable
                  </Button>
                  <Button
                    variant="danger"
                    loading={toggle.pending}
                    disabled={dbEnabled}
                    onClick={() => {
                      setReason('operator enabled sending');
                      void toggle.mutate(true);
                    }}
                  >
                    Enable
                  </Button>
                </div>
              </>
            ) : (
              <Skeleton className="h-24" />
            )}
          </Card>
        </section>

        {/* --------------------------------------------------------- jobs -- */}
        <section>
          <p className="px-1 pb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">
            Job queue
          </p>
          <Card className="p-4">
            {jobs.data ? (
              <>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(jobs.data.byStatus).map(([status, count]) => (
                    <Badge
                      key={status}
                      tone={
                        status === 'dead' ? 'negative' : status === 'failed' ? 'warning' : 'neutral'
                      }
                    >
                      {status}: {count}
                    </Badge>
                  ))}
                </div>
                {jobs.data.dead.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {jobs.data.dead.map((job) => (
                      <li key={job.id} className="rounded-xl bg-surface-sunken px-3 py-2">
                        <p className="text-[13px] font-medium text-text">{job.type}</p>
                        <p className="mt-0.5 break-all text-[11.5px] text-muted">
                          {job.lastError ?? '—'}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <Skeleton className="h-16" />
            )}
          </Card>
        </section>

        {/* -------------------------------------------------------- audit -- */}
        <section>
          <p className="px-1 pb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">
            Audit log
          </p>
          <Card>
            {audit.data?.items.map((entry, index) => (
              <div key={entry.id}>
                {index > 0 ? <Divider /> : null}
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <Icon name="info" size={15} className="shrink-0 text-subtle" />
                  <span className="flex-1 truncate text-[13px] text-text">{entry.action}</span>
                  <span className="shrink-0 text-[11.5px] text-muted">
                    {relativeTime(entry.createdAt, t)}
                  </span>
                </div>
              </div>
            ))}
          </Card>
        </section>
      </div>
    </Screen>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="numeric font-medium text-text">{value}</dd>
    </div>
  );
}
