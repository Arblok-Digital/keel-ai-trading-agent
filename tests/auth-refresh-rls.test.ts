import { describe, expect, it, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getEnv } from '../src/config/env';
import { createHash } from 'node:crypto';

let pool: Pool | null = null;
let adminPool: Pool | null = null;
let dbAvailable = false;

const OWNER_ID = '00000000-0000-0000-0000-00000000aa01';
const AGENT_ID = '00000000-0000-0000-0000-00000000a001';

async function tryConnect(): Promise<Pool | null> {
  let url: string | undefined;
  try {
    url = getEnv().DATABASE_URL;
  } catch {
    return null;
  }
  if (!url) return null;
  const candidate = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 2000 });
  try {
    await candidate.query('SELECT 1');
    return candidate;
  } catch {
    await candidate.end().catch(() => undefined);
    return null;
  }
}

async function tryAdminConnect(): Promise<Pool | null> {
  let url: string | undefined;
  try {
    url = getEnv().ADMIN_DATABASE_URL ?? getEnv().DATABASE_URL;
  } catch {
    return null;
  }
  if (!url) return null;
  const candidate = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 2000 });
  try {
    await candidate.query('SELECT 1');
    return candidate;
  } catch {
    await candidate.end().catch(() => undefined);
    return null;
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

beforeAll(async () => {
  pool = await tryConnect();
  adminPool = await tryAdminConnect();
  dbAvailable = pool !== null;
  // Seed users + roles via SUPERUSER connection (RLS on those tables blocks keel_app inserts)
  if (adminPool) {
    await adminPool.query(sqlSeed());
    await adminPool.query(
      `INSERT INTO user_roles (user_id, role)
       SELECT id, CASE WHEN email='owner@rt' THEN 'owner' ELSE 'system_agent' END
       FROM users WHERE email IN ('owner@rt','system_agent@internal')
       ON CONFLICT (user_id, role) DO NOTHING`,
    );
  }
});

describe.sequential('refresh token rotation & RLS (OWASP reuse revocation)', () => {
  it('rotate_refresh_token runs under keel_app and returns user role', async () => {
    if (!dbAvailable || !pool) return console.warn('[skip] no db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_user_id = '${OWNER_ID}'`);
      await client.query(`SET LOCAL ROLE keel_app`);
      const owner = (await client.query(`SELECT id FROM users WHERE email='owner@rt'`)).rows[0].id;
      const familyId = crypto.randomUUID();
      const oldHash = sha256Hex(`old-${crypto.randomUUID()}`);
      const newHash = sha256Hex(`new-${crypto.randomUUID()}`);
      await client.query(`SET LOCAL app.current_user_id = '${owner}'`);
      await client.query(
        `INSERT INTO sessions (user_id, family_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')`,
        [owner, familyId, oldHash],
      );
      await client.query('COMMIT');
      // RLS block must run inside an explicit transaction so SET LOCAL persists.
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_user_id = '${owner}'`);
      await client.query(`SET LOCAL ROLE keel_app`);
      const rotated = await client.query(
        `SELECT * FROM rotate_refresh_token($1, $2, now() + interval '1 hour')`,
        [oldHash, newHash],
      );
      expect(rotated.rows).toHaveLength(1);
      const row = rotated.rows[0];
      expect(row).toHaveProperty('user_id');
      expect(row).toHaveProperty('role');
      expect(['owner', 'viewer', 'system_agent']).toContain(row.role);
      const s = await client.query(`SELECT token_hash FROM sessions WHERE family_id=$1`, [familyId]);
      expect(s.rows[0].token_hash).toBe(newHash);
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }, 30_000);

  it('reusing a revoked refresh token revokes the whole family', async () => {
    if (!dbAvailable || !pool) return console.warn('[skip] no db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_user_id = '${OWNER_ID}'`);
      await client.query(`SET LOCAL ROLE keel_app`);
      const owner = (await client.query(`SELECT id FROM users WHERE email='owner@rt'`)).rows[0].id;
      const familyId = crypto.randomUUID();
      const revokedHash = sha256Hex(`rev-${crypto.randomUUID()}`);
      const activeHash = sha256Hex(`act-${crypto.randomUUID()}`);
      await client.query(`SET LOCAL app.current_user_id = '${owner}'`);
      await client.query(
        `INSERT INTO sessions (user_id, family_id, token_hash, expires_at, revoked_at) VALUES
           ($1,$2,$3, now() + interval '1 hour', now() - interval '1 minute'),
           ($1,$2,$4, now() + interval '1 hour', NULL)`,
        [owner, familyId, revokedHash, activeHash],
      );
      await client.query('COMMIT');
      // RLS block inside explicit transaction so SET LOCAL persists.
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_user_id = '${owner}'`);
      await client.query(`SET LOCAL ROLE keel_app`);
      // replaying a revoked token -> reuse detection revokes the ENTIRE family
      await expect(
        client.query(`SELECT * FROM rotate_refresh_token($1, $2, now() + interval '1 hour')`, [
          revokedHash,
          sha256Hex('would-be-new'),
        ]),
      ).rejects.toThrow(/reuse/i);
      // RAISE aborts the outer txn; the family revoke lives in a committed sub-txn.
      // Inspect in a fresh transaction.
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_user_id = '${owner}'`);
      await client.query(`SET LOCAL ROLE keel_app`);
      const s = await client.query(`SELECT revoked_at IS NOT NULL AS revoked FROM sessions WHERE family_id=$1`, [familyId]);
      expect(s.rows.every((r) => r.revoked)).toBe(true);
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }, 30_000);
});

function sqlSeed(): string {
  return `
    INSERT INTO users (id, email) VALUES
      ('${OWNER_ID}', 'owner@rt'),
      ('${AGENT_ID}', 'system_agent@internal')
    ON CONFLICT (email) DO NOTHING;
    INSERT INTO user_roles (user_id, role) VALUES
      ('${OWNER_ID}', 'owner')
    ON CONFLICT (user_id, role) DO NOTHING;
  `;
}
