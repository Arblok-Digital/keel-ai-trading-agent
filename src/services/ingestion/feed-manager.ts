import type { NormalizedDepth, NormalizedTrade } from '../../types/exchange.js';
import { timeService } from './time-sync.js';
import { agentEvents } from '../events.js';
import { RISK_CONSTANTS } from '../../config/risk-constants.js';
import { getRedis } from '../redis.js';

export type FeedSourceId = 'BINANCE' | 'GATE' | 'VISION' | 'COINBASE';
export type FeedKind = 'depth' | 'trade' | 'kline';
type ListenerD = (d: NormalizedDepth) => void;
type ListenerT = (t: NormalizedTrade) => void;

export interface SourceMetrics {
  source: FeedSourceId;
  connected: boolean;
  lastTickMs: number | null;
  stale: boolean;
  msgPerSec: number;
  lastError: string | null;
}

export interface DataSourceState {
  depth: Record<string, SourceMetrics>;
  trade: Record<string, SourceMetrics>;
  active: Partial<Record<FeedKind, FeedSourceId>>;
  watchlist: string[];
}

export interface FeedProvider {
  readonly id: FeedSourceId;
  start(symbols: string[], handlers: { onDepth: ListenerD; onTrade: ListenerT }): void;
  stop(): void;
}

export function canonicalSymbol(sym: string): string {
  return sym.toUpperCase();
}
export function toGateSymbol(sym: string): string {
  const c = canonicalSymbol(sym);
  if (c.includes('_')) return c;
  if (c.endsWith('USDT')) return c.slice(0, -4) + '_USDT';
  if (c.endsWith('USDC')) return c.slice(0, -4) + '_USDC';
  return c;
}
export function toCoinbaseSymbol(sym: string): string {
  const c = canonicalSymbol(sym);
  if (c.includes('-')) return c;
  if (c.endsWith('USDT')) return c.slice(0, -4) + '-USD';
  if (c.endsWith('USDC')) return c.slice(0, -4) + '-USD';
  return c;
}
export function normalizeSymbolFromSource(raw: string, source: FeedSourceId): string {
  const u = raw.toUpperCase();
  if (source === 'GATE') return u.replace('_', '');
  if (source === 'COINBASE') {
    if (u.includes('-')) return u.replace('-', '') + 'T';
    return u;
  }
  return u;
}

const FALLBACK_ORDER: FeedSourceId[] = ['GATE', 'VISION', 'COINBASE', 'BINANCE'];

export class MultiSourceFeedManager {
  private providers: Partial<Record<FeedSourceId, FeedProvider>> = {};
  private active: Partial<Record<FeedKind, FeedSourceId>> = {};
  private metrics: Map<string, SourceMetrics> = new Map();
  private msgCount: Map<string, number> = new Map();
  private symbolList: string[] = [];
  private handlers: { onDepth: ListenerD; onTrade: ListenerT } | null = null;
  private checkTimer: ReturnType<typeof setInterval> | undefined;
  private switchCooldownMs = 5000;
  private lastSwitchAt = 0;
  private started = false;

  register(provider: FeedProvider): void {
    this.providers[provider.id] = provider;
  }

  start(symbols: string[], handlers: { onDepth: ListenerD; onTrade: ListenerT }): void {
    if (this.started) return;
    this.started = true;
    this.symbolList = symbols.map(canonicalSymbol);
    this.handlers = handlers;
    for (const kind of ['depth', 'trade'] as FeedKind[]) {
      for (const sid of FALLBACK_ORDER) {
        if (this.providers[sid]) {
          this.active[kind] = sid;
          this.updateMetric(kind, sid, { connected: false, lastError: null });
          break;
        }
      }
    }
    this.startActiveProviders();
    this.checkTimer = setInterval(() => this.checkStaleness(), 10_000);
    this.checkTimer.unref?.();
    setInterval(() => this.publishStateToRedis().catch(() => undefined), 5000).unref?.();
  }

