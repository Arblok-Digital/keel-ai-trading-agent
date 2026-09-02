import type { NormalizedDepth } from '../../types/exchange.js';

export interface LiquidityProfile {
  bidDepthUsdBps: number;
  askDepthUsdBps: number;
  bestBid: number | null;
  bestAsk: number | null;
  spreadBps: number | null;
  wallSide: 'BID' | 'ASK' | null;
  wallNotionalUsd: number;
}

export function mapLiquidity(depth: NormalizedDepth, bandBps = 50): LiquidityProfile {
  const bestBid = depth.bids[0]?.price ?? null;
  const bestAsk = depth.asks[0]?.price ?? null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;

  let bidDepthUsdBps = 0;
  for (const level of depth.bids) {
    if (mid === null || ((mid - level.price) / mid) * 10_000 > bandBps) break;
    bidDepthUsdBps += level.price * level.qty;
  }
  let askDepthUsdBps = 0;
  let maxAskLevel = 0;
  for (const level of depth.asks) {
    if (mid === null || ((level.price - mid) / mid) * 10_000 > bandBps) break;
    askDepthUsdBps += level.price * level.qty;
    maxAskLevel = Math.max(maxAskLevel, level.qty * level.price);
  }
  let maxBidLevel = 0;
  for (const level of depth.bids) {
    maxBidLevel = Math.max(maxBidLevel, level.qty * level.price);
  }

  const spreadBps =
    bestBid !== null && bestAsk !== null && bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 10_000 : null;

  const wallNotionalUsd = Math.max(maxAskLevel, maxBidLevel);
  return {
    bidDepthUsdBps: Math.round(bidDepthUsdBps),
    askDepthUsdBps: Math.round(askDepthUsdBps),
    bestBid,
    bestAsk,
    spreadBps: spreadBps === null ? null : Math.round(spreadBps * 100) / 100,
    wallSide: maxBidLevel > maxAskLevel ? 'BID' : maxAskLevel > 0 ? 'ASK' : null,
    wallNotionalUsd: Math.round(wallNotionalUsd),
  };
}

export function totalLiquidityUsd(profile: LiquidityProfile): number {
  return profile.bidDepthUsdBps + profile.askDepthUsdBps;
}
