import type { NormalizedTrade } from '../../types/exchange.js';

export interface FlowWindowConfig {
  largeTradeUsdThreshold: number;
  dominanceThreshold: number;
}

export const DEFAULT_FLOW_CONFIG: FlowWindowConfig = {
  largeTradeUsdThreshold: 25_000,
  dominanceThreshold: 0.62,
};

export interface FlowVerdict {
  flow: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL';
  buyNotionalUsd: number;
  sellNotionalUsd: number;
  largeTradeShare: number;
  tradeCount: number;
}

export function classifyFlow(trades: NormalizedTrade[], config = DEFAULT_FLOW_CONFIG): FlowVerdict {
  if (trades.length === 0) {
    return { flow: 'NEUTRAL', buyNotionalUsd: 0, sellNotionalUsd: 0, largeTradeShare: 0, tradeCount: 0 };
  }
  let buy = 0;
  let sell = 0;
  let largeNotional = 0;
  let totalNotional = 0;
  for (const t of trades) {
    totalNotional += t.notionalUsd;
    if (t.isBuyerMaker) sell += t.notionalUsd;
    else buy += t.notionalUsd;
    if (t.notionalUsd >= config.largeTradeUsdThreshold) largeNotional += t.notionalUsd;
  }
  const dominance = buy / (buy + sell || 1);
  const largeTradeShare = largeNotional / (totalNotional || 1);
  let flow: FlowVerdict['flow'] = 'NEUTRAL';
  if (dominance >= config.dominanceThreshold && largeTradeShare >= 0.3) flow = 'ACCUMULATION';
  else if (dominance <= 1 - config.dominanceThreshold && largeTradeShare >= 0.3) flow = 'DISTRIBUTION';
  return { flow, buyNotionalUsd: buy, sellNotionalUsd: sell, largeTradeShare, tradeCount: trades.length };
}
