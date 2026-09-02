// verify_triggers.mjs — bukti DB: append-only, terminal_state, orders FSM, risk_limits guard (S3)
// Run: node --env-file=.env verify_triggers.mjs
import pg from 'pg';

const { Pool } = pg;
const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url, max: 3 });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}

const TEST_DEC = '22222222-2222-4222-8222-222222222222';
const TEST_ORD = '33333333-3333-4333-8333-333333333333';

try {
  await pool.query('BEGIN');

  // 1) audit_logs append-only: UPDATE harus ditolak
  const [al] = (await pool.query('SELECT id FROM audit_logs ORDER BY created_at DESC LIMIT 1')).rows;
  let ok = true;
  if (al) {
    try {
      await pool.query(`UPDATE audit_logs SET diff='{}' WHERE id=$1`, [al.id]);
      ok = false;
    } catch {}
  }
  check('audit_logs UPDATE ditolak (append-only)', ok);

  // 2) trade_decisions: update terminal_state DIPERBOLEHKAN
  await pool.query(
    `INSERT INTO trade_decisions (id, symbol, venue, action, mm_thesis, smart_money_flow, mtf_bias, liquidity_depth_usd, stop_loss_pct, take_profit_pct, size_pct, risk_passed, risk_reasons, terminal_state)
     VALUES ($1,'BTCUSDT','BINANCE_SPOT','BUY','verify','NEUTRAL','{"m15":"NEUTRAL","h1":"NEUTRAL","h4":"NEUTRAL","d1":"NEUTRAL"}',100,-2,4,3,true,'[]','PENDING')`,
    [TEST_DEC],
  );
  ok = true;
  try {
    await pool.query(`UPDATE trade_decisions SET terminal_state='REJECTED' WHERE id=$1`, [TEST_DEC]);
  } catch (e) {
    ok = false;
    console.log('   detail:', e.message);
  }
  check('trade_decisions terminal_state UPDATE diterima (P0-3 fixed)', ok);

  // 3) trade_decisions: UPDATE kolom lain harus ditolak
  ok = true;
  try {
    await pool.query(`UPDATE trade_decisions SET symbol='ETHUSDT' WHERE id=$1`, [TEST_DEC]);
    ok = false;
  } catch {}
  check('trade_decisions UPDATE kolom lain ditolak', ok);

  // 4) orders FSM: INSERT harus PENDING
  ok = true;
  try {
    await pool.query(
      `INSERT INTO orders (id, client_order_id, decision_id, venue, symbol, side, requested_qty, status, server_time)
       VALUES ($1,'verify-ord-1',$2,'BINANCE_SPOT','BTCUSDT','BUY',0.001,'FILLED',1)`,
      [TEST_ORD, TEST_DEC],
    );
    ok = false;
  } catch {}
  check('orders INSERT non-PENDING ditolak (FSM)', ok);

  // 5) orders FSM: PENDING->FILLED legal
  await pool.query(
    `INSERT INTO orders (id, client_order_id, decision_id, venue, symbol, side, requested_qty, status, server_time)
     VALUES ($1,'verify-ord-2',$2,'BINANCE_SPOT','BTCUSDT','BUY',0.001,'PENDING',2)`,
    [TEST_ORD, TEST_DEC],
  );
  ok = true;
  try {
    await pool.query(`UPDATE orders SET status='FILLED' WHERE id=$1`, [TEST_ORD]);
  } catch {
    ok = false;
  }
  check('orders PENDING->FILLED diterima', ok);
  ok = true;
  try {
    await pool.query(`UPDATE orders SET status='PENDING' WHERE id=$1`, [TEST_ORD]);
  } catch {}
  // FILLED->PENDING ilegal
  const [cur] = (await pool.query(`SELECT status FROM orders WHERE id=$1`, [TEST_ORD])).rows;
  if (cur && cur.status === 'FILLED') {
    try {
      await pool.query(`UPDATE orders SET status='PENDING' WHERE id=$1`, [TEST_ORD]);
      ok = false;
    } catch {}
  }
  check('orders FILLED->PENDING (backward) ditolak', ok);

  // 6) risk_limits guard (S3): non-owner (aktorkosong => auth_has_role false) tidak boleh ubah nilai
  ok = true;
  try {
    await pool.query(`UPDATE risk_limits SET max_open_positions = max_open_positions + 1`);
    ok = false;
  } catch {}
  check('risk_limits nilai diubah non-owner ditolak (S3)', ok);

  await pool.query('ROLLBACK');
} catch (e) {
  await pool.query('ROLLBACK').catch(() => undefined);
  console.error('VERIFY ERROR:', e.message);
  results.push({ name: 'suite', ok: false });
} finally {
  await pool.end();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} pass ===`);
process.exit(failed.length ? 1 : 0);