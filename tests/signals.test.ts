import { describe, expect, it } from 'vitest';
import { generateSignal, parseOrDiscard } from '../src/services/mm-brain/signal-generator';
import { evaluateConfluence } from '../src/services/mm-brain/confluence-matrix';
import { classifyFlow } from '../src/services/mm-brain/smart-money-tracker';
import { mapLiquidity } from '../src/services/mm-brain/liquidity-mapper';
import type { NormalizedDepth, NormalizedTrade } from '../src/types/exchange';

function depth(): NormalizedDepth {
  return {
    symbol: 'BTCUSDT',
    venue: 'BINANCE_SPOT',
    bids: [
      { price: 59_900, qty: 2 },
      { price: 59_800, qty: 5 },
    ],
    asks: [
      { price: 60_000, qty: 3 },
      { price: 60_100, qty: 4 },
    ],
    tsServerMs: 1,
  };
}

function trade(notionalUsd: number, isBuyerMaker: boolean): NormalizedTrade {
  return {
    symbol: 'BTCUSDT',
    venue: 'BINANCE_SPOT',
    price: 60_000,
    qty: notionalUsd / 60_000,
    notionalUsd,
    isBuyerMaker,
    tsServerMs: 1,
  };
}

describe('MM signal generator', () => {
  const alignedBull = { m15: 'BULLISH', h1: 'BULLISH', h4: 'BULLISH', d1: 'BULLISH' } as const;

  it('rejects the naked indicator (no trades => NEUTRAL flow => discard)', () => {
    const result = generateSignal({
      symbol: 'BTCUSDT',
      venue: 'BINANCE_SPOT',
      depth: depth(),
      recentTrades: [],
      mtfBias: alignedBull,
      narrativeVelocity: 10,
      entryPrice: 60_000,
      detectedAtServerMs: 1,
    });
    expect(result.signal).toBeNull();
    expect(result.discardedReason).toMatch(/neutral/i);
  });

  it('accepts a fully-armed institutional signal', () => {
    const result = generateSignal({
      symbol: 'BTCUSDT',
      venue: 'BINANCE_SPOT',
      depth: depth(),
      recentTrades: [trade(40_000, false), trade(30_000, false), trade(5_000, true), trade(4_000, true)],
      mtfBias: alignedBull,
      narrativeVelocity: 15,
      entryPrice: 60_000,
      detectedAtServerMs: 1,
    });
    expect(result.discardedReason).toBeNull();
    expect(result.signal?.action).toBe('BUY');
    expect(result.signal?.smartMoneyFlow).toBe('ACCUMULATION');
    expect(result.signal?.stopLossPct).toBeLessThan(0);
    expect(result.signal?.stopLossPct).toBeGreaterThanOrEqual(-15);
  });

  it('rejects conflicting MTF timeframes at schema level', () => {
    const parsed = parseOrDiscard({
      symbol: 'BTCUSDT',
      venue: 'BINANCE_SPOT',
      action: 'BUY',
      mmThesis: 'a thesis long enough to pass minimum length checks for sure',
      smartMoneyFlow: 'ACCUMULATION',
      liquidityDepthUsd: 100_000,
      narrativeVelocity: 0,
      mtfBias: { m15: 'BEARISH', h1: 'BEARISH', h4: 'BEARISH', d1: 'BULLISH' },
      entryPrice: 1,
      sizePct: 3,
      stopLossPct: -2,
      takeProfitPct: 4,
      detectedAtServerMs: 0,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/confluence/i);
  });

  it('allows M15 pullback entry when D1+H4 are strongly aligned', () => {
    const parsed = parseOrDiscard({
      symbol: 'BTCUSDT',
      venue: 'BINANCE_SPOT',
      action: 'BUY',
      mmThesis: 'pullback entry into strong higher-timeframe trend with thesis below',
      smartMoneyFlow: 'ACCUMULATION',
      liquidityDepthUsd: 100_000,
      narrativeVelocity: 0,
      mtfBias: { m15: 'BEARISH', h1: 'BULLISH', h4: 'BULLISH', d1: 'BULLISH' },
      entryPrice: 1,
      sizePct: 3,
      stopLossPct: -2,
      takeProfitPct: 4,
      detectedAtServerMs: 0,
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects action contradicting flow direction', () => {
    const parsed = parseOrDiscard({
      symbol: 'BTCUSDT',
      venue: 'RAYDIUM',
      action: 'BUY',
      mmThesis: 'distribution phase thesis with enough characters here definitely',
      smartMoneyFlow: 'DISTRIBUTION',
      liquidityDepthUsd: 50_000,
      narrativeVelocity: 0,
      mtfBias: { m15: 'BEARISH', h1: 'BEARISH', h4: 'BEARISH', d1: 'BEARISH' },
      entryPrice: 1,
      sizePct: 3,
      stopLossPct: -2,
      takeProfitPct: 4,
      detectedAtServerMs: 0,
    });
    expect(parsed.ok).toBe(false);
  });
});

describe('smart money classifier', () => {
  it('flags accumulation on aggressive buy dominance with large prints', () => {
    const verdict = classifyFlow([trade(50_000, false), trade(20_000, true)]);
    expect(verdict.flow).toBe('ACCUMULATION');
  });

  it('flags distribution on aggressive sell dominance', () => {
    const verdict = classifyFlow([trade(50_000, true), trade(20_000, false)]);
    expect(verdict.flow).toBe('DISTRIBUTION');
  });

  it('stays neutral when dominance is mixed', () => {
    const verdict = classifyFlow([trade(10_000, false), trade(9_000, true)]);
    expect(verdict.flow).toBe('NEUTRAL');
  });
});

describe('liquidity mapper', () => {
  it('computes band depth, spread and wall side', () => {
    const profile = mapLiquidity(depth(), 50);
    expect(profile.bidDepthUsdBps).toBeGreaterThan(300_000);
    expect(profile.spreadBps).toBeCloseTo(16.69, 1);
    expect(['BID', 'ASK']).toContain(profile.wallSide ?? '');
  });

  it('handles empty books without crashing', () => {
    const profile = mapLiquidity({ ...depth(), bids: [], asks: [] }, 50);
    expect(profile.bestBid).toBeNull();
    expect(profile.spreadBps).toBeNull();
    expect(profile.wallSide).toBeNull();
  });
});

describe('confluence matrix', () => {
  it('detects alignment and direction', () => {
    const verdict = evaluateConfluence({ m15: 'BULLISH', h1: 'BULLISH', h4: 'BULLISH', d1: 'BULLISH' });
    expect(verdict.aligned).toBe(true);
    expect(verdict.direction).toBe('BULLISH');
  });

  it('lists disagreeing frames', () => {
    const verdict = evaluateConfluence({ m15: 'BEARISH', h1: 'NEUTRAL', h4: 'BULLISH', d1: 'BULLISH' });
    expect(verdict.aligned).toBe(false);
    expect(verdict.disagreeingFrames).toEqual(['m15', 'h1']);
  });
});
