import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { getEnv } from '../config/env.js';

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');
const RLS_FILE = join(process.cwd(), 'db', 'rls.sql');

function resolveSql(file: string): string {
  const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  if (raw.includes('-- [RLS]')) {
    const rls = readFileSync(RLS_FILE, 'utf8');
    return raw.replace('-- [RLS]', () => rls);
  }
  return raw;
}

async function run(): Promise<void> {
  const adminUrl = getEnv().ADMIN_DATABASE_URL ?? getEnv().DATABASE_URL;
  if (!adminUrl) throw new Error('ADMIN_DATABASE_URL or DATABASE_URL required for migrations');
  const pool = new Pool({ connectionString: adminUrl });
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const applied = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
      if (applied.rowCount && applied.rowCount > 0) continue;
      const sqlText = resolveSql(file);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sqlText);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file} (incl. db/rls.sql where marked)`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
    console.log('[migrate] up to date');
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('db/migrate.ts');
if (invokedDirectly) {
  run().catch((err) => {
    console.error('[migrate] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
