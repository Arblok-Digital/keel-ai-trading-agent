import type { NormalizedDepth } from '../../types/exchange.js';

export type WallAction = 'PULLED_SELL_WALL' | 'BID_SUPPORT_UP' | 'WALL_ADDED' | 'NONE';

export interface WallDynamicsInput {
  prev: NormalizedDepth | null;
  current: NormalizedDepth;
}

export interface WallDynamicsVerdict {
  action: WallAction;
  pulledNotionalUsd: number;
  bidSupportShiftBps: number | null;
  detail: string;
}

const WALL_NOTIONAL_THRESHOLD = 50_000;
const PULL_RATIO_THRESHOLD = 0.6;
const BID_SHIFT_THRESHOLD_BPS = 10;

export function analyzeWallDynamics(input: WallDynamicsInput): WallDynamicsVerdict {
  if (!input.prev) {
    return { action: 'NONE', pulledNotionalUsd: 0, bidSupportShiftBps: null, detail: 'no prior snapshot' };
  }

  const prevAskWall = largestLevelUsd(input.prev.asks);
  const currAskWall = largestLevelUsd(input.current.asks);
  const prevBidWall = largestLevelUsd(input.prev.bids);
  const currBidWall = largestLevelUsd(input.current.bids);

  const pulledNotionalUsd = Math.max(0, prevAskWall - currAskWall);
  let action: WallAction = 'NONE';
  let detail = 'no wall movement detected';

  if (pulledNotionalUsd >= WALL_NOTIONAL_THRESHOLD) {
    const prevRatio = prevAskWall > 0 ? currAskWall / prevAskWall : 0;
    if (prevRatio <= PULL_RATIO_THRESHOLD) {
      action = 'PULLED_SELL_WALL';
      detail = `sell wall pulled: ${pulledNotionalUsd.toFixed(0)} USD removed without fills`;
    }
  }

  const bidShiftBps = bidSupportShiftBps(input.prev, input.current);
  if (action === 'NONE' && bidShiftBps !== null && bidShiftBps >= BID_SHIFT_THRESHOLD_BPS) {
    action = 'BID_SUPPORT_UP';
    detail = `bid support moved up by ${bidShiftBps.toFixed(0)} bps`;
  }

  if (action === 'NONE' && currBidWall > prevBidWall) {
    action = 'WALL_ADDED';
    detail = 'added resting liquidity';
  }

  return { action, pulledNotionalUsd, bidSupportShiftBps: bidShiftBps, detail };
}

function largestLevelUsd(levels: Array<{ price: number; qty: number }>): number {
  let max = 0;
  for (const l of levels) {
    const notional = l.price * l.qty;
    if (notional > max) max = notional;
  }
  return max;
}

function midPrice(depth: NormalizedDepth): number {
  const bid = depth.bids[0]?.price;
  const ask = depth.asks[0]?.price;
  return bid !== undefined && ask !== undefined ? (bid + ask) / 2 : NaN;
}

function bidSupportShiftBps(prev: NormalizedDepth, current: NormalizedDepth): number | null {
  const prevMid = midPrice(prev);
  const currMid = midPrice(current);
  const prevBestBid = prev.bids[0]?.price;
  const currBestBid = current.bids[0]?.price;
  if (!prevMid || !currMid || prevBestBid === undefined || currBestBid === undefined) return null;
  const prevBidOffset = ((prevMid - prevBestBid) / prevMid) * 10_000;
  const currBidOffset = ((currMid - currBestBid) / currMid) * 10_000;
  return Math.round(prevBidOffset - currBidOffset);
}
