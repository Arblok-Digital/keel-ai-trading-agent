import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { lt } from 'drizzle-orm';
import { auditLogs } from '../../../db/schema.js';
import { SYSTEM_PRINCIPAL_ID, withActorContext } from '../../db/actor.js';
import { getEnv } from '../../config/env.js';
import { timeService } from '../ingestion/time-sync.js';

const RETENTION_DAYS = 90;

export interface ArchiveResult {
  archivedCount: number;
  archiveFile: string;
}

export async function exportAgedAuditRecords(nowServerMs = timeService.now()): Promise<ArchiveResult> {
  const cutoff = new Date(nowServerMs - RETENTION_DAYS * 86_400_000);
  const rows = await withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
    tx.select().from(auditLogs).where(lt(auditLogs.createdAt, cutoff)).limit(50_000),
  );

  const dir = getEnv().ARCHIVE_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const monthTag = new Date(cutoff).toISOString().slice(0, 7);
  const file = join(dir, `audit-archive-${monthTag}.jsonl`);
  for (const row of rows) {
    appendFileSync(file, `${JSON.stringify(row)}\n`);
  }
  return { archivedCount: rows.length, archiveFile: file };
}
