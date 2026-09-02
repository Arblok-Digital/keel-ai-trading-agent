import { describe, expect, it } from 'vitest';
import { computeAbsorptionScore, classifyAbsorption } from '../src/services/mm-brain/absorption-engine';
import { analyzeWallDynamics } from '../src/services/mm-brain/wall-dynamics';
import { evaluateConfluence } from '../src/services/mm-brain/confluence-matrix';
import type { NormalizedDepth } from '../src/types/exchange';

function depth(bids: [number, number][], asks: [number, number][], symbol = 'BTCUSDT'): NormalizedDepth {
  return {
    symbol,
    venue: 'BINANCE_SPOT',
    bids: bids.map(([price, qty]) => ({ price, qty })),
    asks: asks.map(([price, qty]) => ({ price, qty })),
    tsServerMs: 1,
  };
}

describe('absorption engine', () => {
  it('yields high absorption score for heavy net buying inside a flat price range', () => {
    const verdict = classifyAbsorption({
      priceChangePct: 0.3,
      netTakerBuyUsd: 500_000,
      buyNotionalUsd: 750_000,
      sellNotionalUsd: 250_000,
      tradeCount: 40,
    });
    expect(verdict.score).toBeGreaterThan(75);
    expect(verdict.classification).toBe('ACCUMULATION');
    expect(verdict.isPreBreakoutAccumulation).toBe(true);
  });

  it('classifies distribution when net selling is absorbed in a flat range', () => {
    const verdict = classifyAbsorption({
      priceChangePct: -0.2,
      netTakerBuyUsd: -300_000,
      buyNotionalUsd: 100_000,
      sellNotionalUsd: 400_000,
      tradeCount: 30,
    });
    expect(verdict.classification).toBe('DISTRIBUTION');
  });

  it('stays neutral without enough trade participation', () => {
    const verdict = classifyAbsorption({
      priceChangePct: 0.1,
      netTakerBuyUsd: 600_000,
      buyNotionalUsd: 600_000,
      sellNotionalUsd: 0,
      tradeCount: 2,
    });
    expect(verdict.classification).toBe('NEUTRAL');
  });

  it('bases score on net taker volume relative to price range', () => {
    const high = computeAbsorptionScore({ priceChangePct: 0.2, netTakerBuyUsd: 100, buyNotionalUsd: 100, sellNotionalUsd: 0, tradeCount: 20 });
    const low = computeAbsorptionScore({ priceChangePct: 2.5, netTakerBuyUsd: 100, buyNotionalUsd: 100, sellNotionalUsd: 0, tradeCount: 20 });
    expect(high).toBeGreaterThan(low);
  });
});

describe('wall dynamics', () => {
  it('detects PULLED_SELL_WALL when a thick ask wall vanishes without fills', () => {
    const prev = depth([[99, 10]], [[100.1, 1], [101, 900]]);
    const current = depth([[99, 10]], [[100.1, 1], [101, 1]]);
    const verdict = analyzeWallDynamics({ prev, current });
    expect(verdict.action).toBe('PULLED_SELL_WALL');
    expect(verdict.pulledNotionalUsd).toBeGreaterThan(90_000);
  });

  it('detects BID_SUPPORT_UP when bid support moves closer to mid', () => {
    const prev = depth([[98, 500], [99, 5]], [[101, 5]]);
    const current = depth([[99.8, 500], [100, 5]], [[100.6, 5]]);
    const verdict = analyzeWallDynamics({ prev, current });
    expect(verdict.action).toBe('BID_SUPPORT_UP');
    expect(verdict.bidSupportShiftBps).toBeGreaterThanOrEqual(10);
  });

  it('returns NONE when no meaningful wall movement', () => {
    const snap = depth([[99, 5]], [[101, 5]]);
    const verdict = analyzeWallDynamics({ prev: snap, current: snap });
    expect(verdict.action).toBe('NONE');
  });

  it('returns NONE without a previous snapshot', () => {
    const current = depth([[99, 5]], [[101, 5]]);
    const verdict = analyzeWallDynamics({ prev: null, current });
    expect(verdict.action).toBe('NONE');
  });
});

describe('weighted MTF confluence', () => {
  it('treats D1+H4+H1 as aligned even with a bullish M15', () => {
    const verdict = evaluateConfluence({ m15: 'BULLISH', h1: 'BULLISH', h4: 'BULLISH', d1: 'BULLISH' });
    expect(verdict.aligned).toBe(true);
    expect(verdict.direction).toBe('BULLISH');
    expect(verdict.score).toBeGreaterThanOrEqual(0.7);
  });

  it('flags a genuinely conflicting matrix (D1 bearish, three bullish frames)', () => {
    const verdict = evaluateConfluence({ m15: 'BULLISH', h1: 'BULLISH', h4: 'BULLISH', d1: 'BEARISH' });
    expect(verdict.aligned).toBe(false);
  });

  it('allows pullback entry when D1+H4 strongly agree and M15 opposes', () => {
    const verdict = evaluateConfluence({ m15: 'BEARISH', h1: 'BULLISH', h4: 'BULLISH', d1: 'BULLISH' });
    expect(verdict.pullbackEntry).toBe(true);
    expect(verdict.direction).toBe('BULLISH');
  });
});
