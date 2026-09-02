import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { positions } from '../../../db/schema.js';
import { SYSTEM_PRINCIPAL_ID, withActorContext } from '../../db/actor.js';
import { AuditService } from '../audit/audit-service.js';
import { temporalMemory } from '../mm-brain/temporal-memory.js';
import { closePosition } from '../execution/executor.js';
import { timeService } from '../ingestion/time-sync.js';

export interface ExitSignal {
  positionId: string;
  symbol: string;
  reason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP';
  price: number;
  sl: number;
  tp: number;
}

export interface ExitMonitorResult {
  checked: number;
  closed: ExitSignal[];
  trailed: Array<{ symbol: string; oldSl: number; newSl: number }>;
  errors: string[];
}

const peakMidByPos = new Map<string, number>();
const breakevenArmedByPos = new Map<string, boolean>();

function atrFracFromTrades(symbol: string): number | null {
  const trades = temporalMemory.tradeHistory(symbol, 60_000) as Array<{ price: number }>;
  if (trades.length < 5) return null;
  let hi = -Infinity, lo = Infinity;
  for (const t of trades) { if (t.price > hi) hi = t.price; if (t.price < lo) lo = t.price; }
  const mid = (hi + lo) / 2;
  if (!(mid > 0)) return null;
  return (hi - lo) / mid;
}

// Watches open positions against the latest live mid-price (server-time synced).
// - Static SL/TP hit detection (as before).
// - Trailing chandelier: once +1R in favor, arm breakeven; thereafter trail as
//   highestMid − k*ATR (long) / lowestMid + k*ATR (short). DB stopLossPrice is
//   ratchet-only (never against the position) + each bump audited. Trail breaks
//   close via closePosition — no hardcoded 1-3% band.
async function ratchetStop(positionId: string, newSl: number, reason: string): Promise<void> {
  if (!Number.isFinite(newSl) || newSl <= 0) return;
  try {
    await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
      await tx.update(positions).set({ stopLossPrice: String(newSl), updatedAt: new Date(timeService.now()) }).where(eq(positions.id, positionId));
      await AuditService.recordInTx(tx, { actorId: SYSTEM_PRINCIPAL_ID, action: 'STOP_TRAILED', entity: 'positions', entityId: positionId, diff: { newStopLossPrice: newSl, reason } });
    });
  } catch { /* ratchet best-effort */ }
  void getDb; void sql;
}

export async function runExitMonitor(): Promise<ExitMonitorResult> {
  const open = await withActorContext(SYSTEM_PRINCIPAL_ID, (tx) => tx.select().from(positions).where(eq(positions.isOpen, true)));
  const closed: ExitSignal[] = [];
  const trailed: Array<{ symbol: string; oldSl: number; newSl: number }> = [];
  const errors: string[] = [];
  for (const k of [...peakMidByPos.keys()]) if (!open.some((p) => p.id === k)) { peakMidByPos.delete(k); breakevenArmedByPos.delete(k); }

  for (const position of open) {
    try {
      const depth = temporalMemory.recentDepth(position.symbol) as (typeof temporalMemory extends { recentDepth: (s: string) => infer R } ? R & { tsServerMs?: number } : never) | null;
      if (!depth) continue;
      const tsServerMs = (depth as unknown as { tsServerMs?: number }).tsServerMs;
      if (tsServerMs !== undefined && timeService.isStale(tsServerMs)) continue;
      const bid = depth.bids[0]?.price, ask = depth.asks[0]?.price;
      if (bid === undefined || ask === undefined) continue;
      const mid = (bid + ask) / 2;
      const sl = Number(position.stopLossPrice), tp = Number(position.takeProfitPrice);
      const entry = Number(position.entryPrice);
      const isLong = entry > 0 ? sl < entry : true;
      const slDist = Math.abs(entry - sl);
      // trailing chandelier: +1R arms breakeven, then trail peak±k*ATR (ratchet-only)
      if (slDist > 0) {
        const prev = peakMidByPos.get(position.id);
        if (prev === undefined) peakMidByPos.set(position.id, mid);
        else if (isLong ? mid > prev : mid < prev) peakMidByPos.set(position.id, mid);
        const peak = peakMidByPos.get(position.id)!;
        const profitReturn = isLong ? (mid - entry) / entry : (entry - mid) / entry;
        const slReturn = slDist / entry;
        if (!breakevenArmedByPos.get(position.id) && slReturn > 0 && profitReturn >= slReturn) {
          breakevenArmedByPos.set(position.id, true);
          const newSl = isLong ? Math.max(sl, entry * 1.0001) : Math.min(sl, entry * 0.9999);
          if ((isLong && newSl > sl) || (!isLong && newSl < sl)) {
            await ratchetStop(position.id, newSl, 'breakeven@1R');
            (position as unknown as Record<string, unknown>).stopLossPrice = String(newSl);
            trailed.push({ symbol: position.symbol, oldSl: sl, newSl });
          }
        }
        if (breakevenArmedByPos.get(position.id)) {
          const atrFrac = atrFracFromTrades(position.symbol) ?? 0.004;
          const k = 2.0;
          const shift = peak * atrFrac * k;
          const trailingSl = isLong ? peak - shift : peak + shift;
          const curSl = Number((position as unknown as Record<string, unknown>).stopLossPrice ?? sl);
          if (isLong ? trailingSl > curSl : trailingSl < curSl) {
            await ratchetStop(position.id, trailingSl, `chandelier k=${k} ATR ${(atrFrac*100).toFixed(2)}%`);
            (position as unknown as Record<string, unknown>).stopLossPrice = String(trailingSl);
            trailed.push({ symbol: position.symbol, oldSl: curSl, newSl: trailingSl });
          }
        }
      }
      const curSl = Number((position as unknown as Record<string, unknown>).stopLossPrice ?? sl);
      let hit: 'STOP_LOSS' | 'TAKE_PROFIT' | null = null;
      if (isLong) { if (mid <= curSl) hit = 'STOP_LOSS'; else if (mid >= tp) hit = 'TAKE_PROFIT'; }
      else { if (mid >= curSl) hit = 'STOP_LOSS'; else if (mid <= tp) hit = 'TAKE_PROFIT'; }
      if (hit) {
        await closePosition(position.id, hit, mid);
        closed.push({ positionId: position.id, symbol: position.symbol, reason: hit, price: mid, sl: curSl, tp });
        peakMidByPos.delete(position.id); breakevenArmedByPos.delete(position.id);
      }
    } catch (err) { errors.push(`${position.symbol}: ${err instanceof Error ? err.message : err}`); }
  }
  return { checked: open.length, closed, trailed, errors };
}
