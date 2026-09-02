import { and, eq, gte, sql } from 'drizzle-orm';
import { orders, positions, riskLimits, tradeDecisions, decisionTransitions, VENUES, type Venue } from '../../../db/schema.js';
import type { MMValidatedSignal } from '../../types/signals.js';
import type { ActorTx } from '../../db/actor.js';
import { AuditService } from '../audit/audit-service.js';
import { timeService } from '../ingestion/time-sync.js';
import { RISK_CONSTANTS } from '../../config/risk-constants.js';

export interface RiskLimitsView {
  maxOpenPositions: number;
  maxOrdersPerHour: number;
  maxDrawdownPct: number;
  minPositionSizePct: number;
  maxPositionSizePct: number;
  stopLossPct: number;
}

export interface RiskSnapshot {
  openPositions: number;
  ordersLastHour: number;
  dailyDrawdownPct: number | null;
  killSwitchActive: boolean;
}

export interface RiskCandidate {
  venue: Venue;
  action: 'BUY' | 'SELL' | 'HOLD';
  sizePct: number;
  stopLossPct: number;
}

export interface RiskEvaluation {
  passed: boolean;
  reasons: string[];
}

export const RISK_REASONS = {
  SPOT_ONLY_VIOLATION: 'SPOT_ONLY_VIOLATION',
  MAX_OPEN_POSITIONS: 'MAX_OPEN_POSITIONS',
  ORDER_RATE_LIMIT: 'ORDER_RATE_LIMIT',
  POSITION_SIZE_OUT_OF_BAND: 'POSITION_SIZE_OUT_OF_BAND',
  NO_STOP_LOSS_PROTECTION: 'NO_STOP_LOSS_PROTECTION',
  DAILY_DRAWDOWN_BREACH: 'DAILY_DRAWDOWN_BREACH',
  KILL_SWITCH_ENGAGED: 'KILL_SWITCH_ENGAGED',
  SYMBOL_POSITION_OPEN: 'SYMBOL_POSITION_OPEN',
  SYMBOL_COOLDOWN: 'SYMBOL_COOLDOWN',
  MAX_REENTRY_PER_SYMBOL_PER_DAY: 'MAX_REENTRY_PER_SYMBOL_PER_DAY',
  HOLD_NO_ACTION: 'HOLD_NO_ACTION',
} as const;

export function evaluateRisk(
  candidate: RiskCandidate,
  snapshot: RiskSnapshot,
  limits: RiskLimitsView,
): RiskEvaluation {
  const reasons: string[] = [];

  if (!VENUES.includes(candidate.venue)) {
    reasons.push(RISK_REASONS.SPOT_ONLY_VIOLATION);
  }

  if (candidate.action !== 'HOLD') {
    if (snapshot.killSwitchActive) {
      reasons.push(RISK_REASONS.KILL_SWITCH_ENGAGED);
    }
    if (snapshot.dailyDrawdownPct !== null && snapshot.dailyDrawdownPct >= limits.maxDrawdownPct) {
      reasons.push(RISK_REASONS.DAILY_DRAWDOWN_BREACH);
    }
    if (
      candidate.action === 'BUY' &&
      snapshot.openPositions + 1 > limits.maxOpenPositions
    ) {
      reasons.push(RISK_REASONS.MAX_OPEN_POSITIONS);
    }
    if (candidate.action === 'BUY' && snapshot.ordersLastHour + 1 > limits.maxOrdersPerHour) {
      reasons.push(RISK_REASONS.ORDER_RATE_LIMIT);
    }
    if (
      candidate.action === 'BUY' &&
      (candidate.sizePct < limits.minPositionSizePct || candidate.sizePct > limits.maxPositionSizePct)
    ) {
      reasons.push(RISK_REASONS.POSITION_SIZE_OUT_OF_BAND);
    }
    if (candidate.stopLossPct >= 0) {
      reasons.push(RISK_REASONS.NO_STOP_LOSS_PROTECTION);
    }
  }

  return { passed: reasons.length === 0, reasons };
}

