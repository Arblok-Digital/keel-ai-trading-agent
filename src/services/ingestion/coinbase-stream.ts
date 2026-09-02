import WebSocket from 'ws';
import type { NormalizedDepth, NormalizedTrade } from '../../types/exchange.js';
import { isTickFresh } from './staleness-gate.js';
import { toCoinbaseSymbol } from './feed-manager.js';

export class CoinbaseStream {
  readonly id = 'COINBASE' as const;
  private ws: WebSocket | undefined;
  private symbols: string[] = [];
  private handlers: { onDepth: (d: NormalizedDepth) => void; onTrade: (t: NormalizedTrade) => void } | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private isAlive = true;

  resubscribeSymbols(symbols: string[]): void {
    const canon = symbols.map(toCoinbaseSymbol);
    if (canon.length === this.symbols.length && canon.every((s, i) => s === this.symbols[i])) return;
    this.symbols = canon;
    this.reconnectAttempts = 0;
    try { this.ws?.terminate(); this.ws?.close(); } catch {}
    this.ws = undefined;
    this.stopPing();
    if (this.handlers) this.start(this.symbols.map((s) => s.replace('-USD', 'USDT')), this.handlers);
  }

  start(symbols: string[], handlers: { onDepth: (d: NormalizedDepth) => void; onTrade: (t: NormalizedTrade) => void }): void {
    if (this.ws) return;
    this.symbols = symbols.map(toCoinbaseSymbol);
    this.handlers = handlers;
    const url = 'wss://advanced-trade-ws.coinbase.com';
    const ws = new WebSocket(url);
    ws.on('open', () => {
      this.reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: this.symbols, channel: 'level2' }));
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: this.symbols, channel: 'market_trades' }));
      this.startPing();
    });
    ws.on('pong', () => { this.isAlive = true; });
    ws.on('message', (raw) => { try { this.handleMessage(String(raw)); } catch (err) { console.error('[coinbase-stream] handler crash', err instanceof Error ? err.message : err); } });
    ws.on('close', () => this.scheduleReconnect());
    ws.on('error', (err) => { console.error('[coinbase-stream] error', err.message); this.scheduleReconnect(); });
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
    this.reconnectTimer = setTimeout(() => { if (this.handlers) this.start(this.symbols.map((s) => s.replace('-USD', 'USDT')), this.handlers); }, delay);
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
    let msg: { channel?: string; product_id?: string; events?: unknown[]; timestamp?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    const pid = msg.product_id ?? '';
    if (!pid) return;
    const symbol = pid.replace('-USD', 'USDT').toUpperCase();
    const ts = msg.timestamp ? Date.parse(msg.timestamp) : Date.now();
    if (msg.channel === 'level2' || msg.channel === 'l2_data') {
      const ev = (msg as { events?: Array<{ updates?: Array<{ side?: string; price_level?: string; new_quantity?: string }> }> }).events?.[0];
      if (!ev?.updates) return;
      const bids: Array<{ price: number; qty: number }> = [];
      const asks: Array<{ price: number; qty: number }> = [];
      for (const u of ev.updates) {
        const p = Number(u.price_level ?? 0); const q = Number(u.new_quantity ?? 0);
        if (!p) continue;
        if (u.side === 'bid') { if (q > 0) bids.push({ price: p, qty: q }); }
        else if (u.side === 'offer' || u.side === 'ask') { if (q > 0) asks.push({ price: p, qty: q }); }
      }
      if (bids.length === 0 && asks.length === 0) return;
      if (!isTickFresh(symbol, 'BINANCE_SPOT', ts)) return;
      bids.sort((a, b) => b.price - a.price); asks.sort((a, b) => a.price - b.price);
      this.handlers?.onDepth({ symbol, venue: 'BINANCE_SPOT', bids, asks, tsServerMs: ts });
    } else if (msg.channel === 'market_trades' || msg.channel === 'ticker') {
      const ev = (msg as { events?: Array<{ trades?: Array<{ price?: string; size?: string; time?: string }> }> }).events?.[0];
      const trades = ev?.trades ?? [];
      for (const t of trades) {
        const price = Number(t.price ?? 0); const qty = Number(t.size ?? 0);
        const t2 = t.time ? Date.parse(t.time) : ts;
        if (!price || !qty) continue;
        if (!isTickFresh(symbol, 'BINANCE_SPOT', t2)) continue;
        this.handlers?.onTrade({ symbol, venue: 'BINANCE_SPOT', price, qty, notionalUsd: price * qty, isBuyerMaker: false, tsServerMs: t2 });
      }
    }
  }
}
