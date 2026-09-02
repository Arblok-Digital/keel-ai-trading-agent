import type { NormalizedDepth, NormalizedTrade } from '../../types/exchange.js';
import { timeService } from '../ingestion/time-sync.js';

export interface MicroSnapshot {
  depth: NormalizedDepth;
  trades: NormalizedTrade[];
  atServerMs: number;
}

const MAX_DEPTH_SNAPSHOTS = 50;
const MAX_TRADE_TICKS = 200;

export class TemporalMicrostructureMemory {
  private depths = new Map<string, NormalizedDepth[]>();
  private trades = new Map<string, NormalizedTrade[]>();

  recordDepth(depth: NormalizedDepth): void {
    const list = this.depths.get(depth.symbol) ?? [];
    list.push(depth);
    if (list.length > MAX_DEPTH_SNAPSHOTS) list.shift();
    this.depths.set(depth.symbol, list);
  }

  recordTrades(symbol: string, trades: NormalizedTrade[]): void {
    const list = this.trades.get(symbol) ?? [];
    list.push(...trades);
    if (list.length > MAX_TRADE_TICKS) list.splice(0, list.length - MAX_TRADE_TICKS);
    this.trades.set(symbol, list);
  }

  recentDepth(symbol: string): NormalizedDepth | null {
    return this.depths.get(symbol)?.at(-1) ?? null;
  }

  depthHistory(symbol: string, windowMs: number): NormalizedDepth[] {
    const all = this.depths.get(symbol) ?? [];
    const now = all.at(-1)?.tsServerMs ?? 0;
    return all.filter((d) => now - d.tsServerMs <= windowMs);
  }

  tradeHistory(symbol: string, windowMs: number): NormalizedTrade[] {
    const all = this.trades.get(symbol) ?? [];
    const now = timeService.now();
    return all.filter((t) => now - t.tsServerMs <= windowMs);
  }

  getDelta(symbol: string, windowMs: number): MicroDelta {
    const snapshots = this.depthHistory(symbol, windowMs);
    if (snapshots.length < 2) {
    return { priceChangePct: 0, buyNotionalUsd: 0, sellNotionalUsd: 0, netTakerBuyUsd: 0, tradeCount: 0, deltaSeconds: 0 };
  }
  const oldest = snapshots[0]!;
  const newest = snapshots[snapshots.length - 1]!;
  const oldBid = oldest.bids[0]?.price;
  const oldAsk = oldest.asks[0]?.price;
  const newBid = newest.bids[0]?.price;
  const newAsk = newest.asks[0]?.price;
  const oldMid = oldBid !== undefined && oldAsk !== undefined ? (oldBid + oldAsk) / 2 : 0;
  const newMid = newBid !== undefined && newAsk !== undefined ? (newBid + newAsk) / 2 : 0;

    const trades = this.tradeHistory(symbol, windowMs);
    let buy = 0;
    let sell = 0;
    for (const t of trades) {
      if (t.isBuyerMaker) sell += t.notionalUsd;
      else buy += t.notionalUsd;
    }

    return {
      priceChangePct: oldMid > 0 ? ((newMid - oldMid) / oldMid) * 100 : 0,
      buyNotionalUsd: buy,
      sellNotionalUsd: sell,
      netTakerBuyUsd: buy - sell,
      tradeCount: trades.length,
      deltaSeconds: (newest.tsServerMs - oldest.tsServerMs) / 1000,
    };
  }
}

export interface MicroDelta {
  priceChangePct: number;
  buyNotionalUsd: number;
  sellNotionalUsd: number;
  netTakerBuyUsd: number;
  tradeCount: number;
  deltaSeconds: number;
}

export const temporalMemory = new TemporalMicrostructureMemory();
