import type { auditLogs, earlyDetectionTokens, orders, positions, reconciliationReports, tradeDecisions } from '../../db/schema.js';

type NumericRow = Record<string, unknown>;

function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

export type DecisionApi = ReturnType<typeof serializeDecision>;

export function serializeDecision(row: typeof tradeDecisions.$inferSelect) {
  return {
    id: row.id,
    symbol: row.symbol,
    venue: row.venue,
    action: row.action,
    mmThesis: row.mmThesis,
    smartMoneyFlow: row.smartMoneyFlow,
    mtfBias: row.mtfBias,
    liquidityDepthUsd: num(row.liquidityDepthUsd),
    stopLossPct: num(row.stopLossPct),
    takeProfitPct: num(row.takeProfitPct),
    sizePct: num(row.sizePct),
    riskPassed: row.riskPassed,
    riskReasons: row.riskReasons,
    terminalState: row.terminalState,
    createdAt: iso(row.createdAt),
  };
}

export function serializeOrder(row: typeof orders.$inferSelect) {
  return {
    clientOrderId: row.clientOrderId,
    decisionId: row.decisionId,
    venue: row.venue,
    symbol: row.symbol,
    side: row.side,
    requestedQty: num(row.requestedQty),
    executedQty: num(row.executedQty),
    avgFillPrice: row.avgFillPrice === null ? null : num(row.avgFillPrice),
    externalRef: row.externalRef,
    status: row.status,
    serverTime: Number(row.serverTime),
    createdAt: iso(row.createdAt),
  };
}

export function serializePosition(row: typeof positions.$inferSelect) {
  return {
    id: row.id,
    symbol: row.symbol,
    venue: row.venue,
    decisionId: row.decisionId,
    orderId: row.orderId,
    sizePct: num(row.sizePct),
    entryPrice: num(row.entryPrice),
    stopLossPrice: num(row.stopLossPrice),
    takeProfitPrice: num(row.takeProfitPrice),
    currentPnlPct: num(row.currentPnlPct),
    isOpen: row.isOpen,
    openedAt: iso(row.openedAt),
  };
}

export function serializeReconciliationReport(row: typeof reconciliationReports.$inferSelect) {
  return {
    timestamp: Number(row.timestamp),
    isSynced: row.isSynced,
    localBalanceUsd: num(row.localBalanceUsd),
    exchangeBalanceUsd: num(row.exchangeBalanceUsd),
    discrepancyUsd: num(row.discrepancyUsd),
    breakdown: row.breakdown ?? undefined,
  };
}

export function serializeEarlyToken(row: typeof earlyDetectionTokens.$inferSelect) {
  return {
    symbol: row.symbol,
    venue: row.venue,
    compositeScore: num(row.compositeScore),
    smartMoneyFlow: row.smartMoneyFlow,
    liquidityDepthUsd: num(row.liquidityDepthUsd),
    narrativeVelocity: num(row.narrativeVelocity),
    mtfAlignment: row.mtfAlignment,
    detectedAt: iso(row.detectedAt),
  };
}

export function serializeAuditLog(row: typeof auditLogs.$inferSelect) {
  return {
    id: row.id,
    actorId: row.actorId,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    diff: row.diff,
    hash: row.hash,
    createdAt: iso(row.createdAt),
  };
}

export function numericOf(row: NumericRow, key: string): number {
  return num(row[key]);
}
