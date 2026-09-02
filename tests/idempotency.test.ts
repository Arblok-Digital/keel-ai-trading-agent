import { describe, expect, it } from 'vitest';
import { clientOrderIdFor, decisionIdFromClientOrderId } from '../src/services/execution/id-generator';

const DECISION_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('deterministic clientOrderId (US-04)', () => {
  it('derives cID-${decisionId} deterministically', () => {
    expect(clientOrderIdFor(DECISION_ID)).toBe(`cID-${DECISION_ID}`);
    expect(clientOrderIdFor(DECISION_ID)).toBe(clientOrderIdFor(DECISION_ID));
  });

  it('round-trips back to the decision id', () => {
    expect(decisionIdFromClientOrderId(clientOrderIdFor(DECISION_ID))).toBe(DECISION_ID);
    expect(decisionIdFromClientOrderId('nope')).toBeNull();
  });
});
