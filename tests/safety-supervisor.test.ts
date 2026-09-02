import { describe, expect, it } from 'vitest';
import { evaluateReport, computeDiscrepancyUsd, isUnexplained } from '../src/services/reconciliation/discrepancy-handler';
import { narrativeVelocity } from '../src/services/ingestion/narrative-velocity';
import { RISK_CONSTANTS } from '../src/config/risk-constants';

describe('reconciliation evaluation (US-06)', () => {
  it('marks synced within tolerance', () => {
    const verdict = evaluateReport({ localBalanceUsd: 10_000.4, exchangeBalanceUsd: 10_000 });
    expect(verdict.isSynced).toBe(true);
    expect(verdict.discrepancyUsd).toBeCloseTo(0.4);
  });

  it('flags unexplained discrepancy beyond tolerance and would halt', () => {
    const verdict = evaluateReport({ localBalanceUsd: 9_000, exchangeBalanceUsd: 10_000 });
    expect(verdict.isSynced).toBe(false);
    expect(isUnexplained(verdict.discrepancyUsd, RISK_CONSTANTS.DISCREPANCY_TOLERANCE_USD)).toBe(true);
  });

  it('discrepancy is signed (local minus exchange)', () => {
    expect(computeDiscrepancyUsd(100, 90)).toBe(10);
    expect(computeDiscrepancyUsd(90, 100)).toBe(-10);
  });
});

describe('narrative velocity scoring', () => {
  it('scales growth into bounded score', () => {
    expect(narrativeVelocity({ volumeUsdWindow: 200, previousVolumeUsdWindow: 100, windowSeconds: 60 })).toBe(10);
    expect(narrativeVelocity({ volumeUsdWindow: 0, previousVolumeUsdWindow: 100, windowSeconds: 60 })).toBe(-10);
    expect(narrativeVelocity({ volumeUsdWindow: 999_999, previousVolumeUsdWindow: 1, windowSeconds: 60 })).toBeLessThanOrEqual(30);
    expect(narrativeVelocity({ volumeUsdWindow: 50, previousVolumeUsdWindow: 0, windowSeconds: 60 })).toBe(0);
  });

  it('returns negative scores for distribution velocity', () => {
    expect(narrativeVelocity({ volumeUsdWindow: 50, previousVolumeUsdWindow: 200, windowSeconds: 30 })).toBeLessThan(0);
    expect(narrativeVelocity({ volumeUsdWindow: 50, previousVolumeUsdWindow: 200, windowSeconds: 30 })).toBeGreaterThanOrEqual(-30);
  });
});

describe('risk constants match spec', () => {
  it('pins the hard-coded limits from the constitution', () => {
    expect(RISK_CONSTANTS.MAX_OPEN_POSITIONS).toBe(5);
    expect(RISK_CONSTANTS.MAX_ORDERS_PER_HOUR).toBe(10);
    expect(RISK_CONSTANTS.MIN_POSITION_SIZE_PCT).toBe(2);
    expect(RISK_CONSTANTS.MAX_POSITION_SIZE_PCT).toBe(5);
    expect(RISK_CONSTANTS.STOP_LOSS_PCT).toBe(-2);
    expect(RISK_CONSTANTS.MAX_DAILY_DRAWDOWN_PCT).toBe(3);
    expect(RISK_CONSTANTS.STALENESS_LIMIT_MS).toBe(1500);
    expect(RISK_CONSTANTS.RECONCILIATION_INTERVAL_MS).toBe(15_000);
    expect(RISK_CONSTANTS.KILL_SWITCH_DEADLINE_MS).toBe(500);
    expect(RISK_CONSTANTS.ORDER_TIMEOUT_MS).toBe(5_000);
  });
});