  private async publishStateToRedis(): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    const state = this.getState();
    await redis.set('feed:state', JSON.stringify({ atServerMs: timeService.now(), state }), 'EX', 30).catch(() => undefined);
  }

  static async readStateFromRedis(): Promise<{ atServerMs: number; state: DataSourceState } | null> {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get('feed:state').catch(() => null);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  resubscribe(symbols: string[]): void {
    const canon = symbols.map(canonicalSymbol);
    if (canon.length === this.symbolList.length && canon.every((s, i) => s === this.symbolList[i])) return;
    this.symbolList = canon;
    if (!this.started || !this.handlers) return;
    // mutate live provider symbol lists where supported, then reconnect active providers
    const activeSids = new Set(Object.values(this.active) as FeedSourceId[]);
    for (const sid of activeSids) {
      const p = this.providers[sid] as (FeedProvider & { resubscribeSymbols?: (s: string[]) => void }) | undefined;
      if (p?.resubscribeSymbols) {
        try { p.resubscribeSymbols(canon); continue; } catch {}
      }
      // fallback — stop then restart provider with new symbol list
      try {
        p?.stop();
        this.updateMetric('depth', sid, { stale: true });
        this.updateMetric('trade', sid, { stale: true });
        p?.start(canon, this.handlers!);
        this.updateMetric('depth', sid, { connected: true, stale: false });
        this.updateMetric('trade', sid, { connected: true, stale: false });
      } catch (e) {
        this.updateMetric('depth', sid, { connected: false, lastError: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  symbols(): string[] { return [...this.symbolList]; }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = undefined;
    for (const p of Object.values(this.providers)) p?.stop();
    this.started = false;
  }

  getState(): DataSourceState {
    const depth: Record<string, SourceMetrics> = {};
    const trade: Record<string, SourceMetrics> = {};
    for (const sid of FALLBACK_ORDER) {
      depth[sid] = this.getMetric('depth', sid);
      trade[sid] = this.getMetric('trade', sid);
    }
    return { depth, trade, active: { ...this.active }, watchlist: [...this.symbolList] };
  }

  activeSource(kind: FeedKind): FeedSourceId | null {
    return this.active[kind] ?? null;
  }

  private startActiveProviders(): void {
    const startedKinds = new Set<FeedSourceId>();
    for (const kind of Object.keys(this.active) as FeedKind[]) {
      const sid = this.active[kind]!;
      if (startedKinds.has(sid)) continue;
      startedKinds.add(sid);
      const provider = this.providers[sid];
      if (!provider) continue;
      const onDepth: ListenerD = (d) => {
        if (this.active['depth'] !== sid) return;
        this.recordTick('depth', sid);
        this.handlers?.onDepth({ ...d, venue: 'BINANCE_SPOT' });
      };
      const onTrade: ListenerT = (t) => {
        if (this.active['trade'] !== sid) return;
        this.recordTick('trade', sid);
        this.handlers?.onTrade({ ...t, venue: 'BINANCE_SPOT' });
      };
      try {
        provider.start(this.symbolList, { onDepth, onTrade });
        this.updateMetric('depth', sid, { connected: true, lastError: null });
        this.updateMetric('trade', sid, { connected: true, lastError: null });
      } catch (e) {
        this.updateMetric('depth', sid, { connected: false, lastError: e instanceof Error ? e.message : String(e) });
        this.tryFallback('depth');
        this.tryFallback('trade');
      }
    }
  }

  private recordTick(kind: FeedKind, sid: FeedSourceId): void {
    const key = `${kind}:${sid}`;
    this.msgCount.set(key, (this.msgCount.get(key) ?? 0) + 1);
    this.updateMetric(kind, sid, { lastTickMs: timeService.now(), stale: false });
  }

  private getMetric(kind: FeedKind, sid: FeedSourceId): SourceMetrics {
    const key = `${kind}:${sid}`;
    return this.metrics.get(key) ?? { source: sid, connected: false, lastTickMs: null, stale: true, msgPerSec: 0, lastError: null };
  }

  private updateMetric(kind: FeedKind, sid: FeedSourceId, patch: Partial<SourceMetrics>): void {
    const key = `${kind}:${sid}`;
    const prev = this.getMetric(kind, sid);
    this.metrics.set(key, { ...prev, ...patch });
  }

  private isStaleMetric(m: SourceMetrics): boolean {
    if (m.lastTickMs === null) return true;
    return timeService.now() - m.lastTickMs > RISK_CONSTANTS.STALENESS_LIMIT_MS * 4;
  }

  private checkStaleness(): void {
    for (const kind of ['depth', 'trade'] as FeedKind[]) {
      const cur = this.active[kind];
      if (!cur) continue;
      const metric = this.getMetric(kind, cur);
      if (this.isStaleMetric(metric)) {
        this.updateMetric(kind, cur, { stale: true, connected: false });
        this.tryFallback(kind);
      }
      for (const sid of FALLBACK_ORDER) {
        const mm = this.getMetric(kind, sid);
        const count = this.msgCount.get(`${kind}:${sid}`) ?? 0;
        this.updateMetric(kind, sid, { msgPerSec: Math.round(count / 10) });
        this.msgCount.set(`${kind}:${sid}`, 0);
        void mm;
      }
    }
  }

  private tryFallback(kind: FeedKind): void {
    if (timeService.now() - this.lastSwitchAt < this.switchCooldownMs) return;
    const current = this.active[kind];
    const curIdx = current ? FALLBACK_ORDER.indexOf(current) : -1;
    for (let i = curIdx + 1; i < FALLBACK_ORDER.length; i++) {
      const next = FALLBACK_ORDER[i]!;
      if (!this.providers[next]) continue;
      const prev = this.active[kind];
      this.active[kind] = next;
      this.lastSwitchAt = timeService.now();
      agentEvents.publish('SOURCE_SWITCHED', { kind, from: prev ?? null, to: next, atServerMs: timeService.now() });
      this.restartForKind(kind);
      return;
    }
    const activeVals = Object.values(this.active) as FeedSourceId[];
    const fallbackSid = activeVals.find((s) => s !== current);
    if (fallbackSid) {
      const prev = this.active[kind];
      this.active[kind] = fallbackSid;
      this.lastSwitchAt = timeService.now();
      agentEvents.publish('SOURCE_SWITCHED', { kind, from: prev ?? null, to: fallbackSid, atServerMs: timeService.now() });
      this.restartForKind(kind);
    }
  }

  private restartForKind(_kind: FeedKind): void {
    const activeSids = new Set(Object.values(this.active) as FeedSourceId[]);
    for (const [sid, p] of Object.entries(this.providers) as [FeedSourceId, FeedProvider][]) {
      if (activeSids.has(sid)) continue;
      p.stop();
    }
    this.startActiveProviders();
  }
  notifyError(sid: FeedSourceId, kind: FeedKind, err: string): void {
    this.updateMetric(kind, sid, { lastError: err, connected: false, stale: true });
    if (this.active[kind] === sid) this.tryFallback(kind);
  }
}
