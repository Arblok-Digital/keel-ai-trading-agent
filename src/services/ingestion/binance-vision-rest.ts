import { timeService } from './time-sync.js';
import type { NormalizedDepth } from '../../types/exchange.js';
import type { Kline } from './kline-aggregator.js';

const VISION = 'https://data-api.binance.vision';
let useVision = true;

function visionUrl(path: string): string {
  return `${VISION}${path}`;
}

export interface VisionPollHandlers {
  onDepth: (d: NormalizedDepth) => void;
  onKline: (symbol: string, kline: Kline, interval: string) => void;
}

export class BinanceVisionPoller {
  readonly id = 'VISION' as const;
  private timer: ReturnType<typeof setInterval> | undefined;
  private symbols: string[] = [];
  private handlers: VisionPollHandlers | null = null;
  private depthTimer: ReturnType<typeof setInterval> | undefined;
  private klineTimer: ReturnType<typeof setInterval> | undefined;

  start(symbols: string[], handlers: { onDepth: (d: NormalizedDepth) => void; onTrade?: (t: unknown) => void }): void {
    this.symbols = symbols.map((s) => s.toUpperCase());
    if (!this.handlers) this.handlers = { onDepth: handlers.onDepth, onKline: () => {} };
    else this.handlers.onDepth = handlers.onDepth;
    this.startDepthPoll();
    this.startKlinePoll();
  }

  resubscribeSymbols(symbols: string[]): void {
    const canon = symbols.map((s) => s.toUpperCase());
    if (canon.length === this.symbols.length && canon.every((v, i) => v === this.symbols[i])) return;
    this.symbols = canon;
  }

  registerKlineHandler(cb: VisionPollHandlers['onKline']): void {
    if (!this.handlers) this.handlers = { onDepth: () => {}, onKline: cb };
    else {
      const prev = this.handlers.onKline;
      this.handlers.onKline = (s, k, i) => { try { prev(s, k, i); } catch { /* ignore */ } try { cb(s, k, i); } catch { /* ignore */ } };
    }
  }

  stop(): void {
    if (this.depthTimer) clearInterval(this.depthTimer);
    if (this.klineTimer) clearInterval(this.klineTimer);
    this.depthTimer = undefined;
    this.klineTimer = undefined;
  }

  private startDepthPoll(): void {
    const tick = async () => {
      for (const sym of this.symbols) {
        try {
          const res = await fetch(visionUrl(`/api/v3/depth?symbol=${sym}&limit=20`), { signal: AbortSignal.timeout(5000) });
          if (!res.ok) throw new Error(`vision depth ${res.status}`);
          const j = await res.json() as { bids?: [string, string][]; asks?: [string, string][] };
          const now = timeService.now();
          this.handlers?.onDepth({
            symbol: sym,
            venue: 'BINANCE_SPOT',
            bids: (j.bids ?? []).map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
            asks: (j.asks ?? []).map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
            tsServerMs: now,
          });
        } catch (e) {
          if (String(e).includes('blocked') || String(e).includes('403')) useVision = false;
        }
      }
    };
    void tick();
    this.depthTimer = setInterval(tick, 1500);
    this.depthTimer.unref?.();
  }

  private startKlinePoll(): void {
    const intervals: Array<{ iv: string; label: string }> = [
      { iv: '15m', label: 'm15' },
      { iv: '1h', label: 'h1' },
      { iv: '4h', label: 'h4' },
      { iv: '1d', label: 'd1' },
    ];
    const tick = async () => {
      for (const sym of this.symbols) {
        for (const { iv, label } of intervals) {
          try {
            const res = await fetch(visionUrl(`/api/v3/klines?symbol=${sym}&interval=${iv}&limit=100`), { signal: AbortSignal.timeout(5000) });
            if (!res.ok) continue;
            const arr = await res.json() as Array<[number, string, string, string, string, string]>;
            for (const row of arr) {
              const [ot, o, h, l, c, v] = row;
              const k: Kline = { openTime: ot, closeTime: ot + 1, open: Number(o), high: Number(h), low: Number(l), close: Number(c), volume: Number(v), trades: 1 };
              this.handlers?.onKline(sym, k, label);
            }
          } catch { /* ignore */ }
        }
      }
    };
    void tick();
    this.klineTimer = setInterval(tick, 60_000);
    this.klineTimer.unref?.();
  }
}

export function visionAvailable(): boolean { return useVision; }
