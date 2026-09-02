import { eq } from 'drizzle-orm';
import { orders, positions, systemMode, tradeDecisions, decisionTransitions } from '../../../db/schema.js';
import { SYSTEM_PRINCIPAL_ID, withActorContext, type ActorTx } from '../../db/actor.js';
import { RISK_CONSTANTS } from '../../config/risk-constants.js';
import type { OrderExecutionReport } from '../../types/exchange.js';
import { AuditService } from '../audit/audit-service.js';
import { timeService } from '../ingestion/time-sync.js';
import { clientOrderIdFor } from './id-generator.js';
import {
  OrderTimeoutError,
  type ExchangeAdapter,
  type ExchangeCredentials,
} from './exchange-adapter.js';
import { paperAdapter, paperFeed } from './paper-adapter.js';
import { binanceSpotAdapter } from './binance-spot.js';
import { uniswapV3Adapter } from './uniswap-v3.js';
import { raydiumAdapter } from './raydium.js';
import { loadExchangeCredentials } from './vault.js';
import { isKillSwitchActiveTx } from '../risk/kill-switch.js';

export class ExecutionError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ExecutionError';
  }
}

export async function getTradingMode(): Promise<'PAPER' | 'LIVE'> {
  return withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    const [row] = await tx.select().from(systemMode).limit(1);
    return row?.mode ?? 'PAPER';
  });
}

function resolveAdapter(venue: string, mode: 'PAPER' | 'LIVE'): ExchangeAdapter {
  if (mode === 'PAPER') return paperAdapter;
  switch (venue) {
    case 'BINANCE_SPOT':
      return binanceSpotAdapter;
    case 'UNISWAP_V3':
      return uniswapV3Adapter;
    case 'RAYDIUM':
      return raydiumAdapter;
    default:
      throw new ExecutionError(500, `unknown venue ${venue}`);
  }
}

async function loadCredentialsForLive(venue: string): Promise<ExchangeCredentials> {
  return loadExchangeCredentials(venue);
}

async function loadDecisionState(tx: ActorTx, decisionId: string) {
  const [decision] = await tx.select().from(tradeDecisions).where(eq(tradeDecisions.id, decisionId));
  const [order] = await tx.select().from(orders).where(eq(orders.decisionId, decisionId));
  const killSwitchActive = await isKillSwitchActiveTx(tx);
  const [mode] = await tx.select().from(systemMode).limit(1);
  return { decision, order, killSwitchActive, mode: mode?.mode ?? ('PAPER' as const) };
}

const STABLE_CASH_ASSETS = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD']);
async function quoteQtyFor(decision: typeof tradeDecisions.$inferSelect): Promise<number> {
  const mode = await getTradingMode();
  if (mode === 'LIVE') {
    let equityUsd = 10_000;
    try {
      const creds = await loadExchangeCredentials(decision.venue);
      const balances = await binanceSpotAdapter.balances(creds);
      const stableUsd = balances.filter((b) => STABLE_CASH_ASSETS.has(b.asset.toUpperCase())).reduce((sum, b) => sum + b.usdValue, 0);
      equityUsd = stableUsd > 0 ? stableUsd : (balances.reduce((sum, b) => sum + b.usdValue, 0) || 10_000);
    } catch {
      equityUsd = paperAdapter.cash() > 0 ? paperAdapter.cash() : 10_000;
    }
    let liveMid: number | null = null;
    try {
      const { analyzeOrderbook, toGatePair } = await import('../scanner/orderbook-service.js');
      const ob = await analyzeOrderbook(toGatePair(decision.symbol)).catch(() => null);
      liveMid = ob?.mid ?? null;
    } catch { liveMid = null; }
    const price = paperFeed.priceUsd(decision.symbol) ?? liveMid;
    if (price === null || price === undefined || price <= 0) {
      throw new ExecutionError(503, `no live mid for ${decision.symbol} — orderbook unavailable, LIVE fill refused (feed mati)`);
    }
    const quoteUsd = (equityUsd * Number(decision.sizePct)) / 100;
    return Math.max(quoteUsd / price, 1e-8);
  }
  const equityUsd = paperAdapter.cash() > 0 ? paperAdapter.cash() : 10_000;
  const quoteUsd = (equityUsd * Number(decision.sizePct)) / 100;
  let price = paperFeed.priceUsd(decision.symbol);
  let obForGuard: import('../scanner/orderbook-service.js').OrderbookAnalysis | null = null;
  if (price === null || price <= 0) {
    try {
      const { analyzeOrderbook, toGatePair } = await import('../scanner/orderbook-service.js');
      obForGuard = await analyzeOrderbook(toGatePair(decision.symbol)).catch(() => null);
      price = obForGuard?.mid ?? null;
      // STALENESS HALT: if orderbook fetch failed (stale/mati) while laptop sleeping, reject PAPER fill
      if (price === null) throw new ExecutionError(503, `orderbook stale for ${decision.symbol} — no live mid, PAPER fill refused (feed mati)`);
    } catch (e) {
      if (e instanceof ExecutionError) throw e;
      throw new ExecutionError(503, `orderbook stale for ${decision.symbol} — feed mati, PAPER fill refused`);
    }
  }
  return Math.max(quoteUsd / price, 1e-8);
}

