import { Hono } from 'hono';
import { z } from 'zod';
import { withActorContext } from '../db/actor.js';
import { requireRole } from '../middleware/auth.js';
import { validateBody, validatedBody } from '../middleware/validation.js';
import { timeService } from '../services/ingestion/time-sync.js';
import { analyzeOrderbook, toGatePair } from '../services/scanner/orderbook-service.js';
import { reserveAndPersistDecision } from '../services/risk/gatekeeper.js';
import { isKillSwitchActiveTx } from '../services/risk/kill-switch.js';
import { SYSTEM_PRINCIPAL_ID } from '../db/actor.js';
import { getRedis } from '../services/redis.js';

const schema = z.object({
  symbol: z.string().min(3).max(20),
  action: z.enum(['BUY','SELL']),
  sizePct: z.number().min(2).max(5).optional().default(3),
  strategy: z.enum(['SCALP','SWING']).optional().default('SCALP'),
});

export const manualRoutes = new Hono();

manualRoutes.post('/orders/manual', requireRole('owner'), validateBody(schema), async (c) => {
  const { symbol: symRaw, action, sizePct, strategy } = validatedBody<{symbol:string;action:'BUY'|'SELL';sizePct:number;strategy:'SCALP'|'SWING'}>(c);
  const symbol = symRaw.toUpperCase().replace('/','');
  const venue = 'BINANCE_SPOT' as const;
  const pair = toGatePair(symbol);
  const ob = await analyzeOrderbook(pair, strategy as never);
  if (!ob) return c.json({ error: 'orderbook_stale', pair, hint: 'Gate orderbook cache 15s stale / laptop sleep — tunggu FE refresh 15s lalu coba lagi' }, 503);
  const entryPrice = ob.mid;
  const stopLossPct = -Math.abs(ob.plan.stopPct);
  const takeProfitPct = Math.abs(ob.plan.tpPct);
  const mmThesis = `MANUAL [${strategy}] paper simulation — ${symbol} ${action} size ${sizePct}% — imbalance ${ob.imbalance.toFixed(2)} • src GATE.IO ${pair} • ${ob.plan.reason}`;
  const signal = {
    symbol,
    venue,
    action,
    mmThesis,
    smartMoneyFlow: 'NEUTRAL' as const,
    mtfBias: { m15: 'NEUTRAL' as const, h1: 'NEUTRAL' as const, h4: 'NEUTRAL' as const, d1: 'NEUTRAL' as const },
    liquidityDepthUsd: ob.bidDepth1pctUsd + ob.askDepth1pctUsd,
    narrativeVelocity: 0,
    entryPrice,
    sizePct,
    stopLossPct,
    takeProfitPct,
    detectedAtServerMs: timeService.now(),
  };
  const ownerId = (c.get('actor') as {id:string} | undefined)?.id ?? SYSTEM_PRINCIPAL_ID;
  const mmThesisOwner = `${mmThesis} • requestedBy ${ownerId}`;
  const signalOwner = { ...signal, mmThesis: mmThesisOwner };
  const reserved = await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    const killActive = await isKillSwitchActiveTx(tx);
    return reserveAndPersistDecision(tx, signalOwner as never, SYSTEM_PRINCIPAL_ID, { dailyDrawdownPct: null, killSwitchActive: killActive });
  });
  if (!reserved.passed) return c.json({ error: 'risk_rejected', reasons: reserved.reasons, decisionId: reserved.decisionId, mmThesis }, 422);
  
  // Queue for worker execution via Redis pub/sub — also attempt direct fallback if Redis not ready
  const redis = getRedis();
  let queued = false;
  if (redis) {
    try {
      const n = await redis.publish('manual:execute', reserved.decisionId);
      queued = n > 0;
    } catch { /* worker fallback will catch it */ }
  }
  // If no subscriber received it (publish returns 0), execute synchronously now
  // — guarantees PAPER sim works even when worker Redis subscription transiently missed
  if (!queued) {
    try {
      const { executeDecision } = await import('../services/execution/executor.js');
      const outcome = await executeDecision(reserved.decisionId);
      return c.json({
        ok: true,
        status: outcome.terminalState,
        decisionId: reserved.decisionId,
        mmThesis: mmThesisOwner,
        reason: ob.plan.reason,
        entryPrice,
        stopLossPct,
        takeProfitPct,
        sizePct,
        clientOrderId: outcome.order?.clientOrderId ?? null,
      }, 201);
    } catch {
      // fallback to queued even if sync execute failed — decision already PENDING
      if (redis) await redis.publish('manual:execute', reserved.decisionId).catch(() => undefined);
    }
  }
  
  return c.json({ 
    ok: true, 
    status: 'QUEUED', 
    decisionId: reserved.decisionId, 
    mmThesis: mmThesisOwner, 
    reason: ob.plan.reason, 
    entryPrice, 
    stopLossPct, 
    takeProfitPct, 
    sizePct 
  }, 202);
});
