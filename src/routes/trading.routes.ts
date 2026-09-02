import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { tradeDecisions, decisionTransitions, orders, positions, earlyDetectionTokens } from '../../db/schema.js';
import { SYSTEM_PRINCIPAL_ID, withActorContext } from '../db/actor.js';
import { requireRole } from '../middleware/auth.js';
import { tokenBucket } from '../middleware/ratelimit.js';
import { serializeDecision, serializeOrder, serializePosition, serializeEarlyToken } from '../serializers/serialize.js';
import { fetchAllEarlyCandidates } from '../services/scanner/all-ticker-scanner.js';
import type { EarlyCandidate } from '../services/scanner/all-ticker-scanner.js';
import { timeService } from '../services/ingestion/time-sync.js';
import { getRedis } from '../services/redis.js';

export const readRoutes = new Hono();

readRoutes.get('/tokens/early-feed', requireRole('owner', 'viewer', 'system_agent'), tokenBucket(60, 60), async (c) => {
  const minScore = Number(c.req.query('minCompositeScore') ?? 0);
  const rows = await withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
    tx.select().from(earlyDetectionTokens).orderBy(desc(earlyDetectionTokens.compositeScore)).limit(100),
  );
  const data = rows.map(serializeEarlyToken).filter((t) => t.compositeScore >= minScore);
  // hint sinkron FE: feed utama sekarang adalah /scanner/early-all (Bybit+Gate+Gate-enriched)
  return c.json(data);
});

// Scanner: all tickers CEX MM early — daily/swing, Top 5 compass pin + Top 20 (Bybit ccxt -> Bybit REST -> Gate REST -> CoinGecko)
let scannerCache: {
  at: number;
  data: { generatedAt: string; mode: string; compass: EarlyCandidate[]; top: EarlyCandidate[]; allCount: number; source: string };
} | null = null;
readRoutes.get('/scanner/early-all', requireRole('owner', 'viewer', 'system_agent'), tokenBucket(30, 60), async (c) => {
  const strat = String(c.req.query('strategy') ?? '').toUpperCase() === 'SWING' ? 'SWING' : 'SCALP';
  (globalThis as unknown as { __keelStrategy?: string }).__keelStrategy = strat;
  const now = timeService.now();
  if (scannerCache && now - scannerCache.at < 30_000 && (scannerCache.data as unknown as { strategy?: string }).strategy === strat) {
    return c.json(scannerCache.data);
  }
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);
  const data = await fetchAllEarlyCandidates(limit);
  // source jujur sesuai all-ticker-scanner.ts chain; FE wajib tampilkan ini — jangan hardcode DexScreener jika tak dipanggil
  const payload = {
    generatedAt: new Date(timeService.now()).toISOString(),
    mode: 'PAPER',
    strategy: strat,
    compass: data.compass,
    top: data.top,
    allCount: data.allCount,
    source: (data as { source?: string }).source ?? 'ccxt:bybit -> Bybit REST -> Gate REST -> CoinGecko (Gate orderbook enrich top 10)',
  };
  scannerCache = { at: now, data: payload };
  return c.json(payload);
});

readRoutes.get('/decisions', requireRole('owner', 'viewer', 'system_agent'), async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const rows = await withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
    tx.select().from(tradeDecisions).orderBy(desc(tradeDecisions.createdAt)).limit(limit),
  );
  return c.json(rows.map(serializeDecision));
});

readRoutes.get('/decisions/:decisionId/transitions', requireRole('owner', 'viewer', 'system_agent'), async (c) => {
  const id = c.req.param('decisionId');
  const rows = await withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
    tx.select().from(decisionTransitions).where(eq(decisionTransitions.decisionId, id)),
  );
  return c.json(
    rows.map((r) => ({
      decisionId: r.decisionId,
      fromState: r.fromState,
      toState: r.toState,
      reason: r.reason,
      serverTime: Number(r.serverTime),
    })),
  );
});

readRoutes.get('/positions', requireRole('owner', 'viewer', 'system_agent'), async (c) => {
  const rows = await withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
    tx.select().from(positions).orderBy(desc(positions.updatedAt)).limit(200),
  );
  return c.json(rows.map(serializePosition));
});