async function transitionDecision(
  tx: ActorTx,
  decisionId: string,
  toState: 'EXECUTED' | 'REJECTED' | 'FAILED',
  reason: string,
  actorId: string,
): Promise<void> {
  await tx.insert(decisionTransitions).values({
    decisionId,
    fromState: 'PENDING',
    toState,
    reason,
    actorId,
    serverTime: Math.trunc(timeService.now()),
  });
  await tx
    .update(tradeDecisions)
    .set({ terminalState: toState })
    .where(eq(tradeDecisions.id, decisionId));
}

export interface ExecuteOutcome {
  decisionId: string;
  order: typeof orders.$inferSelect | null;
  reconciled: boolean;
  terminalState: 'PENDING' | 'EXECUTED' | 'REJECTED' | 'FAILED';
}

export async function executeDecision(decisionId: string): Promise<ExecuteOutcome> {
  const initial = await withActorContext(SYSTEM_PRINCIPAL_ID, (tx) => loadDecisionState(tx, decisionId));

  if (!initial.decision) throw new ExecutionError(404, `decision ${decisionId} not found`);
  const decision = initial.decision;
  if (initial.order) {
    return { decisionId, order: initial.order, reconciled: true, terminalState: decision.terminalState };
  }
  if (decision.action === 'HOLD') throw new ExecutionError(409, 'HOLD decisions dispatch nothing');
  if (!decision.riskPassed) throw new ExecutionError(409, `decision rejected by risk gates: ${decision.riskReasons.join(';')}`);
  if (initial.killSwitchActive) throw new ExecutionError(409, 'kill switch engaged; dispatch halted');

  const adapter = resolveAdapter(decision.venue, initial.mode);
  const clientOrderId = clientOrderIdFor(decisionId);

  let creds: ExchangeCredentials | undefined;
  if (initial.mode === 'LIVE') {
    creds = await loadCredentialsForLive(decision.venue);
  }

  const requestedQty = String(await quoteQtyFor(decision));
  const dispatched = await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({
        clientOrderId,
        decisionId,
        venue: decision.venue,
        symbol: decision.symbol,
        side: decision.action === 'BUY' ? 'BUY' : 'SELL',
        requestedQty,
        status: 'PENDING',
        serverTime: Math.trunc(timeService.now()),
      })
      .returning();
    if (!order) throw new ExecutionError(500, 'order insert failed');
    await AuditService.recordInTx(tx, {
      actorId: SYSTEM_PRINCIPAL_ID,
      action: 'ORDER_DISPATCHED',
      entity: 'orders',
      entityId: order.id,
      diff: {
        clientOrderId,
        decisionId,
        symbol: order.symbol,
        requestedQty: order.requestedQty,
        serverTime: order.serverTime,
      },
    });
    return order;
  });

  let report: OrderExecutionReport | null = null;
  try {
    report = await adapter.placeOrder(
      {
        decisionId,
        clientOrderId,
        venue: initial.decision.venue,
        symbol: initial.decision.symbol,
        side: initial.decision.action === 'BUY' ? 'BUY' : 'SELL',
        qty: Number(dispatched.requestedQty),
        quoteUsdEstimate: Number(dispatched.requestedQty),
        slippageBps: 50,
      },
      creds,
    );
  } catch (err) {
    if (err instanceof OrderTimeoutError) {
      report = await adapter.queryByClientOrderId(clientOrderId, creds).catch(() => null);
      if (!report) {
        const failed = await finalizeFailure(decisionId, dispatched.id, 'placement timeout and no exchange record');
        return failed;
      }
    } else {
      const failed = await finalizeFailure(
        decisionId,
        dispatched.id,
        err instanceof Error ? err.message : 'unknown dispatch error',
      );
      return failed;
    }
  }

  return finalizeReport(decisionId, dispatched.id, report);
}

