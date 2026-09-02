import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { auditLogs } from '../../../db/schema.js';
import { timeService } from '../ingestion/time-sync.js';
import type { ActorTx } from '../../db/actor.js';

export interface AuditRecordParams {
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  diff?: Record<string, unknown> | null;
}

type InsertCapable = Pick<ActorTx, 'insert' | 'execute'>;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export function computeAuditHash(input: {
  prevHash: string | null;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  diff: Record<string, unknown> | null;
  createdAtIso: string;
}): string {
  const payload = [
    input.prevHash ?? 'GENESIS',
    input.actorId,
    input.action,
    input.entity,
    input.entityId,
    canonicalJson(input.diff),
    input.createdAtIso,
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}

async function getLastHash(tx: InsertCapable): Promise<string | null> {
  // Cross-process serialization: worker + API both append audit rows; the advisory
  // xact lock prevents two writers from reading the same prevHash (chain fork).
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('keel_audit_chain'))`);
  const result = await tx.execute(sql`SELECT hash FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 1`);
  const rows = (result as unknown as { rows?: Array<{ hash: string }> }).rows ?? [];
  return rows[0]?.hash ?? null;
}

function buildRow(params: AuditRecordParams, prevHash: string | null): typeof auditLogs.$inferInsert {
  const createdAt = new Date(timeService.now());
  return {
    actorId: params.actorId,
    action: params.action,
    entity: params.entity,
    entityId: params.entityId,
    diff: params.diff ?? null,
    createdAt,
    hash: computeAuditHash({
      prevHash,
      actorId: params.actorId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId,
      diff: params.diff ?? null,
      createdAtIso: createdAt.toISOString(),
    }),
  };
}

export const AuditService = {
  async recordInTx(tx: InsertCapable, params: AuditRecordParams): Promise<void> {
    const prevHash = await getLastHash(tx);
    await tx.insert(auditLogs).values(buildRow(params, prevHash));
  },

  buildValues(params: AuditRecordParams): typeof auditLogs.$inferInsert {
    return buildRow(params, null);
  },
};

export interface ChainRow {
  id: string;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  diff: unknown;
  hash: string;
  createdAt: Date;
}

export function verifyAuditRows(rows: ChainRow[]): string[] {
  const tampered: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const prevRow = rows[i + 1] ?? null;
    const expected = computeAuditHash({
      prevHash: prevRow?.hash ?? null,
      actorId: row.actorId,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      diff: (row.diff ?? null) as Record<string, unknown> | null,
      createdAtIso: row.createdAt.toISOString(),
    });
    if (expected !== row.hash) tampered.push(row.id);
  }
  return tampered;
}
