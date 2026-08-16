import { AuthService } from './auth/service.js';
import type { AppContext } from './context.js';
import { RateLimiter } from './rate-limit.js';
import {
  AdminService,
  AnalyticsService,
  CatalogService,
  ChainSyncService,
  DashboardService,
  NotificationService,
  PlanningService,
  PortfolioService,
  ReceiveService,
  ReminderService,
  SchedulerService,
  SendService,
  TransactionService,
  WalletService,
} from './services/index.js';

export * from './config.js';
export * from './logger.js';
export * from './context.js';
export * from './mappers.js';
export * from './rate-limit.js';
export * from './services/index.js';
export * from './auth/service.js';
export * from './auth/tokens.js';
export * from './signer/index.js';
export * from './jobs/handlers.js';
export * from './jobs/runner.js';

/**
 * The service bundle.
 *
 * Constructed once per process and shared. Services are stateless with respect to the
 * request — the acting identity travels in `ServiceContext`, never on the instance — so a
 * single set is safe to reuse across concurrent requests.
 */
export interface Services {
  auth: AuthService;
  rateLimiter: RateLimiter;
  wallets: WalletService;
  transactions: TransactionService;
  portfolio: PortfolioService;
  analytics: AnalyticsService;
  planning: PlanningService;
  catalog: CatalogService;
  receive: ReceiveService;
  send: SendService;
  dashboard: DashboardService;
  notifications: NotificationService;
  chainSync: ChainSyncService;
  scheduler: SchedulerService;
  reminders: ReminderService;
  admin: AdminService;
}

export function createServices(app: AppContext): Services {
  const auth = new AuthService({ sql: app.sql, config: app.config, logger: app.logger });
  const notifications = new NotificationService();
  const send = new SendService(auth, notifications);

  return {
    auth,
    rateLimiter: new RateLimiter(app),
    wallets: new WalletService(),
    transactions: new TransactionService(),
    portfolio: new PortfolioService(),
    analytics: new AnalyticsService(),
    planning: new PlanningService(),
    catalog: new CatalogService(),
    receive: new ReceiveService(),
    send,
    dashboard: new DashboardService(),
    notifications,
    chainSync: new ChainSyncService(notifications),
    scheduler: new SchedulerService(send, notifications),
    reminders: new ReminderService(notifications),
    admin: new AdminService(),
  };
}
