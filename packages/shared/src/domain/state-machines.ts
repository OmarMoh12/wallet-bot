import { AppError } from '../errors.js';
import type {
  ExpectedIncomeStatus,
  ScheduledPaymentStatus,
  SendRequestStatus,
  TxStatus,
} from './enums.js';

/**
 * Explicit state machines for everything that touches money.
 *
 * Invalid transitions throw rather than silently no-op: a transaction that goes from
 * `confirmed` back to `pending` is a bug, and a bug in this area is a financial error.
 * The same tables are also constrained in SQL (see migration 0003) so a direct DB write
 * cannot bypass these rules either.
 */

export type Transitions<S extends string> = Readonly<Record<S, readonly S[]>>;

export const TX_STATUS_TRANSITIONS: Transitions<TxStatus> = Object.freeze({
  // Manual/cash entries start here and are usually immediately confirmed.
  pending: ['confirmed', 'failed', 'cancelled'],
  // Chain lifecycle.
  detected: ['confirming', 'confirmed', 'failed'],
  confirming: ['confirmed', 'failed'],
  confirmed: ['reversed'],
  failed: [],
  cancelled: [],
  reversed: [],
});

export const SCHEDULED_PAYMENT_TRANSITIONS: Transitions<ScheduledPaymentStatus> = Object.freeze({
  scheduled: ['processing', 'cancelled'],
  // `processing` -> `scheduled` is the deliberate "release the lease" path when a
  // pre-flight check says "not now, but maybe later" (e.g. provider unreachable).
  processing: ['completed', 'failed', 'scheduled'],
  completed: [],
  failed: ['scheduled', 'cancelled'],
  cancelled: [],
});

export const EXPECTED_INCOME_TRANSITIONS: Transitions<ExpectedIncomeStatus> = Object.freeze({
  pending: ['received', 'delayed', 'cancelled'],
  delayed: ['received', 'cancelled', 'pending'],
  received: [],
  cancelled: ['pending'],
});

export const SEND_REQUEST_TRANSITIONS: Transitions<SendRequestStatus> = Object.freeze({
  quoted: ['confirmed', 'cancelled', 'expired'],
  confirmed: ['signing', 'failed', 'cancelled'],
  signing: ['broadcast', 'failed'],
  broadcast: ['completed', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
});

export function canTransition<S extends string>(machine: Transitions<S>, from: S, to: S): boolean {
  const allowed = machine[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function assertTransition<S extends string>(
  machine: Transitions<S>,
  from: S,
  to: S,
  entity: string,
): void {
  if (from === to) return; // Idempotent re-application of the same state is fine.
  if (!canTransition(machine, from, to)) {
    throw new AppError('INVALID_STATE_TRANSITION', {
      details: { entity, from, to },
      internal: `Illegal ${entity} transition ${from} -> ${to}`,
    });
  }
}

/** States from which nothing further can happen. */
export function isTerminal<S extends string>(machine: Transitions<S>, state: S): boolean {
  return (machine[state]?.length ?? 0) === 0;
}

/** A transaction that should count toward balances. */
export function isSettled(status: TxStatus): boolean {
  return status === 'confirmed';
}

/** A transaction still expected to change state. */
export function isInFlight(status: TxStatus): boolean {
  return status === 'pending' || status === 'detected' || status === 'confirming';
}
