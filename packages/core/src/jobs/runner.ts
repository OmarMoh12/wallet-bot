import { randomUUID } from 'node:crypto';
import { AppError, backoffDelayMs, sleep, withTimeout, type JobType } from '@wallet/shared';
import { opsRepo } from '@wallet/db';
import type { AppContext } from '../context.js';
import { asSystem } from '../services/base.js';
import {
  createJobHandlers,
  enqueueDueWalletScans,
  recurringJobs,
  type JobHandler,
} from './handlers.js';

/**
 * The job runner.
 *
 * Claims work with `FOR UPDATE SKIP LOCKED` under a lease, runs it with a hard timeout, and
 * records the outcome. Because the queue is Postgres, a handler can do its work and mark its
 * own job complete in one transaction where that matters.
 *
 * Failure policy: retry with exponential backoff up to `max_attempts`, then park the job as
 * `dead` so it stops consuming capacity and shows up in the admin panel. Errors flagged
 * `retryable: false` (bad payload, a signer refusal) skip straight to dead — retrying them
 * would only repeat the same failure.
 */
export interface RunnerStats {
  claimed: number;
  succeeded: number;
  failed: number;
}

export class JobRunner {
  private readonly handlers: Record<JobType, JobHandler>;
  private readonly workerId: string;
  private running = false;
  private stopping = false;
  private lastRecurringRun = new Map<string, number>();
  private lastScanSweep = 0;

  readonly stats: RunnerStats = { claimed: 0, succeeded: 0, failed: 0 };

  constructor(
    private readonly app: AppContext,
    options: { workerId?: string } = {},
  ) {
    this.handlers = createJobHandlers(app);
    this.workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  }

  get id(): string {
    return this.workerId;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Enqueue any recurring job whose interval has elapsed. Deduped by key. */
  private async enqueueRecurring(): Promise<void> {
    const now = Date.now();

    for (const job of recurringJobs(this.app)) {
      const last = this.lastRecurringRun.get(job.dedupeKey) ?? 0;
      if (now - last < job.intervalSeconds * 1000) continue;
      this.lastRecurringRun.set(job.dedupeKey, now);

      await asSystem(this.app, (tx) =>
        opsRepo.enqueueJob(tx, {
          type: job.type,
          payload: {},
          dedupeKey: job.dedupeKey,
          priority: job.priority,
        }),
      );
    }

    const scanIntervalMs = Math.max(10_000, this.app.config.worker.chainScanIntervalSeconds * 1000);
    if (now - this.lastScanSweep >= scanIntervalMs) {
      this.lastScanSweep = now;
      const queued = await enqueueDueWalletScans(this.app, { limit: 25 });
      if (queued > 0) {
        this.app.logger.debug('queued wallet scans', {
          operation: 'worker.sweep',
          count: queued,
        });
      }
    }
  }

  /** Claim and execute one batch. Returns the number of jobs processed. */
  async tick(): Promise<number> {
    await this.enqueueRecurring();

    const jobs = await asSystem(this.app, (tx) =>
      opsRepo.claimJobs(tx, {
        worker: this.workerId,
        limit: this.app.config.worker.concurrency,
        leaseSeconds: Math.ceil(this.app.config.worker.jobTimeoutMs / 1000) + 30,
      }),
    );
    this.stats.claimed += jobs.length;

    // Jobs within a batch are independent, so run them concurrently.
    await Promise.all(jobs.map((job) => this.runOne(job)));
    return jobs.length;
  }

  private async runOne(job: {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }): Promise<void> {
    const requestId = `job-${job.id.slice(0, 8)}`;
    const logger = this.app.logger.child({
      requestId,
      operation: 'worker.job',
      jobType: job.type,
    });
    const startedAt = Date.now();

    const handler = this.handlers[job.type as JobType];
    if (!handler) {
      // Unknown type: park it rather than retrying forever. This happens when a job was
      // queued by a newer deploy and picked up by an older worker.
      await asSystem(this.app, (tx) =>
        opsRepo.failJob(tx, job.id, `no handler registered for type "${job.type}"`, 0),
      );
      this.stats.failed += 1;
      logger.error('job has no handler');
      return;
    }

    try {
      const result = await withTimeout(
        handler({ app: this.app, requestId, worker: this.workerId }, job.payload),
        this.app.config.worker.jobTimeoutMs,
        `job ${job.type}`,
      );

      await asSystem(this.app, (tx) => opsRepo.completeJob(tx, job.id));
      this.stats.succeeded += 1;

      logger.info('job completed', {
        durationMs: Date.now() - startedAt,
        attempts: job.attempts,
        ...(result ?? {}),
      });
    } catch (error) {
      this.stats.failed += 1;
      const appError = AppError.is(error) ? error : null;
      const message = error instanceof Error ? error.message : String(error);

      // Non-retryable errors are pushed past max_attempts so the row lands in `dead`.
      const retryable = appError ? appError.retryable : true;
      const delayMs = retryable ? backoffDelayMs(job.attempts + 1) : 0;

      await asSystem(this.app, async (tx) => {
        if (!retryable) {
          await tx`
            UPDATE jobs SET attempts = max_attempts WHERE id = ${job.id}
          `;
        }
        await opsRepo.failJob(tx, job.id, message, delayMs);
      });

      logger.warn('job failed', {
        durationMs: Date.now() - startedAt,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        retryable,
        code: appError?.code ?? 'UNKNOWN',
        error: message.slice(0, 300),
      });
    }
  }

  /** Run until `stop()` is called. Resolves once the loop has drained. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    this.app.logger.info('worker started', {
      operation: 'worker.start',
      workerId: this.workerId,
      concurrency: this.app.config.worker.concurrency,
      chainEnv: this.app.config.chain.env,
      mockChain: this.app.providers.isMock,
      sendingEnabled: this.app.config.sending.enabled,
    });

    while (!this.stopping) {
      try {
        const processed = await this.tick();
        // Poll immediately when the queue was full; otherwise idle for the interval.
        if (processed === 0) await sleep(this.app.config.worker.pollIntervalMs);
      } catch (error) {
        this.app.logger.error('worker tick failed', {
          operation: 'worker.tick',
          error: error instanceof Error ? error.message : 'unknown',
        });
        // Back off on repeated infrastructure failures so a database outage does not
        // become a tight error loop.
        await sleep(Math.max(this.app.config.worker.pollIntervalMs, 2000));
      }
    }

    this.running = false;
    this.app.logger.info('worker stopped', {
      operation: 'worker.stop',
      workerId: this.workerId,
      ...this.stats,
    });
  }

  stop(): void {
    this.stopping = true;
  }
}