async function finalizeFailure(
  decisionId: string,
  orderId: string,
  reason: string,
): Promise<ExecuteOutcome> {
  return withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    await tx.update(orders).set({ status: 'CANCELLED', updatedAt: new Date(timeService.now()) }).where(eq(orders.id, orderId));
    await transitionDecision(tx, decisionId, 'FAILED', reason, SYSTEM_PRINCIPAL_ID);
    await AuditService.recordInTx(tx, {
      actorId: SYSTEM_PRINCIPAL_ID,
      action: 'ORDER_RECONCILED',
      entity: 'orders',
      entityId: orderId,
      diff: { previousStatus: 'PENDING', terminalStatus: 'FAILED', reason },
    });
    return { decisionId, order: null, reconciled: false, terminalState: 'FAILED' as const };
  });
}

async function finalizeReport(
  decisionId: string,
  orderId: string,
  report: OrderExecutionReport,
): Promise<ExecuteOutcome> {
  return withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    await tx
      .update(orders)
      .set({
        status: report.status === 'FILLED' || report.status === 'PARTIALLY_FILLED' ? report.status : report.status,
        executedQty: String(report.executedQty),
        avgFillPrice: report.avgFillPrice === null ? null : String(report.avgFillPrice),
        externalRef: report.externalRef,
        updatedAt: new Date(timeService.now()),
      })
      .where(eq(orders.id, orderId));

    const terminal =
      report.status === 'FILLED'
        ? ('EXECUTED' as const)
        : report.status === 'PARTIALLY_FILLED'
          ? ('REJECTED' as const)
          : report.status === 'REJECTED'
            ? ('REJECTED' as const)
            : ('FAILED' as const);

    await transitionDecision(tx, decisionId, terminal, `adapter reported ${report.status}`, SYSTEM_PRINCIPAL_ID);

    await AuditService.recordInTx(tx, {
      actorId: SYSTEM_PRINCIPAL_ID,
      action: 'ORDER_RECONCILED',
      entity: 'orders',
      entityId: orderId,
      diff: {
        previousStatus: 'PENDING',
        terminalStatus: report.status,
        executedQty: report.executedQty,
      },
    });

    if (report.status === 'FILLED' && report.avgFillPrice !== null) {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
      const [decision] = await tx.select().from(tradeDecisions).where(eq(tradeDecisions.id, decisionId));
      if (order && decision) {
        const entryPrice = report.avgFillPrice;
        const direction = order.side === 'BUY' ? 1 : -1;
        await tx.insert(positions).values({
          symbol: order.symbol,
          venue: order.venue,
          decisionId,
          orderId: order.id,
          sizePct: decision.sizePct,
          entryPrice: String(entryPrice),
          stopLossPrice: String(entryPrice * (1 + (direction * Number(decision.stopLossPct)) / 100)),
          takeProfitPrice: String(entryPrice * (1 + (direction * Number(decision.takeProfitPct)) / 100)),
          isOpen: true,
        });
      }
    }

    const [finalOrder] = await tx.select().from(orders).where(eq(orders.id, orderId));
    return { decisionId, order: finalOrder ?? null, reconciled: false, terminalState: terminal };
  });
}

