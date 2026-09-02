import type { Kline, Tf } from '../ingestion/kline-aggregator.js';

export type TrendDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export interface MTFTrendResult { m15: TrendDirection; h1: TrendDirection; h4: TrendDirection; d1: TrendDirection; scores: Record<string, number>; }

export interface StructureBiasInput {
  klines: Kline[];
  highTfs?: Kline[][];
}

function atrWilder(klines: Kline[], period = 14): number {
  if (klines.length < 2) return 0;
  let atr = 0;
  for (let i = 1; i < klines.length; i++) {
    const k = klines[i]!; const pk = klines[i-1]!;
    const tr = Math.max(k.high - k.low, Math.abs(k.high - pk.close), Math.abs(k.low - pk.close));
    if (i === 1) atr = tr;
    else atr = (atr * (period - 1) + tr) / period;
  }
  return atr;
}

// ---- swing market-structure (HH/HL vs LH/LL + BOS + EMA regime) ----

function swingHighLow(klines: Kline[], lookback = 2): Array<{ idx: number; type: 'H' | 'L'; price: number }> {
  const out: Array<{ idx: number; type: 'H' | 'L'; price: number }> = [];
  if (klines.length < lookback * 2 + 1) return out;
  for (let i = lookback; i < klines.length - lookback; i++) {
    const k = klines[i]!;
    const isHigh = klines.slice(i - lookback, i + lookback + 1).every((x) => x.high <= k.high);
    const isLow = klines.slice(i - lookback, i + lookback + 1).every((x) => x.low >= k.low);
    if (isHigh) out.push({ idx: i, type: 'H', price: k.high });
    else if (isLow) out.push({ idx: i, type: 'L', price: k.low });
  }
  return out;
}

function bosDir(klines: Kline[]): TrendDirection | null {
  const pivots = swingHighLow(klines, 2);
  if (pivots.length < 2) return null;
  const lastClose = klines.at(-1)!.close;
  // last two highs/lows of same type
  const lastHighs = pivots.filter((p) => p.type === 'H').slice(-2);
  const lastLows = pivots.filter((p) => p.type === 'L').slice(-2);
  if (lastHighs.length === 2 && lastClose > lastHighs[1]!.price && lastHighs[1]!.price > lastHighs[0]!.price) return 'BULLISH';
  if (lastLows.length === 2 && lastClose < lastLows[1]!.price && lastLows[1]!.price < lastLows[0]!.price) return 'BEARISH';
  // range breakout proxy: close beyond 20-bar Donchian
  if (klines.length >= 21) {
    const hh20 = Math.max(...klines.slice(-21, -1).map((k) => k.high));
    const ll20 = Math.max(...klines.slice(-21, -1).map((k) => k.low));
    const ll = Math.min(...klines.slice(-21, -1).map((k) => k.low));
    if (lastClose > hh20) return 'BULLISH';
    void ll20; if (lastClose < ll) return 'BEARISH';
  }
  return null;
}

function emaRegime(klines: Kline[]): TrendDirection {
  if (klines.length < 21) return 'NEUTRAL';
  const emaShort = klines.slice(-9).reduce((s, k) => s + k.close, 0) / 9;
  const emaLong = klines.slice(-21).reduce((s, k) => s + k.close, 0) / 21;
  if (emaShort > emaLong * 1.001) return 'BULLISH';
  if (emaShort < emaLong * 0.999) return 'BEARISH';
  return 'NEUTRAL';
}

function fvgAvailable(klines: Kline[]): 'BULL' | 'BEAR' | null {
  if (klines.length < 3) return null;
  const a = klines[klines.length - 3]!, b = klines[klines.length - 2]!, c = klines[klines.length - 1]!;
  // Three-bar FVG: low(c) > high(a) (bull FVG gap), or high(c) < low(a) (bear)
  if (c.low > a.high) { void b; return 'BULL'; }
  if (c.high < a.low) { void b; return 'BEAR'; }
  return null;
}

function structureDir(klines: Kline[]): TrendDirection {
  if (klines.length < 10) return 'NEUTRAL';
  const bos = bosDir(klines);
  if (bos) return bos;
  const ema = emaRegime(klines);
  if (ema !== 'NEUTRAL') {
    const fvg = fvgAvailable(klines);
    if (fvg === 'BULL' && ema === 'BULLISH') return 'BULLISH';
    if (fvg === 'BEAR' && ema === 'BEARISH') return 'BEARISH';
    // even without FVG, EMA regime is the fallback
    return ema;
  }
  return 'NEUTRAL';
}

function supertrendDir(klines: Kline[], period = 10, mult = 3): TrendDirection {
  if (klines.length < period + 1) return structureDir(klines);
  const atr = atrWilder(klines, period);
  if (atr === 0) return structureDir(klines);
  const last = klines.at(-1)!;
  const hl2 = (last.high + last.low) / 2;
  const upper = hl2 + mult * atr;
  const lower = hl2 - mult * atr;
  if (last.close > upper) return 'BULLISH';
  if (last.close < lower) return 'BEARISH';
  return structureDir(klines);
}

export class MTFEngine {
  computeTrend(klines: Kline[]): TrendDirection {
    return supertrendDir(klines);
  }
  computeAll(_symbol: string, klines: Record<Tf, Kline[]>): MTFTrendResult {
    const scores: Record<string, number> = {};
    const res: MTFTrendResult = { m15: 'NEUTRAL', h1: 'NEUTRAL', h4: 'NEUTRAL', d1: 'NEUTRAL', scores };
    for (const tf of ['m15','h1','h4','d1'] as Tf[]) {
      const dir = supertrendDir(klines[tf]);
      (res as unknown as Record<string, TrendDirection>)[tf] = dir;
      scores[tf] = dir === 'BULLISH' ? 1 : dir === 'BEARISH' ? -1 : 0;
    }
    return res;
  }
}
