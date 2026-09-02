import WebSocket from 'ws';
import type { NormalizedDepth, NormalizedTrade } from '../../types/exchange.js';
import { isTickFresh } from './staleness-gate.js';
import { toGateSymbol } from './feed-manager.js';
import { timeService } from './time-sync.js';

export class GateStream {
  readonly id = 'GATE' as const;
  private ws: WebSocket | undefined;
  private symbols: string[] = [];
  private handlers: { onDepth: (d: NormalizedDepth) => void; onTrade: (t: NormalizedTrade) => void } | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private isAlive = true;

  resubscribeSymbols(symbols: string[]): void {
    const canon = symbols.map(toGateSymbol);
    if (canon.length === this.symbols.length && canon.every((s, i) => s === this.symbols[i])) return;
    this.symbols = canon;
    if (!this.handlers || !this.ws) { this.symbols = canon; return; }
    this.reconnectAttempts = 0;
    try { this.ws.terminate(); this.ws.close(); } catch {}
    this.ws = undefined;
    this.stopPing();
    if (this.handlers) this.start(this.symbols.map((s) => s.replace('_', '')), this.handlers);
  }

  start(symbols: string[], handlers: { onDepth: (d: NormalizedDepth) => void; onTrade: (t: NormalizedTrade) => void }): void {
    if (this.ws) return;
    this.symbols = symbols.map(toGateSymbol);
    this.handlers = handlers;
    const url = 'wss://api.gateio.ws/ws/v4/';
    const ws = new WebSocket(url);
    ws.on('open', () => {
      this.reconnectAttempts = 0;
      const ts = Math.floor(timeService.now() / 1000);
      for (const s of this.symbols) {
        ws.send(JSON.stringify({ time: ts, channel: 'spot.order_book', event: 'subscribe', payload: [s, '20', '1s'] }));
        ws.send(JSON.stringify({ time: ts, channel: 'spot.trades', event: 'subscribe', payload: [s] }));
      }
      this.startPing();
    });
    ws.on('pong', () => { this.isAlive = true; });
    ws.on('message', (raw) => {
      try { this.handleMessage(String(raw)); } catch (err) { console.error('[gate-stream] handler crash', err instanceof Error ? err.message : err); }
    });
    ws.on('close', () => this.scheduleReconnect());
    ws.on('error', (err) => { console.error('[gate-stream] error', err.message); this.scheduleReconnect(); });
    this.ws = ws;
  }
  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopPing();
    this.ws?.terminate?.();
    this.ws?.close();
    this.ws = undefined;
  }
  private scheduleReconnect(): void {
    this.stopPing(); this.ws = undefined;
    const delay = Math.min(30_000, 2_000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => { if (this.handlers) this.start(this.symbols.map((s) => s.replace('_', '')), this.handlers); }, delay);
    this.reconnectTimer.unref?.();
  }
  private startPing(): void {
    this.isAlive = true;
    this.pingTimer = setInterval(() => {
      if (!this.ws) return;
      if (!this.isAlive) { this.ws.terminate(); return; }
      this.isAlive = false;
      this.ws.ping();
    }, 30_000);
    this.pingTimer.unref?.();
  }
  private stopPing(): void { if (this.pingTimer) clearInterval(this.pingTimer); this.pingTimer = undefined; }
  private handleMessage(raw: string): void {
    let msg: { channel?: string; event?: string; result?: unknown; time?: number; payload?: unknown };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.event === 'subscribe' || msg.event === 'unsubscribe') return;
    const ch = msg.channel ?? '';
    const tsMs = (msg.time ?? Math.floor(timeService.now() / 1000)) * 1000;
    if (ch === 'spot.order_book') {
      const data = msg.result as { s?: string; bids?: string | [string, string][] | Array<{ p?: string; s?: string }> ; asks?: string | [string, string][] } | undefined;
      if (!data?.s) return;
      const symbol = data.s.replace('_', '').toUpperCase();
      const parseSide = (raw2?: string | [string, string][] | Array<unknown>): Array<{ price: number; qty: number }> => {
        if (!raw2) return [];
        if (Array.isArray(raw2)) {
          return (raw2 as [string, string][]).map(([p, q]) => ({ price: Number(p), qty: Number(q) })).filter((x) => x.price > 0 && x.qty >= 0);
        }
        return (raw2 as string).split(',').filter(Boolean).map((pair) => {
          const [p, q] = pair.split('_');
          return { price: Number(p), qty: Number(q) };
        }).filter((x) => x.price > 0 && x.qty >= 0);
      };
      const bids = parseSide(data.bids);
      const asks = parseSide(data.asks);
      if (bids.length === 0 && asks.length === 0) return;
      if (!isTickFresh(symbol, 'BINANCE_SPOT', tsMs, 3000)) return;
      this.handlers?.onDepth({ symbol, venue: 'BINANCE_SPOT', bids, asks, tsServerMs: tsMs });
    } else if (ch === 'spot.trades') {
      const data = msg.result as { s?: string; trades?: Array<{ p?: string; v?: string; t?: number; id?: number }> } | undefined;
      if (!data?.s) return;
      const symbol = data.s.replace('_', '').toUpperCase();
      const trades = data.trades ?? [];
      for (const t of trades) {
        const price = Number(t.p ?? 0); const qty = Number(t.v ?? 0);
        const ts2 = t.t ? t.t * 1000 : tsMs;
        if (!price || !qty) continue;
        if (!isTickFresh(symbol, 'BINANCE_SPOT', ts2, 3000)) continue;
        this.handlers?.onTrade({ symbol, venue: 'BINANCE_SPOT', price, qty, notionalUsd: price * qty, isBuyerMaker: false, tsServerMs: ts2 });
      }
    }
  }
}
