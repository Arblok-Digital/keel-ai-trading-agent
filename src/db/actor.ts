import { sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgTransaction } from 'drizzle-orm/node-postgres';
import { getDb } from './index.js';
import type * as schema from '../../db/schema.js';

export const SYSTEM_PRINCIPAL_ID = '00000000-0000-0000-0000-00000000a001';

export type ActorTx = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

export async function withActorContext<T>(userId: string, fn: (tx: ActorTx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    return fn(tx);
  });
}
