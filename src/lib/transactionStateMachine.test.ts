import { describe, expect, it } from 'vitest';
import { assertValidTransition, canTransition, getAllowedTransitions } from './transactionStateMachine';

describe('Campus Plug transaction state machine', () => {
  it('allows the normal payment-to-release path', () => {
    expect(canTransition('PENDING', 'LOCKED')).toBe(true);
    expect(canTransition('LOCKED', 'MEETUP_INITIATED')).toBe(true);
    expect(canTransition('MEETUP_INITIATED', 'RELEASE_REQUESTED')).toBe(true);
    expect(canTransition('RELEASE_REQUESTED', 'RELEASED')).toBe(true);
  });

  it('rejects terminal-state resurrection', () => {
    expect(canTransition('RELEASED', 'LOCKED')).toBe(false);
    expect(canTransition('CANCELLED', 'PENDING')).toBe(false);
    expect(canTransition('REFUNDED', 'RELEASED')).toBe(false);
  });

  it('allows disputes to resolve only through explicit outcomes', () => {
    expect(getAllowedTransitions('DISPUTED')).toEqual(['RELEASED', 'REFUNDED']);
    expect(() => assertValidTransition('DISPUTED', 'LOCKED')).toThrow();
  });
});
