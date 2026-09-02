import type { NormalizedDepth, NormalizedTrade } from '../../types/exchange.js';
import { RISK_CONSTANTS } from '../../config/risk-constants.js';

export interface MarketContext {
  depth: NormalizedDepth;
  trades: NormalizedTrade[];
}

export interface TradeDirection {
  action: 'BUY' | 'SELL' | 'HOLD';
}

export interface DerivedLevels {
  action: 'BUY' | 'SELL' | 'HOLD';
  entryPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
  sizePct: number;
  volatilityPct: number;
  stopAbs: number;
  targetAbs: number;
  reason: string;
}

export interface RiskBudget {
  maxRiskPct: number; // % of equity risked on the stop (e.g. 0.5% -> used for sizing)
  rewardRatio: number; // TP distance / SL distance
  volatilityWindowMs: number; // look-back for volatility estimate
}

const DEFAULT_BUDGET: RiskBudget = {
  maxRiskPct: 0.5,
  rewardRatio: 1.5,
  volatilityWindowMs: 30_000,
};

// ---- volatility proxy from trade ticks (ATR-style range over window) ----
export function estimateVolatilityPct(trades: NormalizedTrade[], windowMs: number): number | null {
  const now = trades.length ? Math.max(...trades.map((t) => t.tsServerMs)) : 0;
  const window = trades.filter((t) => now - t.tsServerMs <= windowMs);
  if (window.length < 5) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const t of window) {
    if (t.price > high) high = t.price;
    if (t.price < low) low = t.price;
  }
  const mid = (high + low) / 2;
  if (mid <= 0) return null;
  return (high - low) / mid;
}

// ---- largest resting level on a side ----
export function largestLevel(levels: Array<{ price: number; qty: number }>): { price: number; notionalUsd: number } | null {
  let best: { price: number; notionalUsd: number } | null = null;
  for (const l of levels) {
    const notional = l.price * l.qty;
    if (!best || notional > best.notionalUsd) best = { price: l.price, notionalUsd: notional };
  }
  return best;
}