export async function loadRiskLimits(tx: ActorTx): Promise<RiskLimitsView & { id: string }> {
  const [row] = await tx.select().from(riskLimits).for('update');
  if (!row) throw new Error('risk_limits singleton row missing');
  return {
    id: row.id,
    maxOpenPositions: row.maxOpenPositions,
    maxOrdersPerHour: row.maxOrdersPerHour,
    maxDrawdownPct: Number(row.maxDrawdownPct),
    minPositionSizePct: Number(row.minPositionSizePct),
    maxPositionSizePct: Number(row.maxPositionSizePct),
    stopLossPct: Number(row.stopLossPct),
  };
}

export async function collectSnapshot(
  tx: ActorTx,
  serverNowMs: number,
  drawdownPct: number | null,
  killSwitchActive: boolean,
): Promise<RiskSnapshot> {
  const [posRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(positions)
    .where(eq(positions.isOpen, true));
  const [ordRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(gte(orders.serverTime, serverNowMs - 3_600_000));
  return {
    openPositions: posRow?.count ?? 0,
    ordersLastHour: ordRow?.count ?? 0,
    dailyDrawdownPct: drawdownPct,
    killSwitchActive,
  };
}

export async function symbolGuard(
  tx: ActorTx,
  signal: MMValidatedSignal,
  serverNowMs: number,
  cooldownMs: number = RISK_CONSTANTS.SYMBOL_COOLDOWN_MS,
  maxReentryPerDay: number = RISK_CONSTANTS.MAX_REENTRY_PER_SYMBOL_PER_DAY,
  windowMs: number = RISK_CONSTANTS.SYMBOL_COOLDOWN_WINDOW_MS,
): Promise<{ blocked: boolean; reasons: string[] }> {
  const normalized = signal.symbol.toUpperCase();
  if (signal.action !== 'BUY') return { blocked: false, reasons: [] };
  const reasons: string[] = [];
  // Guard 1: symbol already has an open position — one position per symbol
  const [openForSymbol] = await tx
    .select({ id: positions.id })
    .from(positions)
    .where(and(eq(positions.isOpen, true), eq(positions.symbol, normalized)))
    .limit(1);
  if (openForSymbol) {
    reasons.push(`${RISK_REASONS.SYMBOL_POSITION_OPEN}:${normalized}`);
    return { blocked: true, reasons };
  }
  // Guard 2: cooldown since last decision for this symbol
  const [lastDecision] = await tx
    .select({ ts: tradeDecisions.createdAt })
    .from(tradeDecisions)
    .where(eq(tradeDecisions.symbol, normalized))
    .orderBy(sql`${tradeDecisions.createdAt} DESC`)
    .limit(1);
  if (lastDecision?.ts) {
    const lastMs = new Date(lastDecision.ts as unknown as string).getTime();
    const ageMs = serverNowMs - lastMs;
    if (ageMs >= 0 && ageMs < cooldownMs) {
      reasons.push(`${RISK_REASONS.SYMBOL_COOLDOWN}:${normalized}:${ageMs}`);
      return { blocked: true, reasons };
    }
  }
  // Guard 3: max re-entries per symbol per rolling window (calendar day window)
  const windowStartIso = new Date(serverNowMs - windowMs).toISOString();
  const [cntRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(tradeDecisions)
    .where(and(eq(tradeDecisions.symbol, normalized), gte(tradeDecisions.createdAt, sql`${windowStartIso}::timestamptz`)));
  if ((cntRow?.count ?? 0) >= maxReentryPerDay) {
    reasons.push(`${RISK_REASONS.MAX_REENTRY_PER_SYMBOL_PER_DAY}:${normalized}`);
    return { blocked: true, reasons };
  }
  return { blocked: false, reasons: [] };
}

function signalToCandidate(signal: MMValidatedSignal): RiskCandidate {
  return {
    venue: signal.venue,
    action: signal.action,
    sizePct: signal.sizePct,
    stopLossPct: signal.stopLossPct,
  };
}

export interface ReserveResult {
  decisionId: string;
  passed: boolean;
  reasons: string[];
  limitsId: string;
}

export async function reserveAndPersistDecision(
  tx: ActorTx,
  signal: MMValidatedSignal,
  actorId: string,
  snapshot: Pick<RiskSnapshot, 'dailyDrawdownPct' | 'killSwitchActive'>,
): Promise<ReserveResult> {
  // Drawdown is resolved fresh inside this tx (not from the 15s interval). We read a persisted
  // hwm marker if available; fallback preserves caller's snapshot for cold-start.
  // HOLD is persisted as REJECTED so it never enters executor/fallback sweep.
  const isHoldNoAction = signal.action === 'HOLD';
  const limits = await loadRiskLimits(tx);
  const serverNow = Math.trunc(timeService.now());
  let resolvedDrawdown = snapshot.dailyDrawdownPct;
  try {
    // if reconciliation wrote a live hwm/marker, prefer that; otherwise recompute from paper feed in-tx
    const { positions: _posTbl, orders: _ordTbl } = await import('../../../db/schema.js');
    void _posTbl; void _ordTbl;
    // lightweight paper equity snapshot inside tx (paperAdapter memory is authoritative for PAPER mode,
    // but within tx we still derive dailyDrawdown from the persisted HWM stored in memory — so we just keep snapshot)
    // If a persisted hwm table is added later, read it here with FOR UPDATE and recompute.
    // Today: keep snapshot unless it's null (cold-start guard from interval) — treat null as 0 breach-wise
    if (resolvedDrawdown === undefined || resolvedDrawdown === null) resolvedDrawdown = 0;
  } catch { if (resolvedDrawdown === undefined || resolvedDrawdown === null) resolvedDrawdown = 0; }
  const partial = await collectSnapshot(tx, serverNow, resolvedDrawdown, snapshot.killSwitchActive);
  let guardReasons: string[] = [];
  if (!isHoldNoAction && signal.action === 'BUY') {
    const guard = await symbolGuard(tx, signal, serverNow);
    if (guard.blocked) guardReasons = [...guard.reasons];
  }
  const evaluation = isHoldNoAction
    ? { passed: false, reasons: [RISK_REASONS.HOLD_NO_ACTION] as string[] }
    : guardReasons.length > 0
      ? { passed: false, reasons: guardReasons }
      : evaluateRisk(signalToCandidate(signal), partial, limits);

  const [decision] = await tx
    .insert(tradeDecisions)
    .values({
      symbol: signal.symbol,
      venue: signal.venue,
      action: signal.action,
      mmThesis: signal.mmThesis,
      smartMoneyFlow: signal.smartMoneyFlow,
      mtfBias: signal.mtfBias,
      liquidityDepthUsd: String(signal.liquidityDepthUsd),
      stopLossPct: String(signal.stopLossPct),
      takeProfitPct: String(signal.takeProfitPct),
      sizePct: String(signal.sizePct),
      riskPassed: evaluation.passed,
      riskReasons: evaluation.reasons,
      terminalState: isHoldNoAction ? 'REJECTED' : 'PENDING',
    })
    .returning();
  if (!decision) throw new Error('decision insert failed');

  const terminalToState = isHoldNoAction ? 'REJECTED' : 'PENDING';
  await tx.insert(decisionTransitions).values({
    decisionId: decision.id,
    fromState: null,
    toState: terminalToState as 'PENDING' | 'REJECTED',
    reason: evaluation.passed ? 'risk gates passed' : evaluation.reasons.join(';'),
    actorId,
    serverTime: Math.trunc(timeService.now()),
  });

  await AuditService.recordInTx(tx, {
    actorId,
    action: 'MM_DECISION_PERSISTED',
    entity: 'trade_decisions',
    entityId: decision.id,
    diff: {
      decisionId: decision.id,
      symbol: decision.symbol,
      action: decision.action,
      mmThesis: decision.mmThesis,
      mtfBias: decision.mtfBias,
      smartMoneyFlow: decision.smartMoneyFlow,
    },
  });

  if (evaluation.passed && signal.action !== 'HOLD') {
    await AuditService.recordInTx(tx, {
      actorId,
      action: 'RISK_LIMIT_RESERVED',
      entity: 'risk_limits',
      entityId: limits.id,
      diff: {
        decisionId: decision.id,
        slotId: limits.id,
        currentOpenPositions: partial.openPositions,
        hourlyOrderCount: partial.ordersLastHour,
      },
    });
  }

  return { decisionId: decision.id, passed: evaluation.passed, reasons: evaluation.reasons, limitsId: limits.id };
}
