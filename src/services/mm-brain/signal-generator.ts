import { z } from 'zod';
import { computeCompositeScore, mmSignalSchema, type MMValidatedSignal } from '../../types/signals.js';
import { evaluateConfluence, directionalAction } from './confluence-matrix.js';
import { classifyFlow, DEFAULT_FLOW_CONFIG, type FlowWindowConfig } from './smart-money-tracker.js';
import { mapLiquidity, totalLiquidityUsd } from './liquidity-mapper.js';
import { analyzeWallDynamics, type WallDynamicsVerdict } from './wall-dynamics.js';
import { classifyAbsorption, type AbsorptionVerdict } from './absorption-engine.js';
import { temporalMemory, type MicroDelta } from './temporal-memory.js';
import { deriveEntryStopTarget, type DerivedLevels } from './entry-risk-engine.js';
import type { NormalizedDepth, NormalizedTrade } from '../../types/exchange.js';

export interface SignalBuildInput {
  symbol: string;
  venue: MMValidatedSignal['venue'];
  depth: NormalizedDepth | null;
  recentTrades: NormalizedTrade[];
  mtfBias: MMValidatedSignal['mtfBias'];
  narrativeVelocity: number;
  entryPrice: number;
  detectedAtServerMs: number;
  averageDailyVolumeUsd?: number;
}

export interface SignalGenerationResult {
  signal: MMValidatedSignal | null;
  discardedReason: string | null;
  compositeScore: number;
  smartMoneyFlow: MMValidatedSignal['smartMoneyFlow'];
  liquidityDepthUsd: number;
  absorption: AbsorptionVerdict | null;
  wall: WallDynamicsVerdict | null;
  confluence: { score: number; aligned: boolean; pullbackEntry: boolean; direction: string };
  levels: DerivedLevels | null;
}

const BASE_LARGE_TRADE_USD = 25_000;

export function dynamicLargeTradeThreshold(advUsd: number | undefined): number {
  if (!advUsd || advUsd <= 0) return BASE_LARGE_TRADE_USD;
  return Math.max(1_000, Math.min(BASE_LARGE_TRADE_USD, advUsd * 0.0005));
}

function buildFlowConfig(advUsd?: number): FlowWindowConfig {
  return { ...DEFAULT_FLOW_CONFIG, largeTradeUsdThreshold: dynamicLargeTradeThreshold(advUsd) };
}

