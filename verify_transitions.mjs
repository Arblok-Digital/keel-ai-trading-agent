// verify_transitions.mjs — bukti DB: index composite + FSM decision_transitions
// Run: node --env-file=.env verify_transitions.mjs
import pg from 'pg';

const { Pool } = pg;
const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url, max: 3 });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}

// clean slate for test decision id
const TEST_DEC = '11111111-1111-4111-8111-111111111111';
const SYS_AGENT = '00000000-0000-0000-0000-00000000a001';

try {
  await pool.query('BEGIN');

  // 1) index state
  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename='decision_transitions' AND indexname LIKE 'decision_transitions_decision_id%'`,
  );
  const names = idx.rows.map((r) => r.indexname);
  check('composite index (decision_id,to_state) ada', names.includes('decision_transitions_decision_id_to_state_key'));
  check('index lama (decision_id) SUDAH di-drop', !names.includes('decision_transitions_decision_id_key'));

  // 2) seed a decision (admin bypass RLS; triggers tetap jalan)
  await pool.query(
    `INSERT INTO trade_decisions (id, symbol, venue, action, mm_thesis, smart_money_flow, mtf_bias, liquidity_depth_usd, stop_loss_pct, take_profit_pct, size_pct, risk_passed, risk_reasons, terminal_state)
     VALUES ($1,'BTCUSDT','BINANCE_SPOT','BUY','verify','ACCUMULATION','{"m15":"BULLISH","h1":"BULLISH","h4":"NEUTRAL","d1":"NEUTRAL"}',100,-2,4,3,true,'[]','PENDING')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_DEC],
  );

  // 3) INSERT NULL->PENDING (initial) — harus lolos guard
  let ok = true;
  try {
    await pool.query(
      `INSERT INTO decision_transitions (decision_id, from_state, to_state, actor_id, server_time) VALUES ($1,NULL,'PENDING',$2,1)`,
      [TEST_DEC, SYS_AGENT],
    );
  } catch {
    ok = false;
  }
  check('transition #1 NULL->PENDING diterima', ok);

  // 4) INSERT PENDING->EXECUTED — sebelumnya di-block unique index decision_id; sekarang merge? composite (decision_id,to_state)
  ok = true;
  try {
    await pool.query(
      `INSERT INTO decision_transitions (decision_id, from_state, to_state, actor_id, server_time) VALUES ($1,'PENDING','EXECUTED',$2,2)`,
      [TEST_DEC, SYS_AGENT],
    );
  } catch (e) {
    ok = false;
    console.log('   detail:', e.message);
  }
  check('transition #2 PENDING->EXECUTED diterima (P0-2 fixed)', ok);

  // 5) Illegal: PENDING->PENDING harus ditolak guard
  ok = true;
  try {
    await pool.query(
      `INSERT INTO decision_transitions (decision_id, from_state, to_state, actor_id, server_time) VALUES ($1,'PENDING','PENDING',$2,3)`,
      [TEST_DEC, SYS_AGENT],
    );
    ok = false;
  } catch {}
  check('illegal PENDING->PENDING ditolak', ok);

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