export interface CloseOutcome {
  positionId: string;
  symbol: string;
  exitSide: 'BUY' | 'SELL';
  exitPrice: number | null;
  pnlPct: number;
  reason: string;
}

export async function closePosition(
  positionId: string,
  reason: string,
  priceAtSignal: number,
): Promise<CloseOutcome> {
  const opened = await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    const [position] = await tx.select().from(positions).where(eq(positions.id, positionId));
    if (!position) throw new ExecutionError(404, `position ${positionId} not found`);
    if (!position.isOpen) throw new ExecutionError(409, `position already closed`);
    const [order] = await tx.select().from(orders).where(eq(orders.id, position.orderId));
    const [mode] = await tx.select().from(systemMode).limit(1);
    return { position, order, mode: mode?.mode ?? ('PAPER' as const) };
  });

  const position = opened.position;
  const order = opened.order;
  if (!order) throw new ExecutionError(500, 'position entry order missing');

  const exitSide: 'BUY' | 'SELL' = order.side === 'BUY' ? 'SELL' : 'BUY';
  const adapter = resolveAdapter(position.venue, opened.mode);
  const closingOrderId = `close-${position.decisionId.slice(0, 8)}-${position.id.slice(0, 4)}-${timeService.now().toString(36).slice(-6)}`;

  let creds: ExchangeCredentials | undefined;
  if (opened.mode === 'LIVE') {
    creds = await loadCredentialsForLive(position.venue);
  }

  const closingQty = Number(order.executedQty ?? order.requestedQty);
  const closingOrder = await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    const [o] = await tx
      .insert(orders)
      .values({
        clientOrderId: closingOrderId,
        decisionId: position.decisionId,
        venue: position.venue,
        symbol: position.symbol,
        side: exitSide,
        requestedQty: String(closingQty),
        status: 'PENDING',
        serverTime: Math.trunc(timeService.now()),
      })
      .returning();
    if (!o) throw new ExecutionError(500, 'closing order insert failed');
    await AuditService.recordInTx(tx, {
      actorId: SYSTEM_PRINCIPAL_ID,
      action: 'ORDER_DISPATCHED',
      entity: 'orders',
      entityId: o.id,
      diff: { clientOrderId: closingOrderId, decisionId: position.decisionId, symbol: position.symbol, requestedQty: o.requestedQty, serverTime: o.serverTime, reason },
    });
    return o;
  });

  let report: OrderExecutionReport | null = null;
  let closingError: string | null = null;
  try {
    report = await adapter.placeOrder(
      {
        decisionId: position.decisionId,
        clientOrderId: closingOrderId,
        venue: position.venue,
        symbol: position.symbol,
        side: exitSide,
        qty: closingQty,
        quoteUsdEstimate: Number(position.entryPrice) * closingQty,
        slippageBps: 50,
      },
      creds,
    );
  } catch (err) {
    if (err instanceof OrderTimeoutError) {
      report = await adapter.queryByClientOrderId(closingOrderId, creds).catch(() => null);
      if (!report) closingError = `closing timeout and no exchange record: ${closingOrderId}`;
    } else {
      closingError = err instanceof Error ? err.message : 'closing dispatch failed';
    }
  }

  if (!report || (report.status !== 'FILLED' && report.status !== 'PARTIALLY_FILLED')) {
    await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
      await tx.update(orders).set({ status: report ? report.status : 'CANCELLED', executedQty: String(report?.executedQty ?? 0), avgFillPrice: report?.avgFillPrice != null ? String(report.avgFillPrice) : null, externalRef: report?.externalRef ?? null, updatedAt: new Date(timeService.now()) }).where(eq(orders.id, closingOrder.id));
      await AuditService.recordInTx(tx, { actorId: SYSTEM_PRINCIPAL_ID, action: 'ORDER_RECONCILED', entity: 'orders', entityId: closingOrder.id, diff: { previousStatus: 'PENDING', terminalStatus: report?.status ?? 'FAILED', reason: closingError ?? 'closing not filled' } });
    });
    throw new ExecutionError(502, closingError ?? `closing order not filled: ${report?.status ?? 'no report'}`);
  }

  await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    await tx.update(orders).set({ status: report!.status, executedQty: String(report!.executedQty), avgFillPrice: report!.avgFillPrice != null ? String(report!.avgFillPrice) : null, externalRef: report!.externalRef, updatedAt: new Date(timeService.now()) }).where(eq(orders.id, closingOrder.id));
    await AuditService.recordInTx(tx, { actorId: SYSTEM_PRINCIPAL_ID, action: 'ORDER_RECONCILED', entity: 'orders', entityId: closingOrder.id, diff: { previousStatus: 'PENDING', terminalStatus: report!.status, executedQty: report!.executedQty } });
  });

  const exitPrice = report.avgFillPrice ?? priceAtSignal;
  const entryPrice = Number(position.entryPrice);
  const pnlPct =
    entryPrice > 0
      ? ((exitPrice - entryPrice) / entryPrice) * 100 * (order.side === 'BUY' ? 1 : -1)
      : 0;
  const slAbs = Math.abs(Number(position.stopLossPrice) - entryPrice);
  const tpAbs = Math.abs(Number(position.takeProfitPrice) - entryPrice);
  const rMultiple = slAbs > 0 ? ((exitPrice - entryPrice) * (order.side === 'BUY' ? 1 : -1)) / slAbs : 0;
  const outcomeKind: 'TP' | 'SL' | 'TIMEOUT' | 'KILL' =
    reason.includes('TAKE_PROFIT') ? 'TP'
    : reason.includes('STOP_LOSS') ? 'SL'
    : reason.includes('TIMEOUT') ? 'TIMEOUT'
    : reason.includes('KILL') ? 'KILL'
    : reason.includes('EXIT') ? 'TP'
    : 'SL';

  await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    await tx
      .update(positions)
      .set({
        isOpen: false,
        currentPnlPct: String(Number(pnlPct.toFixed(2))),
        updatedAt: new Date(timeService.now()),
      })
      .where(eq(positions.id, positionId));

    await AuditService.recordInTx(tx, {
      actorId: SYSTEM_PRINCIPAL_ID,
      action: 'POSITION_CLOSED',
      entity: 'positions',
      entityId: position.id,
      diff: {
        symbol: position.symbol,
        exitSide,
        exitPrice,
        entryPrice,
        pnlPct: Number(pnlPct.toFixed(2)),
        reason,
      },
    });
  });

  // outcomes ledger (winrate + PnL attribution — best-effort, never blocks close)
  try {
    const { recordOutcome } = await import('../recorder/signal-recorder.js');
    const db = (await import('../../db/index.js')).getDb();
    const [dec] = await db.select({ id: tradeDecisions.id, sid: tradeDecisions.id }).from(tradeDecisions).where(eq(tradeDecisions.id, position.decisionId)).limit(1);
    void dec;
    const openedAtMs = new Date((position as unknown as { openedAt: string }).openedAt ?? Date.now()).getTime();
    const barsHeld = Math.max(0, Math.floor((Date.now() - openedAtMs) / 60_000));
    await recordOutcome({
      decisionId: position.decisionId,
      symbol: position.symbol,
      entryPrice: String(entryPrice),
      exitPrice: exitPrice != null ? String(exitPrice) : null,
      side: order.side as 'BUY' | 'SELL',
      pnlPct: String(Number(pnlPct.toFixed(2))),
      rMultiple: String(Number(rMultiple.toFixed(3))),
      outcome: outcomeKind,
      barsHeld,
      closedAt: new Date(timeService.now()),
    });
    // alias for legacy table name if present (signal_outcomes vs signalOutcomes)
    void tpAbs;
  } catch { /* outcomes ledger optional */ }

  return { positionId, symbol: position.symbol, exitSide, exitPrice, pnlPct: Number(pnlPct.toFixed(2)), reason };
}

export function executionTimeoutMs(): number {
  return RISK_CONSTANTS.ORDER_TIMEOUT_MS;
}
