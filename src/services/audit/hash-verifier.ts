import { desc, eq } from 'drizzle-orm';
import { auditLogs, tradeDecisions } from '../../../db/schema.js';
import { verifyAuditRows } from './audit-service.js';
import { withActorContext } from '../../db/actor.js';
import { engageKillSwitch } from '../risk/kill-switch.js';

export interface VerificationSummary {
  checked: number;
  tamperedIds: string[];
  lockedDown: boolean;
}

export async function verifyAuditChain(limit = 10_000): Promise<VerificationSummary> {
  const rows = await withActorContext('00000000-0000-0000-0000-00000000a001', (tx) =>
    tx
      .select({
        id: auditLogs.id,
        actorId: auditLogs.actorId,
        action: auditLogs.action,
        entity: auditLogs.entity,
        entityId: auditLogs.entityId,
        diff: auditLogs.diff,
        hash: auditLogs.hash,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit),
  );

  const tamperedIds = verifyAuditRows(rows);

  if (tamperedIds.length > 0) {
    await engageKillSwitch({
      actorId: '00000000-0000-0000-0000-00000000a001',
      reason: `AUDIT_HASH_CHAIN_TAMPER detected on ${tamperedIds.length} rows`,
    });
    return { checked: rows.length, tamperedIds, lockedDown: true };
  }
  return { checked: rows.length, tamperedIds, lockedDown: false };
}

export async function decisionsAuditTrail(decisionId: string): Promise<Array<typeof auditLogs.$inferSelect>> {
  return withActorContext('00000000-0000-0000-0000-00000000a001', (tx) =>
    tx.select().from(auditLogs).where(eq(auditLogs.entityId, decisionId)).orderBy(auditLogs.createdAt),
  );
}

export function decisionTableName(): typeof tradeDecisions['_']['name'] {
  return 'trade_decisions';
}
