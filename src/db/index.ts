import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getEnv } from '../config/env.js';
import * as schema from '../../db/schema.js';

let pool: Pool | undefined;
let instance: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb(): NonNullable<typeof instance> {
  if (!instance) {
    const url = getEnv().DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not configured');
    pool = new Pool({ connectionString: url, max: 10 });
    instance = drizzle(pool, { schema });
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
  instance = undefined;
}