export function generateSignal(input: SignalBuildInput): SignalGenerationResult {
  const flowConfig = buildFlowConfig(input.averageDailyVolumeUsd);
  const flowVerdict = classifyFlow(input.recentTrades, flowConfig);
  const profile = input.depth ? mapLiquidity(input.depth) : null;
  const liquidityDepthUsd = profile ? totalLiquidityUsd(profile) : 0;
  const compositeScore = computeCompositeScore({
    smartMoneyFlow: flowVerdict.flow,
    liquidityDepthUsd,
    narrativeVelocity: input.narrativeVelocity,
  });

  if (!input.depth || !profile) {
    return {
      signal: null,
      discardedReason: 'no normalized depth snapshot',
      compositeScore,
      smartMoneyFlow: flowVerdict.flow,
      liquidityDepthUsd,
      absorption: null,
      wall: null,
      confluence: { score: 0, aligned: false, pullbackEntry: false, direction: 'NEUTRAL' },
      levels: null,
    };
  }

  const prevDepth = temporalMemory.recentDepth(input.symbol);
  temporalMemory.recordDepth(input.depth);
  if (input.recentTrades.length > 0) temporalMemory.recordTrades(input.symbol, input.recentTrades);

  const microDelta: MicroDelta = temporalMemory.getDelta(input.symbol, 10_000);
  const absorption = classifyAbsorption({
    priceChangePct: microDelta.priceChangePct,
    netTakerBuyUsd: microDelta.netTakerBuyUsd,
    buyNotionalUsd: microDelta.buyNotionalUsd,
    sellNotionalUsd: microDelta.sellNotionalUsd,
    tradeCount: microDelta.tradeCount,
  });
  const wall = analyzeWallDynamics({ prev: prevDepth, current: input.depth });
  const confluence = evaluateConfluence(input.mtfBias);

  if (liquidityDepthUsd <= 0) {
    return {
      signal: null,
      discardedReason: 'no measurable resting liquidity',
      compositeScore,
      smartMoneyFlow: flowVerdict.flow,
      liquidityDepthUsd,
      absorption,
      wall,
      confluence,
      levels: null,
    };
  }
  if (flowVerdict.flow === 'NEUTRAL') {
    const hasEarlyTell = absorption.isPreBreakoutAccumulation || wall.action === 'PULLED_SELL_WALL';
    if (!hasEarlyTell) {
      return {
        signal: null,
        discardedReason: 'smart-money flow neutral — no institutional participation or early tell',
        compositeScore,
        smartMoneyFlow: flowVerdict.flow,
        liquidityDepthUsd,
        absorption,
        wall,
        confluence,
        levels: null,
      };
    }
  }

  const action = directionalAction(confluence.direction);
  if (action === 'HOLD' && !absorption.isPreBreakoutAccumulation) {
    return {
      signal: null,
      discardedReason: 'MTF direction neutral and no accumulation tell',
      compositeScore,
      smartMoneyFlow: flowVerdict.flow,
      liquidityDepthUsd,
      absorption,
      wall,
      confluence,
      levels: null,
    };
  }

  // derive entry / stop / target / size from realtime market data (not hardcoded)
  const levels = deriveEntryStopTarget(
    { depth: input.depth, trades: input.recentTrades },
    { action },
  );

  const candidate = {
    symbol: input.symbol,
    venue: input.venue,
    action,
    mmThesis:
      `MTF ${confluence.direction.toLowerCase()} weighted ${(confluence.score * 100).toFixed(0)}% ` +
      `(D1 penalty ${(confluence.weightBreakdown?.d1 ?? 0) * 100}%); ` +
      `absorption ${absorption.score}/100 ${absorption.classification} ` +
      `(ΔP ${microDelta.priceChangePct.toFixed(2)}%, netBuy $${microDelta.netTakerBuyUsd.toFixed(0)}); ` +
      `wall action ${wall.action} (${wall.detail}); ` +
      `${flowVerdict.flow} large-share ${(flowVerdict.largeTradeShare * 100).toFixed(1)}% ` +
      `(buy=${flowVerdict.buyNotionalUsd.toFixed(0)}, sell=${flowVerdict.sellNotionalUsd.toFixed(0)}); ` +
      `resting liquidity ${liquidityDepthUsd.toFixed(0)} USD; ` +
      `entry $${levels.entryPrice} SL $${levels.stopAbs} TP $${levels.targetAbs} (${levels.reason}); ` +
      `large-trade threshold $${dynamicLargeTradeThreshold(input.averageDailyVolumeUsd).toFixed(0)}.`,
    smartMoneyFlow: flowVerdict.flow,
    liquidityDepthUsd,
    narrativeVelocity: input.narrativeVelocity,
    mtfBias: input.mtfBias,
    entryPrice: levels.entryPrice,
    sizePct: levels.sizePct,
    stopLossPct: levels.stopLossPct,
    takeProfitPct: levels.takeProfitPct,
    detectedAtServerMs: input.detectedAtServerMs,
  };

  const parsed = mmSignalSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? 'schema rejection';
    return {
      signal: null,
      discardedReason: issue,
      compositeScore,
      smartMoneyFlow: flowVerdict.flow,
      liquidityDepthUsd,
      absorption,
      wall,
      confluence,
      levels,
    };
  }

  return {
    signal: parsed.data,
    discardedReason: null,
    compositeScore,
    smartMoneyFlow: flowVerdict.flow,
    liquidityDepthUsd,
    absorption,
    wall,
    confluence,
    levels,
  };
}

export function parseOrDiscard(raw: unknown): { ok: true; signal: MMValidatedSignal } | { ok: false; reason: string } {
  const parsed = mmSignalSchema.safeParse(raw);
  if (parsed.success) return { ok: true, signal: parsed.data };
  return { ok: false, reason: parsed.error.issues[0]?.message ?? z.ZodIssueCode.custom };
}