readRoutes.get('/analytics/winrate', requireRole('owner', 'viewer', 'system_agent'), async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 1000);
  const sumRolling = Math.min(Number(c.req.query('window') ?? 100), limit);
  try {
    const { getDb } = await import('../db/index.js');
    const { signalOutcomes } = await import('../../db/schema.js');
    const db = getDb();
    const rows = await db.select().from(signalOutcomes).orderBy(desc(signalOutcomes.createdAt)).limit(limit);
    const wins = rows.filter((r) => r.outcome === 'TP').length;
    const losses = rows.filter((r) => r.outcome === 'SL').length;
    const total = wins + losses;
    const winrate = total > 0 ? wins / total : 0;
    const pnl = rows.reduce((s, r) => s + Number(r.pnlPct ?? 0), 0);
    const rSum = rows.reduce((s, r) => s + Number(r.rMultiple ?? 0), 0);
    const expectancy = total > 0 ? rSum / total : 0;
    const grossWin = rows.filter((r) => Number(r.pnlPct ?? 0) > 0).reduce((s, r) => s + Number(r.pnlPct), 0);
    const grossLoss = Math.abs(rows.filter((r) => Number(r.pnlPct ?? 0) < 0).reduce((s, r) => s + Number(r.pnlPct), 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
    const rollingRows = rows.slice(0, sumRolling);
    const rw = rollingRows.filter((r) => r.outcome === 'TP').length;
    const rl = rollingRows.filter((r) => r.outcome === 'SL').length;
    const rTotal = rw + rl;
    return c.json({
      total: rows.length, wins, losses, winrate: Number(winrate.toFixed(4)), window: sumRolling,
      rolling: { n: rollingRows.length, wins: rw, losses: rl, winrate: rTotal > 0 ? Number((rw / rTotal).toFixed(4)) : 0 },
      pnlPctSum: Number(pnl.toFixed(2)), expectancyR: Number(expectancy.toFixed(4)), profitFactor: Number(pf.toFixed(3)),
      recent: rows.slice(0, 20).map((r) => ({
        id: r.id, decisionId: r.decisionId, symbol: r.symbol, side: r.side,
        entryPrice: Number(r.entryPrice ?? 0), exitPrice: r.exitPrice != null ? Number(r.exitPrice) : null,
        pnlPct: r.pnlPct != null ? Number(r.pnlPct) : null, rMultiple: r.rMultiple != null ? Number(r.rMultiple) : null,
        outcome: r.outcome, barsHeld: r.barsHeld ?? null, closedAt: r.closedAt,
      })),
    });
  } catch (e) {
    return c.json({ total: 0, wins: 0, losses: 0, winrate: 0, window: sumRolling, rolling: { n: 0, wins: 0, losses: 0, winrate: 0 }, pnlPctSum: 0, expectancyR: 0, profitFactor: 0, recent: [], _note: e instanceof Error ? e.message : String(e) });
  }
});

// Probability shadow — recent P(win)/EV per evaluated signal (from signal-recorder prob-gate)
readRoutes.get('/analytics/prob-shadow', requireRole('owner', 'viewer', 'system_agent'), async (c) => {
  try {
    const { getDb } = await import('../db/index.js');
    const { signalFeatures } = await import('../../db/schema.js');
    const db = getDb();
    const rows = await db
      .select({ id: signalFeatures.id, symbol: signalFeatures.symbol, ts: signalFeatures.ts, source: signalFeatures.source, planReason: signalFeatures.planReason, raw: signalFeatures.raw })
      .from(signalFeatures)
      .where(eq(signalFeatures.source, 'prob-gate'))
      .orderBy(desc(signalFeatures.ts))
      .limit(24);
    return c.json(rows.map((r) => {
      const raw = (r.raw ?? {}) as { p?: number; ev?: number; prior?: boolean; n?: number; bucket?: string };
      return {
        id: r.id, symbol: r.symbol, ts: Number(r.ts),
        p: typeof raw.p === 'number' ? Number(raw.p.toFixed(3)) : null,
        ev: typeof raw.ev === 'number' ? Number(raw.ev.toFixed(3)) : null,
        prior: !!raw.prior, n: typeof raw.n === 'number' ? raw.n : null, bucket: raw.bucket ?? null,
        reason: r.planReason ?? '',
      };
    }));
  } catch {
    return c.json([]);
  }
});

