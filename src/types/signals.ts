import { z } from 'zod';
import { SMART_MONEY_FLOWS, MTF_BIASES, VENUES } from '../../db/schema.js';
import { evaluateConfluence, MTF_CONFLUENCE_THRESHOLD } from '../services/mm-brain/confluence-matrix.js';

export const mtfBiasSchema = z.object({
  m15: z.enum(MTF_BIASES),
  h1: z.enum(MTF_BIASES),
  h4: z.enum(MTF_BIASES),
  d1: z.enum(MTF_BIASES),
});

export type MtfVector = z.infer<typeof mtfBiasSchema>;

export const mmSignalSchema = z
  .object({
    symbol: z.string().min(1),
    venue: z.enum(VENUES),
    action: z.enum(['BUY', 'SELL', 'HOLD']),
    mmThesis: z.string().min(20),
    smartMoneyFlow: z.enum(SMART_MONEY_FLOWS),
    liquidityDepthUsd: z.number().positive(),
    narrativeVelocity: z.number(),
    mtfBias: mtfBiasSchema,
    entryPrice: z.number().positive(),
    sizePct: z.number(),
    stopLossPct: z.number(),
    takeProfitPct: z.number(),
    detectedAtServerMs: z.number().int().nonnegative(),
  })
  .superRefine((signal, ctx) => {
    const confluence = evaluateConfluence(signal.mtfBias);
    if (!confluence.aligned && !confluence.pullbackEntry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `MTF confluence violated: weighted score ${(confluence.score * 100).toFixed(0)}% below ${(MTF_CONFLUENCE_THRESHOLD * 100).toFixed(0)}% (naked-indicator rejection)`,
        path: ['mtfBias'],
      });
    }
    if (signal.smartMoneyFlow === 'NEUTRAL' && signal.action !== 'HOLD') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'smart-money flow NEUTRAL cannot justify directional action',
        path: ['smartMoneyFlow'],
      });
    }
    if ((signal.smartMoneyFlow === 'ACCUMULATION' && signal.action === 'SELL') ||
        (signal.smartMoneyFlow === 'DISTRIBUTION' && signal.action === 'BUY')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'action contradicts institutional flow direction',
        path: ['action'],
      });
    }
    if (signal.stopLossPct > 0 || signal.stopLossPct < -15) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `data-driven stop loss out of sanity band (-15%, 0): received ${signal.stopLossPct}%`,
        path: ['stopLossPct'],
      });
    }
    if (signal.takeProfitPct <= 0 || signal.takeProfitPct > 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `data-driven take profit out of sanity band (0, 30%): received ${signal.takeProfitPct}%`,
        path: ['takeProfitPct'],
      });
    }
  });

export type MMValidatedSignal = z.infer<typeof mmSignalSchema>;

export function isNakedIndicator(candidate: {
  mmThesis?: unknown;
  smartMoneyFlow?: unknown;
  liquidityDepthUsd?: unknown;
  mtfBias?: unknown;
}): boolean {
  return (
    typeof candidate.mmThesis !== 'string' ||
    candidate.mmThesis.length < 20 ||
    typeof candidate.smartMoneyFlow !== 'string' ||
    !SMART_MONEY_FLOWS.includes(candidate.smartMoneyFlow as never) ||
    typeof candidate.liquidityDepthUsd !== 'number' ||
    candidate.liquidityDepthUsd <= 0 ||
    typeof candidate.mtfBias !== 'object' ||
    candidate.mtfBias === null
  );
}

export type CompositeScoreInput = {
  smartMoneyFlow: (typeof SMART_MONEY_FLOWS)[number];
  liquidityDepthUsd: number;
  narrativeVelocity: number;
};

export function computeCompositeScore(input: CompositeScoreInput): number {
  const flowScore = input.smartMoneyFlow === 'ACCUMULATION' ? 40 : input.smartMoneyFlow === 'DISTRIBUTION' ? 10 : 0;
  const liquidityScore = Math.min(30, input.liquidityDepthUsd / 50_000);
  const velocityScore = Math.min(30, Math.max(0, input.narrativeVelocity));
  return Math.round((flowScore + liquidityScore + velocityScore) * 100) / 100;
}
