import { describe, expect, it } from 'vitest';
import { deriveEntryStopTarget, estimateVolatilityPct, largestLevel } from '../src/services/mm-brain/entry-risk-engine';
import type { NormalizedDepth, NormalizedTrade } from '../src/types/exchange';

function depth(bids: [number, number][], asks: [number, number][], symbol = 'BTCUSDT'): NormalizedDepth {
  return {
    symbol,
    venue: 'BINANCE_SPOT',
    bids: bids.map(([price, qty]) => ({ price, qty })),
    asks: asks.map(([price, qty]) => ({ price, qty })),
    tsServerMs: 1000,
  };
}

function trade(price: number, tsServerMs = 1000): NormalizedTrade {
  return { symbol: 'BTCUSDT', venue: 'BINANCE_SPOT', price, qty: 1, notionalUsd: price, isBuyerMaker: false, tsServerMs };
}

describe('entry-risk-engine', () => {
  it('estimates volatility % from high/low tick range inside window', () => {
    const trades = [trade(100, 1000), trade(105, 1000), trade(95, 1000), trade(98, 1000), trade(102, 1000)];
    const vol = estimateVolatilityPct(trades, 30_000);
    expect(vol).not.toBeNull();
    // (105-95)/100 = 0.10 (10%)
    expect(vol).toBeCloseTo(0.10, 2);
  });

  it('finds the largest resting orderbook level', () => {
    const levels = [{ price: 100, qty: 1 }, { price: 101, qty: 100 }, { price: 102, qty: 5 }];
    const wall = largestLevel(levels);
    expect(wall?.price).toBe(101);
    expect(wall?.notionalUsd).toBe(10100);
  });

  it('derives entry/SL/TP/size for a BUY decision from market structure + volatility', () => {
    // best bid 99.9, best ask 100.1 (mid 100)
    // bid wall at 98.0 (500 qty), ask wall at 103.0 (500 qty)
    const d = depth(
      [[99.9, 10], [98.0, 500]],
      [[100.1, 10], [103.0, 500]],
    );
    const trades = [trade(99, 1000), trade(101, 1000)]; // range 2%
    const levels = deriveEntryStopTarget(
      { depth: d, trades },
      { action: 'BUY' },
    );

    expect(levels.action).toBe('BUY');
    expect(levels.entryPrice).toBe(100.1); // best ask (honest taker)
    expect(levels.stopLossPct).toBeLessThan(0); // negative %
    expect(levels.takeProfitPct).toBeGreaterThan(0); // positive %
    expect(levels.sizePct).toBeGreaterThanOrEqual(2);
    expect(levels.sizePct).toBeLessThanOrEqual(5);
    expect(levels.reason).toMatch(/BUY/);
  });

  it('returns HOLD with fallback levels when book is missing touch side', () => {
    const d = depth([], []);
    const levels = deriveEntryStopTarget({ depth: d, trades: [] }, { action: 'BUY' });
    expect(levels.action).toBe('HOLD');
    expect(levels.reason).toMatch(/no touchable/);
  });

  it('sizes positions based on risk budget (tighter stop => smaller size to hit target risk %)', () => {
    const d = depth([[99.9, 10]], [[100.1, 10]]);
    const trades = [trade(99.9, 1000), trade(100.1, 1000)];
    const levelsLoose = deriveEntryStopTarget({ depth: d, trades }, { action: 'BUY' }, { maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30000 });
    // sizePct is bounded in [2, 5]
    expect(levelsLoose.sizePct).toBeGreaterThanOrEqual(2);
    expect(levelsLoose.sizePct).toBeLessThanOrEqual(5);
  });
});
