import { describe, expect, it } from 'vitest';
import {
  computeDrawdownPct,
  IntradayHighWaterMark,
  shouldAutoHalt,
  updateHighWaterMark,
} from '../src/services/risk/drawdown-monitor';
import { RISK_CONSTANTS } from '../src/config/risk-constants';

describe('drawdown monitor', () => {
  it('computes percentage drop from high-water mark', () => {
    expect(computeDrawdownPct(9700, 10000)).toBeCloseTo(3);
    expect(computeDrawdownPct(10000, 10000)).toBe(0);
    expect(computeDrawdownPct(10500, 10000)).toBe(0);
  });

  it('returns null when the high-water mark is not positive', () => {
    expect(computeDrawdownPct(500, 0)).toBeNull();
    expect(computeDrawdownPct(500, -100)).toBeNull();
    expect(computeDrawdownPct(Number.NaN, 100)).toBeNull();
  });

  it('keeps a monotonic high-water mark', () => {
    let hwm = updateHighWaterMark(10_000, 10_500);
    hwm = updateHighWaterMark(hwm, 9_800);
    expect(hwm).toBe(10_500);
  });

  it('auto-halts exactly at the 3% limit boundary', () => {
    expect(shouldAutoHalt(3)).toBe(true);
    expect(shouldAutoHalt(2.999)).toBe(false);
    expect(shouldAutoHalt(null)).toBe(false);
    expect(shouldAutoHalt(3, RISK_CONSTANTS.MAX_DAILY_DRAWDOWN_PCT)).toBe(true);
  });

  it('IntradayHighWaterMark observes equity and flags halt', () => {
    const monitor = new IntradayHighWaterMark(10_000);
    expect(monitor.observe(10_200)).toEqual({ drawdownPct: 0, halted: false });
    const crash = monitor.observe(9_800);
    expect(crash.drawdownPct).toBeCloseTo(3.92, 2);
    expect(crash.halted).toBe(true);
  });
});
