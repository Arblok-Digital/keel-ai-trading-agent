import { getEnv } from '../../config/env.js';
import { RISK_CONSTANTS } from '../../config/risk-constants.js';

export interface TimeSource {
  now(): number;
}

export class SystemTimeSource implements TimeSource {
  now(): number {
    return Date.now();
  }
}

export type ServerTimeProvider = () => Promise<number>;

const binanceTimeProvider: ServerTimeProvider = async () => {
  const base = getEnv().BINANCE_API_URL;
  const res = await fetch(`${base}/api/v3/time`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`binance time http ${res.status}`);
  const json = (await res.json()) as { serverTime?: number };
  if (typeof json.serverTime !== 'number') throw new Error('binance time payload invalid');
  return json.serverTime;
};

class TimeService {
  private readonly source: TimeSource;
  private offsetMs = 0;
  private lastSyncAtMs = 0;
  private lastSyncFrom = 'none';
  private timer: ReturnType<typeof setInterval> | undefined;
  private providers: ServerTimeProvider[] = [binanceTimeProvider];

  constructor(source: TimeSource = new SystemTimeSource()) {
    this.source = source;
  }

  now(): number {
    return Math.trunc(this.source.now() + this.offsetMs);
  }

  offset(): number {
    return this.offsetMs;
  }

  lastSyncInfo(): { from: string; atMs: number } {
    return { from: this.lastSyncFrom, atMs: this.lastSyncAtMs };
  }

  registerProvider(name: string, provider: ServerTimeProvider): void {
    this.providers.push(async () => {
      const t = await provider();
      this.lastSyncFrom = name;
      return t;
    });
  }

  resetProviders(): void {
    this.providers = [binanceTimeProvider];
  }

  async syncOnce(): Promise<boolean> {
    for (const provider of this.providers) {
      try {
        const t0 = this.source.now();
        const serverMs = await provider();
        const t1 = this.source.now();
        const rttMs = t1 - t0;
        this.offsetMs = serverMs - t1 + rttMs / 2;
        this.lastSyncAtMs = this.now();
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  startAutoSync(intervalMs: number = RISK_CONSTANTS.TIME_SYNC_INTERVAL_MS): void {
    if (this.timer) return;
    void this.syncOnce();
    this.timer = setInterval(() => {
      void this.syncOnce();
    }, intervalMs);
    this.timer.unref?.();
  }

  stopAutoSync(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  isStale(tickServerMs: number, limitMs: number = RISK_CONSTANTS.STALENESS_LIMIT_MS): boolean {
    const latencyMs = this.now() - tickServerMs;
    if (latencyMs < 0) return true;
    return latencyMs > limitMs;
  }
}

export const timeService = new TimeService();

export function nowMs(): number {
  return timeService.now();
}

export function isStaleTick(tickServerMs: number, limitMs?: number): boolean {
  return timeService.isStale(tickServerMs, limitMs);
}
