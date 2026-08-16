import { describe, expect, it } from 'vitest';
import {
  AppError,
  EXPECTED_INCOME_TRANSITIONS,
  SCHEDULED_PAYMENT_TRANSITIONS,
  SEND_REQUEST_TRANSITIONS,
  TX_STATUS_TRANSITIONS,
  assertTransition,
  canTransition,
  isInFlight,
  isSettled,
  isTerminal,
} from '@wallet/shared';

/**
 * State machines.
 *
 * These encode "what is allowed to happen to money next". The same rules exist as database
 * triggers; both are tested, because either one alone would be a single point of failure.
 */

describe('transaction status', () => {
  it('allows the chain lifecycle', () => {
    expect(canTransition(TX_STATUS_TRANSITIONS, 'detected', 'confirming')).toBe(true);
    expect(canTransition(TX_STATUS_TRANSITIONS, 'confirming', 'confirmed')).toBe(true);
    expect(canTransition(TX_STATUS_TRANSITIONS, 'detected', 'confirmed')).toBe(true);
  });

  it('never walks a confirmed transaction backwards', () => {
    expect(canTransition(TX_STATUS_TRANSITIONS, 'confirmed', 'pending')).toBe(false);
    expect(canTransition(TX_STATUS_TRANSITIONS, 'confirmed', 'confirming')).toBe(false);
    expect(canTransition(TX_STATUS_TRANSITIONS, 'confirmed', 'detected')).toBe(false);
  });

  it('treats failed and cancelled as terminal', () => {
    expect(isTerminal(TX_STATUS_TRANSITIONS, 'failed')).toBe(true);
    expect(isTerminal(TX_STATUS_TRANSITIONS, 'cancelled')).toBe(true);
    expect(isTerminal(TX_STATUS_TRANSITIONS, 'reversed')).toBe(true);
  });

  it('permits a reversal only from confirmed', () => {
    expect(canTransition(TX_STATUS_TRANSITIONS, 'confirmed', 'reversed')).toBe(true);
    expect(canTransition(TX_STATUS_TRANSITIONS, 'pending', 'reversed')).toBe(false);
  });

  it('classifies settled and in-flight states', () => {
    expect(isSettled('confirmed')).toBe(true);
    expect(isSettled('detected')).toBe(false);
    expect(isInFlight('confirming')).toBe(true);
    expect(isInFlight('failed')).toBe(false);
  });
});

describe('scheduled payments', () => {
  it('claims a payment before executing it', () => {
    expect(canTransition(SCHEDULED_PAYMENT_TRANSITIONS, 'scheduled', 'processing')).toBe(true);
    // Skipping `processing` would mean executing without holding the lease.
    expect(canTransition(SCHEDULED_PAYMENT_TRANSITIONS, 'scheduled', 'completed')).toBe(false);
  });

  it('releases the lease back to scheduled when a pre-flight check defers', () => {
    expect(canTransition(SCHEDULED_PAYMENT_TRANSITIONS, 'processing', 'scheduled')).toBe(true);
  });

  it('never revives a completed payment', () => {
    expect(isTerminal(SCHEDULED_PAYMENT_TRANSITIONS, 'completed')).toBe(true);
    expect(canTransition(SCHEDULED_PAYMENT_TRANSITIONS, 'completed', 'scheduled')).toBe(false);
    expect(canTransition(SCHEDULED_PAYMENT_TRANSITIONS, 'cancelled', 'scheduled')).toBe(false);
  });

  it('allows a failed payment to be retried or abandoned', () => {
    expect(canTransition(SCHEDULED_PAYMENT_TRANSITIONS, 'failed', 'scheduled')).toBe(true);
    expect(canTransition(SCHEDULED_PAYMENT_TRANSITIONS, 'failed', 'cancelled')).toBe(true);
  });
});

describe('send requests', () => {
  it('enforces quote -> confirm -> sign -> broadcast -> complete', () => {
    expect(canTransition(SEND_REQUEST_TRANSITIONS, 'quoted', 'confirmed')).toBe(true);
    expect(canTransition(SEND_REQUEST_TRANSITIONS, 'confirmed', 'signing')).toBe(true);
    expect(canTransition(SEND_REQUEST_TRANSITIONS, 'signing', 'broadcast')).toBe(true);
    expect(canTransition(SEND_REQUEST_TRANSITIONS, 'broadcast', 'completed')).toBe(true);
  });

  it('refuses to broadcast something that was never signed', () => {
    expect(canTransition(SEND_REQUEST_TRANSITIONS, 'quoted', 'broadcast')).toBe(false);
    expect(canTransition(SEND_REQUEST_TRANSITIONS, 'confirmed', 'broadcast')).toBe(false);
  });

  it('cannot cancel after signing has started', () => {
    // Past this point the transaction may already exist on-chain.
    expect(canTransition(SEND_REQUEST_TRANSITIONS, 'signing', 'cancelled')).toBe(false);
    expect(canTransition(SEND_REQUEST_TRANSITIONS, 'broadcast', 'cancelled')).toBe(false);
  });

  it('expires an unconfirmed quote', () => {
    expect(canTransition(SEND_REQUEST_TRANSITIONS, 'quoted', 'expired')).toBe(true);
  });
});

describe('expected income', () => {
  it('allows the normal lifecycle', () => {
    expect(canTransition(EXPECTED_INCOME_TRANSITIONS, 'pending', 'received')).toBe(true);
    expect(canTransition(EXPECTED_INCOME_TRANSITIONS, 'pending', 'delayed')).toBe(true);
    expect(canTransition(EXPECTED_INCOME_TRANSITIONS, 'delayed', 'received')).toBe(true);
  });

  it('does not un-receive money', () => {
    expect(isTerminal(EXPECTED_INCOME_TRANSITIONS, 'received')).toBe(true);
  });
});

describe('assertTransition', () => {
  it('is idempotent for a no-op transition', () => {
    expect(() =>
      assertTransition(TX_STATUS_TRANSITIONS, 'confirmed', 'confirmed', 'transaction'),
    ).not.toThrow();
  });

  it('throws a typed error on an illegal move', () => {
    try {
      assertTransition(TX_STATUS_TRANSITIONS, 'confirmed', 'pending', 'transaction');
      throw new Error('expected a throw');
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).code).toBe('INVALID_STATE_TRANSITION');
    }
  });
});
