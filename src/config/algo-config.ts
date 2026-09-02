/**
 * Algo config — 2 trading modes: SCALP (microstructure, 15s-5m) vs SWING (daily, ML-filtered).
 * SCALP data (signal_features 1m) is the training feed for SWING ML shadow model.
 */
export type TradingStrategy = 'SCALP' | 'SWING';

export interface ScalpConfig {
  // orderbook microstructure thresholds (Gate 15s)
  imbalanceBuy: number;   // bid/ask >1.15 => BUY
  imbalanceSell: number;  // <0.85 => SELL
  spreadMaxPct: number;   // skip if spread too wide
  // ATR fallback when candle fetch fails
  atrFallbackPct: number; // 0.004 = 0.4% of mid
  // risk
  riskPct: number;        // 0.5% equity risk per trade
  rMultiple: number;      // TP = 1.5 × SL distance (when no wall)
  minTpPct: number;       // scalper minimum shown tp
}

export interface SwingConfig {
  // MTF dominance — daily trade, hold 1-3 days
  mtfWeights: { d1: number; h4: number; h1: number; m15: number };
  confluenceThreshold: number; // 0.7
  minHoldBars: number;    // bars before TP evaluation
  maxHoldDays: number;    // forced timeout
  // ML shadow filter
  mlMinProb: number;      // 0.55 threshold to allow swing entry (shadow first)
  mlShadowOnly: boolean;  // true = log prob but don't block yet (collect 200 samples)
  // swing TP/SL derived from H4/D1 ATR, not 15s book
  rMultiple: number;      // 2.0 for swing
  atrTf: 'h4' | 'd1';
}

export const ALGO_CONFIG: Record<TradingStrategy, ScalpConfig | SwingConfig> = {
  SCALP: {
    imbalanceBuy: 1.15,
    imbalanceSell: 0.85,
    spreadMaxPct: 0.15,
    atrFallbackPct: 0.004,
    riskPct: 0.5,
    rMultiple: 1.5,
    minTpPct: 0.9,
  } as ScalpConfig,
  SWING: {
    mtfWeights: { d1: 0.4, h4: 0.3, h1: 0.2, m15: 0.1 },
    confluenceThreshold: 0.7,
    minHoldBars: 6,
    maxHoldDays: 3,
    mlMinProb: 0.55,
    mlShadowOnly: true, // until 200 samples validated
    rMultiple: 2.0,
    atrTf: 'h4',
  } as SwingConfig,
} as const;

export function isScalpCfg(c: ScalpConfig | SwingConfig): c is ScalpConfig {
  return (c as ScalpConfig).imbalanceBuy !== undefined;
}