// Trailing stop activity — recent STOP_TRAILED audit events (owner/agent only: audit_logs RLS)
readRoutes.get('/analytics/trail-events', requireRole('owner', 'system_agent'), async (c) => {
  try {
    const { getDb } = await import('../db/index.js');
    const { auditLogs } = await import('../../db/schema.js');
    const db = getDb();
    const rows = await db
      .select({ id: auditLogs.id, action: auditLogs.action, entityId: auditLogs.entityId, diff: auditLogs.diff, createdAt: auditLogs.createdAt })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'STOP_TRAILED'))
      .orderBy(desc(auditLogs.createdAt))
      .limit(20);
    return c.json(rows.map((r) => {
      const d = (r.diff ?? {}) as { newStopLossPrice?: number; reason?: string };
      return { id: r.id, entityId: r.entityId, newSl: d.newStopLossPrice ?? null, reason: d.reason ?? '', at: r.createdAt };
    }));
  } catch {
    return c.json([]);
  }
});


readRoutes.post('/positions/:positionId/close', requireRole('owner', 'system_agent'), async (c) => {
  const positionId = c.req.param('positionId');
  void (await c.req.json().catch(() => ({} as { reason?: string })) as { reason?: string });
  const { closePosition } = await import('../services/execution/executor.js');
  try {
    const res = await closePosition(positionId, 'MANUAL_CLOSE', 0);
    return c.json({ ok: true, ...res });
  } catch (err) {
    // fallback: if closePosition expects stored entry price, try with symbol lookup
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) return c.json({ error: 'position_not_found', positionId }, 404);
    return c.json({ error: msg, positionId }, 400);
  }
});

readRoutes.post('/positions/:positionId/move-sl-bep', requireRole('owner', 'system_agent'), async (c) => {
  const positionId = c.req.param('positionId');
  const rows = await withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
    tx.select().from(positions).where(eq(positions.id, positionId)).limit(1),
  );
  const pos = rows[0];
  if (!pos) return c.json({ error: 'position_not_found' }, 404);
  if (!pos.isOpen) return c.json({ error: 'position_closed' }, 400);
  const entry = Number(pos.entryPrice);
  const updated = await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    const { timeService: _ts } = await import('../services/ingestion/time-sync.js');
    const [row] = await tx.update(positions).set({ stopLossPrice: String(entry), updatedAt: new Date(_ts.now()) }).where(eq(positions.id, positionId)).returning();
    const { AuditService } = await import('../services/audit/audit-service.js');
    await AuditService.recordInTx(tx, { actorId: SYSTEM_PRINCIPAL_ID, action: 'STOP_MOVED_TO_BEP', entity: 'positions', entityId: positionId, diff: { symbol: pos.symbol, prevStop: Number(pos.stopLossPrice), newStop: entry } });
    return row;
  });
  return c.json({ ok: true, id: positionId, symbol: pos.symbol, entryPrice: entry, stopLossPrice: Number(updated?.stopLossPrice ?? entry) });
});

readRoutes.get('/orders', requireRole('owner', 'viewer', 'system_agent'), async (c) => {
  const rows = await withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
    tx.select().from(orders).orderBy(desc(orders.createdAt)).limit(200),
  );
  return c.json(rows.map(serializeOrder));
});

export const executeRoutes = new Hono();

executeRoutes.post('/decisions/:decisionId/execute', requireRole('owner', 'system_agent'), async (c) => {
  const decisionId = c.req.param('decisionId');
  // S1: single execution plane — the worker is the ONLY executor. Queue via Redis.
  try {
    const redis = getRedis();
    if (!redis) return c.json({ error: 'redis_unavailable', decisionId, status: 'NOT_QUEUED' }, 503);
    await redis.publish('manual:execute', decisionId);
    return c.json({ ok: true, decisionId, status: 'QUEUED' }, 202);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'queue_failed', decisionId }, 500);
  }
});
