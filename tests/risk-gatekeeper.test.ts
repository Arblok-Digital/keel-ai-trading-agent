import { describe, expect, it } from 'vitest';
import { evaluateRisk, RISK_REASONS, type RiskCandidate, type RiskLimitsView, type RiskSnapshot } from '../src/services/risk/gatekeeper';

const limits: RiskLimitsView = {
  maxOpenPositions: 5,
  maxOrdersPerHour: 10,
  maxDrawdownPct: 3,
  minPositionSizePct: 2,
  maxPositionSizePct: 5,
  stopLossPct: -2,
};

function candidate(overrides: Partial<RiskCandidate> = {}): RiskCandidate {
  return { venue: 'BINANCE_SPOT', action: 'BUY', sizePct: 3, stopLossPct: -2, ...overrides };
}

function snapshot(overrides: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return {
    openPositions: 0,
    ordersLastHour: 0,
    dailyDrawdownPct: 0,
    killSwitchActive: false,
    ...overrides,
  };
}

describe('risk gatekeeper evaluator', () => {
  it('passes a clean BUY', () => {
    const result = evaluateRisk(candidate(), snapshot(), limits);
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('rejects non-spot venue (spot-only zero-bypass)', () => {
    const result = evaluateRisk(candidate({ venue: 'MOON_PERPS' as unknown as RiskCandidate['venue'] }), snapshot(), limits);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain(RISK_REASONS.SPOT_ONLY_VIOLATION);
  });

  it('enforces max 5 concurrent positions on BUY but allows closing SELL', () => {
    const full = snapshot({ openPositions: 5 });
    const buy = evaluateRisk(candidate(), full, limits);
    expect(buy.reasons).toContain(RISK_REASONS.MAX_OPEN_POSITIONS);
    const sell = evaluateRisk(candidate({ action: 'SELL' }), full, limits);
    expect(sell.passed).toBe(true);
    const fourOpen = evaluateRisk(candidate(), snapshot({ openPositions: 4 }), limits);
    expect(fourOpen.passed).toBe(true);
  });

  it('enforces max 10 orders per hour using server-time window count', () => {
    const saturated = snapshot({ ordersLastHour: 10 });
    expect(evaluateRisk(candidate(), saturated, limits).reasons).toContain(RISK_REASONS.ORDER_RATE_LIMIT);
    expect(evaluateRisk(candidate(), snapshot({ ordersLastHour: 9 }), limits).passed).toBe(true);
  });

  it('bounds position size to 2-5%', () => {
    expect(evaluateRisk(candidate({ sizePct: 1.9 }), snapshot(), limits).reasons).toContain(
      RISK_REASONS.POSITION_SIZE_OUT_OF_BAND,
    );
    expect(evaluateRisk(candidate({ sizePct: 5.01 }), snapshot(), limits).reasons).toContain(
      RISK_REASONS.POSITION_SIZE_OUT_OF_BAND,
    );
    expect(evaluateRisk(candidate({ sizePct: 2 }), snapshot(), limits).passed).toBe(true);
    expect(evaluateRisk(candidate({ sizePct: 5 }), snapshot(), limits).passed).toBe(true);
  });

  it('requires some stop loss protection', () => {
    expect(evaluateRisk(candidate({ stopLossPct: 0 }), snapshot(), limits).reasons).toContain(
      RISK_REASONS.NO_STOP_LOSS_PROTECTION,
    );
  });

  it('permits data-driven stop losses tighter than the baseline limit', () => {
    expect(evaluateRisk(candidate({ stopLossPct: -0.5 }), snapshot(), limits).passed).toBe(true);
    expect(evaluateRisk(candidate({ stopLossPct: -2 }), snapshot(), limits).passed).toBe(true);
    expect(evaluateRisk(candidate({ stopLossPct: -3 }), snapshot(), limits).passed).toBe(true);
  });

  it('halts at >= 3% daily drawdown (boundary inclusive)', () => {
    expect(evaluateRisk(candidate(), snapshot({ dailyDrawdownPct: 3 }), limits).reasons).toContain(
      RISK_REASONS.DAILY_DRAWDOWN_BREACH,
    );
    expect(evaluateRisk(candidate(), snapshot({ dailyDrawdownPct: 2.99 }), limits).passed).toBe(true);
  });

  it('blocks everything while kill switch is active', () => {
    const result = evaluateRisk(candidate(), snapshot({ killSwitchActive: true }), limits);
    expect(result.reasons).toContain(RISK_REASONS.KILL_SWITCH_ENGAGED);
  });

  it('aggregates every violated rule in one evaluation', () => {
    const result = evaluateRisk(
      candidate({ sizePct: 8, stopLossPct: 0.5 }),
      snapshot({ openPositions: 5, ordersLastHour: 10, dailyDrawdownPct: 3, killSwitchActive: true }),
      limits,
    );
    expect(result.passed).toBe(false);
    expect(result.reasons).toEqual([
      RISK_REASONS.KILL_SWITCH_ENGAGED,
      RISK_REASONS.DAILY_DRAWDOWN_BREACH,
      RISK_REASONS.MAX_OPEN_POSITIONS,
      RISK_REASONS.ORDER_RATE_LIMIT,
      RISK_REASONS.POSITION_SIZE_OUT_OF_BAND,
      RISK_REASONS.NO_STOP_LOSS_PROTECTION,
    ]);
  });
});
