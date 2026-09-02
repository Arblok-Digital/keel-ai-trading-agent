import type { NormalizedTrade } from '../../types/exchange.js';

export interface Kline {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

export type Tf = 'm15' | 'h1' | 'h4' | 'd1';
const TF_MS: Record<Tf, number> = { m15: 15*60*1000, h1: 60*60*1000, h4: 4*60*60*1000, d1: 24*60*60*1000 };
const ALL_TF: Tf[] = ['m15','h1','h4','d1'];
const MAX_BARS = 500;

export class KlineAggregator {
  private buffers = new Map<string, Map<Tf, Kline[]>>();
  private current = new Map<string, Map<Tf, Kline>>();

  private bucketStart(ts: number, tf: Tf): number {
    return Math.floor(ts / TF_MS[tf]) * TF_MS[tf];
  }

  onTrade(symbol: string, trade: NormalizedTrade): void {
    const sym = symbol.toUpperCase();
    for (const tf of ALL_TF) {
      const bStart = this.bucketStart(trade.tsServerMs, tf);
      const bEnd = bStart + TF_MS[tf] - 1;
      let curMap = this.current.get(sym);
      if (!curMap) { curMap = new Map(); this.current.set(sym, curMap); }
      let cur = curMap.get(tf);
      if (!cur || cur.openTime !== bStart) {
        if (cur) this.pushClosed(sym, tf, cur);
        cur = { openTime: bStart, closeTime: bEnd, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: trade.notionalUsd, trades: 1 };
        curMap.set(tf, cur);
      } else {
        cur.high = Math.max(cur.high, trade.price);
        cur.low = Math.min(cur.low, trade.price);
        cur.close = trade.price;
        cur.volume += trade.notionalUsd;
        cur.trades += 1;
      }
    }
  }

  private pushClosed(sym: string, tf: Tf, k: Kline): void {
    let m = this.buffers.get(sym);
    if (!m) { m = new Map(); this.buffers.set(sym, m); }
    let arr = m.get(tf);
    if (!arr) { arr = []; m.set(tf, arr); }
    arr.push({ ...k });
    if (arr.length > MAX_BARS) arr.shift();
  }

  getKlines(symbol: string): Record<Tf, Kline[]> {
    const sym = symbol.toUpperCase();
    const m = this.buffers.get(sym);
    const out: Record<Tf, Kline[]> = { m15: [], h1: [], h4: [], d1: [] };
    for (const tf of ALL_TF) out[tf] = m?.get(tf)?.slice() ?? [];
    return out;
  }

  getClosedKline(symbol: string, tf: Tf): Kline | null {
    const arr = this.buffers.get(symbol.toUpperCase())?.get(tf);
    return arr?.at(-1) ?? null;
  }

  getCurrentKline(symbol: string, tf: Tf): Kline | null {
    return this.current.get(symbol.toUpperCase())?.get(tf) ?? null;
  }

  seedKline(symbol: string, tf: Tf, kline: Kline): void {
    let m = this.buffers.get(symbol.toUpperCase());
    if (!m) { m = new Map(); this.buffers.set(symbol.toUpperCase(), m); }
    let arr = m.get(tf);
    if (!arr) { arr = []; m.set(tf, arr); }
    const idx = arr.findIndex((x) => x.openTime === kline.openTime);
    if (idx >= 0) arr[idx] = { ...kline };
    else {
      arr.push({ ...kline });
      arr.sort((a, b) => a.openTime - b.openTime);
      if (arr.length > MAX_BARS) arr.splice(0, arr.length - MAX_BARS);
    }
  }

  seedKlines(symbol: string, tf: Tf, klines: Kline[]): void {
    for (const k of klines) this.seedKline(symbol, tf, k);
  }
}
