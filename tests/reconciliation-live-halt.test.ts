import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { runReconciliationCycle, stopLedgerSyncLoop } from '../src/services/reconciliation/ledger-sync';
import { resetVolatileLatchForTests } from '../src/services/risk/kill-switch';
import { getEnv } from '../src/config/env';
import { Pool } from 'pg';

let dbAvailable = false;

async function tryConnect(): Promise<Pool | null> {
  let url: string | undefined;
  try {
    url = getEnv().DATABASE_URL;
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
  const pool = await tryConnect();
  dbAvailable = pool !== null;
  if (pool) {
    const { getDb } = await import('../src/db/index');
    // warm the db connection via the app getDb singleton so withActorContext resolves
    try {
      getDb();
    } catch {
      /* ignore */
    }
  }
  resetVolatileLatchForTests();
  stopLedgerSyncLoop();
});

afterAll(() => {
  stopLedgerSyncLoop();
  resetVolatileLatchForTests();
});

describe('reconciliation live halt — integration', () => {
  it('does not halt when local and exchange balances match (within tolerance)', async () => {
    if (!dbAvailable) return console.warn('[skip] DATABASE_URL unreachable; skipped');
    resetVolatileLatchForTests();
    const report = await runReconciliationCycle({
      localEquityUsd: async () => 10_000.2,
      exchangeEquityUsd: async () => 10_000,
      breakdown: async () => ({ BINANCE_SPOT: { localUsd: 10_000.2, exchangeUsd: 10_000 } }),
    });
    expect(report.isSynced).toBe(true);
  }, 30_000);

  it('halts and engages kill switch when exchange balance differs by more than $1', async () => {
    if (!dbAvailable) return console.warn('[skip] DATABASE_URL unreachable; skipped');
    resetVolatileLatchForTests();
    const local = 10_000;
    const exchange = 10_050; // $50 mismatch -> above $1 tolerance
    const report = await runReconciliationCycle({
      localEquityUsd: async () => local,
      exchangeEquityUsd: async () => exchange,
      breakdown: async () => ({ BINANCE_SPOT: { localUsd: local, exchangeUsd: exchange } }),
    });
    expect(report.isSynced).toBe(false);
    // volatile latch set => further decisions halted
    const { isKillSwitchActiveTx } = await import('../src/services/risk/kill-switch');
    const active = await withOwnerTx((tx) => (isKillSwitchActiveTx as (tx: unknown) => Promise<boolean>)(tx as never));
    expect(active).toBe(true);
  }, 30_000);
});

async function withOwnerTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const { withActorContext } = await import('../src/db/actor');
  return withActorContext('00000000-0000-0000-0000-00000000a001', (tx) => fn(tx));
}
