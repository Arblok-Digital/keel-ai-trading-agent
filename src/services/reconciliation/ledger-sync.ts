import { desc } from 'drizzle-orm';
import { reconciliationReports } from '../../../db/schema.js';
import { SYSTEM_PRINCIPAL_ID, withActorContext } from '../../db/actor.js';
import { RISK_CONSTANTS } from '../../config/risk-constants.js';
import { AuditService } from '../audit/audit-service.js';
import { agentEvents } from '../events.js';
import { telegram } from '../notifications/telegram.js';
import { engageKillSwitch } from '../risk/kill-switch.js';
import { timeService } from '../ingestion/time-sync.js';
import { evaluateReport } from './discrepancy-handler.js';

export interface BalanceSource {
  localEquityUsd(): Promise<number>;
  exchangeEquityUsd(): Promise<number>;
  breakdown?(): Promise<Record<string, { localUsd: number; exchangeUsd: number }>>;
}

let running = false;
let timer: ReturnType<typeof setInterval> | undefined;

export async function runReconciliationCycle(source: BalanceSource): Promise<typeof reconciliationReports.$inferSelect> {
  const settled = await Promise.allSettled([source.localEquityUsd(), source.exchangeEquityUsd()]);
  const localSettled = settled[0]!;
  const exchangeSettled = settled[1]!;
  if (localSettled.status === 'rejected' || exchangeSettled.status === 'rejected') {
    const errMsg = `reconciliation source error local=${localSettled.status === 'rejected' ? String(localSettled.reason) : 'ok'} exchange=${exchangeSettled.status === 'rejected' ? String(exchangeSettled.reason) : 'ok'}`;
    const report = await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
      const [row] = await tx
        .insert(reconciliationReports)
        .values({
          timestamp: Math.trunc(timeService.now()),
          isSynced: false,
          localBalanceUsd: '0',
          exchangeBalanceUsd: '0',
          discrepancyUsd: '0',
          breakdown: source.breakdown ? await source.breakdown().catch(() => null) : null,
        })
        .returning();
      await AuditService.recordInTx(tx, {
        actorId: SYSTEM_PRINCIPAL_ID,
        action: 'RECONCILIATION_BREACH',
        entity: 'reconciliation_reports',
        entityId: row?.id ?? 'unknown',
        diff: { error: errMsg },
      });
      return row;
    });
    await engageKillSwitch({ actorId: SYSTEM_PRINCIPAL_ID, reason: `RECONCILIATION_SOURCE_FAILURE ${errMsg}` });
    agentEvents.publish('reconciliation', { isSynced: false, discrepancyUsd: 0, halted: true } as never);
    void telegram.alert('recon', `RECON SOURCE FAILURE ${errMsg}`, timeService.now());
    if (!report) throw new Error('reconciliation report insert failed');
    return report;
  }
  const localBalanceUsd = localSettled.value;
  const exchangeBalanceUsd = exchangeSettled.value;
  const verdict = evaluateReport({ localBalanceUsd, exchangeBalanceUsd });

  const report = await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    const [row] = await tx
      .insert(reconciliationReports)
      .values({
        timestamp: Math.trunc(timeService.now()),
        isSynced: verdict.isSynced,
        localBalanceUsd: String(localBalanceUsd),
        exchangeBalanceUsd: String(exchangeBalanceUsd),
        discrepancyUsd: String(verdict.discrepancyUsd),
        breakdown: source.breakdown ? await source.breakdown() : null,
      })
      .returning();

    if (!verdict.isSynced) {
      await AuditService.recordInTx(tx, {
        actorId: SYSTEM_PRINCIPAL_ID,
        action: 'RECONCILIATION_BREACH',
        entity: 'reconciliation_reports',
        entityId: row?.id ?? 'unknown',
        diff: {
          localBalanceUsd,
          exchangeBalanceUsd,
          discrepancyUsd: verdict.discrepancyUsd,
        },
      });
    }

    return row;
  });

  if (!verdict.isSynced) {
    await engageKillSwitch({
      actorId: SYSTEM_PRINCIPAL_ID,
      reason: `RECONCILIATION_BREACH discrepancy ${verdict.discrepancyUsd} USD`,
    });
    agentEvents.publish('reconciliation', { ...verdict, halted: true });
    void telegram.alert('recon', `BALANCE MISMATCH local=${localBalanceUsd} exchange=${exchangeBalanceUsd}`, timeService.now());
  } else {
    telegram.resolveIncident('recon');
    agentEvents.publish('reconciliation', { ...verdict, halted: false });
  }

  if (!report) throw new Error('reconciliation report insert failed');
  return report;
}

export async function latestReport(): Promise<typeof reconciliationReports.$inferSelect | undefined> {
  return withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    const rows = await tx.select().from(reconciliationReports).orderBy(desc(reconciliationReports.timestamp)).limit(1);
    return rows[0];
  });
}

export function startLedgerSyncLoop(source: BalanceSource, intervalMs = RISK_CONSTANTS.RECONCILIATION_INTERVAL_MS): void {
  if (running || timer) return;
  running = true;
  const tick = () => {
    runReconciliationCycle(source).catch((err) => {
      console.error('[ledger-sync] cycle failed:', err instanceof Error ? err.message : err);
    });
  };
  void runReconciliationCycle(source).catch(() => undefined);
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
}

export function stopLedgerSyncLoop(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  running = false;
}
