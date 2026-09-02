import { describe, expect, it, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getEnv } from '../../src/config/env';
import { RISK_CONSTANTS } from '../../src/config/risk-constants';

let pool: Pool | null = null;
let adminPool: Pool | null = null;
let dbAvailable = false;

const OWNER_ID = '00000000-0000-0000-0000-0000000000aa';
const VIEWER_ID = '00000000-0000-0000-0000-0000000000bb';
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

beforeAll(async () => {
  pool = await tryConnect();
  adminPool = await tryAdminConnect();
  dbAvailable = pool !== null;
  // Seed users + roles via SUPERUSER connection (RLS blocks keel_app inserts on users)
  if (adminPool) {
    await adminPool.query(sqlSeedUsers());
    await adminPool.query(
      `INSERT INTO user_roles (user_id, role)
       SELECT id, CASE WHEN email='owner@it' THEN 'owner' WHEN email='viewer@it' THEN 'viewer' ELSE 'system_agent' END
       FROM users WHERE email IN ('owner@it','viewer@it','system_agent@internal')
       ON CONFLICT (user_id, role) DO NOTHING`,
    );
  }
});

describe.sequential('RLS matrix (docs/security.md) — integration', () => {
  it('database reachable', async () => {
    if (!dbAvailable) return console.warn('[skip] DATABASE_URL unreachable; integration suite skipped');
    expect(dbAvailable).toBe(true);
  });

  it('system_agent inserts trade_decisions; viewer cannot', async () => {
    if (!dbAvailable || !pool) return console.warn('[skip] no db');

    const agentClient = await pool.connect();
    try {
      await agentClient.query('BEGIN');
      await agentClient.query(`SET LOCAL app.current_user_id = '${AGENT_ID}'`);
      await agentClient.query('SET LOCAL ROLE keel_app');
      const ins = await agentClient.query(
        `INSERT INTO trade_decisions (symbol, venue, action, mm_thesis, smart_money_flow, mtf_bias, liquidity_depth_usd, stop_loss_pct, take_profit_pct, size_pct, risk_passed, risk_reasons)
         VALUES ('BTCUSDT','BINANCE_SPOT','BUY','integration thesis long enough','ACCUMULATION','{"m15":"BULLISH","h1":"BULLISH","h4":"BULLISH","d1":"BULLISH"}',100,-2,4,3,true,'[]')
         RETURNING id`,
      );
      expect(ins.rows).toHaveLength(1);
      const transition = await agentClient.query(
        `INSERT INTO decision_transitions (decision_id, from_state, to_state, actor_id, server_time)
         VALUES ($1, NULL, 'PENDING', $2, 1) RETURNING id`,
        [ins.rows[0].id, AGENT_ID],
      );
      expect(transition.rows).toHaveLength(1);
      await agentClient.query('ROLLBACK');
    } finally {
      agentClient.release();
    }

    const viewerClient = await pool.connect();
    try {
      await viewerClient.query('BEGIN');
      const viewerIdRow = await viewerClient.query(`SELECT id FROM users WHERE email='viewer@it'`);
      const viewerId: string | undefined = viewerIdRow.rows[0]?.id;
      if (!viewerId) {
        await viewerClient.query('ROLLBACK');
        return;
      }
      await viewerClient.query(`SET LOCAL app.current_user_id = '${viewerId}'`);
      await viewerClient.query('SET LOCAL ROLE keel_app');
      await expect(
        viewerClient.query(
          `INSERT INTO trade_decisions (symbol, venue, action, mm_thesis, smart_money_flow, mtf_bias, liquidity_depth_usd, stop_loss_pct, take_profit_pct, size_pct, risk_passed, risk_reasons)
           VALUES ('BTCUSDT','BINANCE_SPOT','BUY','x','NEUTRAL','{}',1,-2,4,3,true,'[]')`,
        ),
      ).rejects.toThrow(/row-level security/i);
      await viewerClient.query('ROLLBACK');
    } finally {
      viewerClient.release();
    }
  }, 30_000);

  it('audit_logs is append-only at trigger level even for privileged roles', async () => {
    if (!dbAvailable || !adminPool) return console.warn('[skip] no db');
    // Superuser: only the trigger (not GRANT) can block mutations.
    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO audit_logs (actor_id, action, entity, entity_id, diff, hash)
         VALUES ($1,'TEST_ACTION','e','id-1','{}','deadbeef') RETURNING id`,
        [OWNER_ID],
      );
      const auditId = ins.rows[0].id;
      await expect(client.query(`UPDATE audit_logs SET action='HACKED' WHERE id=$1`, [auditId])).rejects.toThrow(/append-only/i);
      await client.query('ROLLBACK');
      // DELETE in a fresh transaction (failed UPDATE aborted the previous one)
      await client.query('BEGIN');
      const ins2 = await client.query(
        `INSERT INTO audit_logs (actor_id, action, entity, entity_id, diff, hash)
         VALUES ($1,'TEST_ACTION','e','id-2','{}','deadbeef') RETURNING id`,
        [OWNER_ID],
      );
      await expect(client.query(`DELETE FROM audit_logs WHERE id=$1`, [ins2.rows[0].id])).rejects.toThrow(/append-only/i);
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }, 30_000);

  it('orders FSM rejects backward transitions', async () => {
    if (!dbAvailable || !pool) return console.warn('[skip] no db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const agent = AGENT_ID;
      await client.query(`SET LOCAL app.current_user_id = '${agent}'`);
      await client.query(`SET LOCAL ROLE keel_app`);
      const dec = (
        await client.query(
          `INSERT INTO trade_decisions (symbol, venue, action, mm_thesis, smart_money_flow, mtf_bias, liquidity_depth_usd, stop_loss_pct, take_profit_pct, size_pct, risk_passed, risk_reasons)
           VALUES ('ETHUSDT','RAYDIUM','BUY','fsm test thesis','ACCUMULATION','{"m15":"BULLISH","h1":"BULLISH","h4":"BULLISH","d1":"BULLISH"}',10,-2,4,3,true,'[]') RETURNING id`,
        )
      ).rows[0];
      const ord = (
        await client.query(
          `INSERT INTO orders (client_order_id, decision_id, venue, symbol, side, requested_qty, status, server_time)
           VALUES ('cID-fsm-1', $1, 'RAYDIUM', 'ETHUSDT', 'BUY', 1, 'PENDING', 1) RETURNING id`,
          [dec.id],
        )
      ).rows[0];
      await client.query(`UPDATE orders SET status='FILLED' WHERE id=$1`, [ord.id]);
      await expect(client.query(`UPDATE orders SET status='PENDING' WHERE id=$1`, [ord.id])).rejects.toThrow(
        /illegal order status transition/i,
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }, 30_000);

  it('concurrent gatekeeper reservations never exceed limits (US-03 race)', async () => {
    if (!dbAvailable || !pool) return console.warn('[skip] no db');
    const client = await pool.connect();
    const decisionIds: string[] = [];
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_user_id = '${AGENT_ID}'`);
      await client.query(`SET LOCAL ROLE keel_app`);
      for (let i = 0; i < 8; i++) {
        const row = (
          await client.query(
            `INSERT INTO trade_decisions (symbol, venue, action, mm_thesis, smart_money_flow, mtf_bias, liquidity_depth_usd, stop_loss_pct, take_profit_pct, size_pct, risk_passed, risk_reasons)
             VALUES ('SOLUSDC','BINANCE_SPOT','BUY','race thesis number ' || $1, 'ACCUMULATION','{"m15":"BULLISH","h1":"BULLISH","h4":"BULLISH","d1":"BULLISH"}',10,-2,4,2.5,true,'[]') RETURNING id`,
            [i],
          )
        ).rows[0];
        decisionIds.push(row.id);
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const results = await Promise.allSettled(
      decisionIds.map((id) =>
        withTx(pool!, async (c) => {
          await c.query(`SET LOCAL app.current_user_id = '${AGENT_ID}'`);
          await c.query(`SET LOCAL ROLE keel_app`);
          const lock = await c.query(`SELECT * FROM risk_limits FOR UPDATE`);
          expect(lock.rows).toHaveLength(1);
          const open = await c.query(`SELECT count(*)::int AS n FROM positions WHERE is_open`);
          const hour = await c.query(`SELECT count(*)::int AS n FROM orders WHERE server_time > extract(epoch from now()) * 1000 - 3600000`);
          if (open.rows[0].n >= 5 || hour.rows[0].n >= 10) {
            return 'rejected';
          }
          await c.query(
            `INSERT INTO orders (client_order_id, decision_id, venue, symbol, side, requested_qty, status, server_time)
             VALUES ($1, $2, 'BINANCE_SPOT', 'SOLUSDC', 'BUY', 1, 'FILLED', extract(epoch from now()) * 1000)`,
            [`cID-race-${id}`, id],
          );
          await c.query(`INSERT INTO positions (symbol, venue, decision_id, order_id, size_pct, entry_price, stop_loss_price, take_profit_price)
             SELECT symbol, venue, decision_id, id, 2.5, 1, 0.98, 1.04 FROM orders WHERE decision_id = $1`, [id]);
          return 'accepted';
        }),
      ),
    );

    const accepted = results.filter((r) => r.status === 'fulfilled' && r.value === 'accepted').length;
    expect(accepted).toBeLessThanOrEqual(RISK_CONSTANTS.MAX_OPEN_POSITIONS);
  }, 60_000);
});

function sqlSeedUsers(): string {
  return `
    INSERT INTO users (id, email) VALUES
      ('${OWNER_ID}', 'owner@it'),
      ('${VIEWER_ID}', 'viewer@it'),
      ('${AGENT_ID}', 'system_agent@internal')
    ON CONFLICT (email) DO NOTHING;
  `;
}

async function withTx(pool: Pool, fn: (client: import('pg').PoolClient) => Promise<string>): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