export function deriveEntryStopTarget(ctx: MarketContext, direction?: TradeDirection, budget: RiskBudget = DEFAULT_BUDGET): DerivedLevels {
  const { depth, trades } = ctx;
  const bestBid = depth.bids[0]?.price ?? null;
  const bestAsk = depth.asks[0]?.price ?? null;
  if (!bestBid || !bestAsk) {
    return { action: 'HOLD', entryPrice: 0, stopLossPct: -2, takeProfitPct: 4, sizePct: 3, volatilityPct: 0, stopAbs: 0, targetAbs: 0, reason: 'no touchable book' };
  }
  const mid = (bestBid + bestAsk) / 2;

  const volPct = estimateVolatilityPct(trades, budget.volatilityWindowMs);
  const volatility = volPct ?? 0.004; // fallback 0.4% if too few ticks

  // structural levels from liquidity
  const bidWall = largestLevel(depth.bids);
  const askWall = largestLevel(depth.asks);

  const action = direction?.action ?? (bestAsk > mid ? 'BUY' : bestBid < mid ? 'SELL' : 'HOLD');
  if (action === 'HOLD') {
    return { action: 'HOLD', entryPrice: mid, stopLossPct: -2, takeProfitPct: 4, sizePct: 3, volatilityPct: Number((volatility * 100).toFixed(2)), stopAbs: mid, targetAbs: mid, reason: 'no directional edge' };
  }

  // entry at the touch side (honest taker price)
  const entry = action === 'BUY' ? bestAsk : bestBid;

  // --- stop loss: below nearest structural support (BUY) / above resistance (SELL),
  //      floored by a volatility multiple so we don't get stopped by noise ---
  const volStopFloor = volatility * 0.75; // 0.75 ATR-distance minimum
  let stopAbs: number;
  let stopRationale: string;
  if (action === 'BUY') {
    const support = bidWall && bidWall.price < entry ? bidWall.price : null;
    const stopFromStructure = support ? entry - (entry - support) : null;
    const stopFromVol = entry * (1 - volStopFloor);
    const minAllow = entry * (1 - volStopFloor * 0.5);
    if (support && stopFromStructure! > minAllow) {
      stopAbs = stopFromStructure!;
      stopRationale = `below structure support @${support.toFixed(depthPrecision(entry))}`;
    } else {
      stopAbs = stopFromVol;
      stopRationale = `0.75×vol(${(volatility * 100).toFixed(2)}%) below entry`;
    }
  } else {
    const resist = askWall && askWall.price > entry ? askWall.price : null;
    const stopFromStructure = resist ? entry + (resist - entry) : null;
    const stopFromVol = entry * (1 + volStopFloor);
    const minAllow = entry * (1 + volStopFloor * 0.5);
    if (resist && stopFromStructure! < minAllow) {
      stopAbs = stopFromStructure!;
      stopRationale = `above structure resistance @${resist.toFixed(depthPrecision(entry))}`;
    } else {
      stopAbs = stopFromVol;
      stopRationale = `0.75×vol(${(volatility * 100).toFixed(2)}%) above entry`;
    }
  }

  const stopDistance = Math.abs(entry - stopAbs);
  const stopLossPct = entry > 0 ? -((stopDistance / entry) * 100) : -2;

  // --- target: opposing wall if far enough, else rewardRatio×SL distance ---
  let targetAbs: number;
  let tpRationale: string;
  const rewardDistance = stopDistance * budget.rewardRatio;
  if (action === 'BUY') {
    const wallTp = askWall && askWall.price > entry ? askWall.price : null;
    if (wallTp && wallTp - entry >= rewardDistance * 0.6) {
      targetAbs = wallTp;
      tpRationale = `at ask wall @${wallTp.toFixed(depthPrecision(entry))}`;
    } else {
      targetAbs = entry + rewardDistance;
      tpRationale = `${budget.rewardRatio}×SL distance`;
    }
  } else {
    const wallTp = bidWall && bidWall.price < entry ? bidWall.price : null;
    if (wallTp && entry - wallTp >= rewardDistance * 0.6) {
      targetAbs = wallTp;
      tpRationale = `at bid wall @${wallTp.toFixed(depthPrecision(entry))}`;
    } else {
      targetAbs = entry - rewardDistance;
      tpRationale = `${budget.rewardRatio}×SL distance`;
    }
  }
  const takeProfitPct = entry > 0 ? ((targetAbs - entry) / entry) * 100 : 4;

  // --- risk-based sizing: risk maxRiskPct of equity on the stop distance, clamp to gate band ---
  const stopPctPos = Math.abs(stopLossPct);
  const rawSize = stopPctPos > 0 ? (budget.maxRiskPct / stopPctPos) * 100 : 3;
  const sizePct = Math.max(RISK_CONSTANTS.MIN_POSITION_SIZE_PCT, Math.min(RISK_CONSTANTS.MAX_POSITION_SIZE_PCT, Number(rawSize.toFixed(1))));

  return {
    action,
    entryPrice: Number(entry.toFixed(depthPrecision(entry))),
    stopLossPct: Number(stopLossPct.toFixed(2)),
    takeProfitPct: Number(takeProfitPct.toFixed(2)),
    sizePct,
    volatilityPct: Number((volatility * 100).toFixed(2)),
    stopAbs: Number(stopAbs.toFixed(depthPrecision(entry))),
    targetAbs: Number(targetAbs.toFixed(depthPrecision(entry))),
    reason: `${action} vol ${(volatility * 100).toFixed(2)}% · SL ${stopRationale} · TP ${tpRationale} · size ${sizePct}% (risk ${budget.maxRiskPct}%)`,
  };
}

function depthPrecision(price: number): number {
  if (price >= 1000) return 0;
  if (price >= 1) return 2;
  return Number(price.toString().split('.')[1]?.length ?? 2) + 2;
}
