import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { JobRunner, closeAppContext, createAppContext, healthReport } from '@wallet/core';

/**
 * Background worker.
 *
 * Runs on Railway. Responsible for blockchain scanning, confirmation tracking, FX and price
 * refresh, scheduled-payment execution, reminders, notification dispatch and cleanup.
 *
 * It exposes a tiny HTTP server for platform health checks only — it has no API surface and
 * should not be publicly routed.
 */

const context = createAppContext({ service: 'worker' });
const runner = new JobRunner(context);

/* ----------------------------------------------------------------- health -- */

const healthServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/';

  const send = (status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      // This endpoint is machine-facing; deny everything a browser might try.
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(payload);
  };

  if (url === '/health' || url === '/healthz' || url === '/') {
    healthReport(context, 'worker')
      .then((report) => {
        // Report `degraded` as healthy: the platform should not restart a worker that is
        // running fine but waiting on an upstream provider.
        send(report.status === 'down' ? 503 : 200, {
          ...report,
          worker: { id: runner.id, running: runner.isRunning, ...runner.stats },
        });
      })
      .catch(() => send(503, { status: 'down', service: 'worker' }));
    return;
  }

  if (url === '/ready') {
    send(runner.isRunning ? 200 : 503, { ready: runner.isRunning });
    return;
  }

  send(404, { error: { code: 'NOT_FOUND' } });
});

// Without this, a failed bind reaches `uncaughtException` as a bare errno and the reason
// the worker never came up is a guess. It is a startup failure, so it exits non-zero.
healthServer.on('error', (error: NodeJS.ErrnoException) => {
  context.logger.fatal('worker health endpoint could not bind', {
    operation: 'worker.boot',
    port: context.config.worker.healthPort,
    code: error.code ?? 'unknown',
    error: error.message,
  });
  void shutdown('healthServerError', 1);
});

healthServer.listen(context.config.worker.healthPort, '0.0.0.0', () => {
  context.logger.info('worker health endpoint listening', {
    operation: 'worker.boot',
    port: context.config.worker.healthPort,
  });
});

/* -------------------------------------------------------------- lifecycle -- */

let shuttingDown = false;

/**
 * Graceful shutdown.
 *
 * Stops claiming new work and lets in-flight jobs finish. Anything still running when the
 * grace period expires simply loses its lease and is reclaimed by another worker — which is
 * safe precisely because every handler is idempotent.
 */
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  context.logger.info('worker shutting down', {
    operation: 'worker.shutdown',
    signal,
    exitCode,
  });
  runner.stop();
  healthServer.close();

  const deadline = Date.now() + 15_000;
  while (runner.isRunning && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await closeAppContext(context).catch(() => {});
  process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  context.logger.error('unhandled rejection in worker', {
    operation: 'worker.error',
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on('uncaughtException', (error) => {
  context.logger.fatal('uncaught exception in worker', {
    operation: 'worker.error',
    error: error.message,
    stack: error.stack,
  });
  // Exit 1, not 0. Railway's restart policy is ON_FAILURE: exiting 0 after a crash tells the
  // platform the run finished successfully, so the worker is never restarted and the
  // deployment shows as Completed while no work is being done.
  void shutdown('uncaughtException', 1);
});

runner.start().catch((error: unknown) => {
  context.logger.fatal('worker failed to start', {
    operation: 'worker.boot',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
