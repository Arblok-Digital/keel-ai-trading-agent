import { describe, expect, it } from 'vitest';
import {
  isTickFresh,
  onStaleTick,
  type StalenessRejection,
} from '../src/services/ingestion/staleness-gate';
import { timeService } from '../src/services/ingestion/time-sync';

async function pinClockTo(serverMs: number): Promise<void> {
  timeService.resetProviders();
  timeService.registerProvider('test', async () => serverMs);
  const ok = await timeService.syncOnce();
  expect(ok).toBe(true);
}

describe('TimeService server-time synchronization', () => {
  it('applies exchange offset to now()', async () => {
    await pinClockTo(4_000_000);
    expect(Math.abs(timeService.now() - 4_000_000)).toBeLessThanOrEqual(50);
    expect(timeService.lastSyncInfo().from).toBe('test');
  });

  it('falls back across providers when earlier ones fail', async () => {
    timeService.resetProviders();
    let failures = 0;
    timeService.registerProvider('bad', async () => {
      failures += 1;
      throw new Error('down');
    });
    timeService.registerProvider('good', async () => 9_000);
    const ok = await timeService.syncOnce();
    expect(ok).toBe(true);
    expect(failures).toBe(1);
    expect(Math.abs(timeService.now() - 9_000)).toBeLessThanOrEqual(50);
    expect(timeService.offset()).not.toBe(0);
  });

  it('isStale respects custom limits', () => {
    expect(timeService.isStale(timeService.now() - 100, 200)).toBe(false);
    expect(timeService.isStale(timeService.now() - 300, 200)).toBe(true);
  });
});

describe('staleness gate (>1500ms rejection, US-07)', () => {
  it('accepts fresh ticks within limit', async () => {
    const now = 10_000;
    await pinClockTo(now);
    expect(isTickFresh('BTCUSDT', 'BINANCE_SPOT', now - 500)).toBe(true);
  });

  it('rejects ticks older than 1500ms and reports structured rejection', async () => {
    const rejections: StalenessRejection[] = [];
    onStaleTick((r) => rejections.push(r));
    const now = 20_000;
    await pinClockTo(now);
    const fresh = isTickFresh('BTCUSDT', 'BINANCE_SPOT', now - 1600);
    expect(fresh).toBe(false);
    expect(rejections[0]?.symbol).toBe('BTCUSDT');
    expect(rejections[0]?.venue).toBe('BINANCE_SPOT');
    expect(rejections[0]?.latencyMs).toBeGreaterThan(1500);
    expect(rejections[0]?.limitMs).toBe(1500);
  });
});
