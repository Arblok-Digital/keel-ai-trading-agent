import { RISK_CONSTANTS } from '../../config/risk-constants.js';

export function computeDrawdownPct(currentEquityUsd: number, highWaterMarkUsd: number): number | null {
  if (!Number.isFinite(currentEquityUsd) || !Number.isFinite(highWaterMarkUsd)) return null;
  if (highWaterMarkUsd <= 0) return null;
  if (currentEquityUsd >= highWaterMarkUsd) return 0;
  return Math.round(((highWaterMarkUsd - currentEquityUsd) / highWaterMarkUsd) * 10000) / 100;
}

export function updateHighWaterMark(previousHwmUsd: number, currentEquityUsd: number): number {
  return Math.max(previousHwmUsd, currentEquityUsd);
}

export function shouldAutoHalt(drawdownPct: number | null, limitPct: number = RISK_CONSTANTS.MAX_DAILY_DRAWDOWN_PCT): boolean {
  return drawdownPct !== null && drawdownPct >= limitPct;
}

export class IntradayHighWaterMark {
  private hwmUsd: number;

  constructor(initialEquityUsd: number) {
    this.hwmUsd = initialEquityUsd;
  }

  observe(equityUsd: number): { drawdownPct: number | null; halted: boolean } {
    this.hwmUsd = updateHighWaterMark(this.hwmUsd, equityUsd);
    const drawdownPct = computeDrawdownPct(equityUsd, this.hwmUsd);
    return { drawdownPct, halted: shouldAutoHalt(drawdownPct) };
  }

  current(): number {
    return this.hwmUsd;
  }
}
