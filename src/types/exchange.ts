import type { OrderStatus, Venue } from '../../db/schema.js';

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface NormalizedDepth {
  symbol: string;
  venue: Venue;
  bids: DepthLevel[];
  asks: DepthLevel[];
  tsServerMs: number;
}

export interface NormalizedTrade {
  symbol: string;
  venue: Venue;
  price: number;
  qty: number;
  notionalUsd: number;
  isBuyerMaker: boolean;
  tsServerMs: number;
}

export interface DEXPoolUpdate {
  poolAddress: string;
  venue: Venue;
  symbol: string;
  baseLiquidityUsd: number;
  quoteLiquidityUsd: number;
  swapVolumeUsdWindow: number;
  tsServerMs: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
  usdValue: number;
}

export interface PlaceOrderRequest {
  decisionId: string;
  clientOrderId: string;
  venue: Venue;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  quoteUsdEstimate: number;
  slippageBps: number;
}

export interface OrderExecutionReport {
  clientOrderId: string;
  externalRef: string | null;
  status: OrderStatus;
  executedQty: number;
  avgFillPrice: number | null;
  serverTimeMs: number;
}

export interface PermissionProbe {
  valid: boolean;
  violations: string[];
  effectiveScopes: string[];
}
