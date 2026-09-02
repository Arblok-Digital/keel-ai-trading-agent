import WebSocket from 'ws';
import type { NormalizedDepth, NormalizedTrade } from '../../types/exchange.js';
import { isTickFresh } from './staleness-gate.js';

interface DepthMessage {
  stream?: string;
  data?: {
    bids?: [string, string][];
    asks?: [string, string][];
    E?: number;
  };
}

interface TradeMessage {
  stream?: string;
  data?: {
    p?: string;
    q?: string;
    T?: number;
    m?: boolean;
  };
}

export class BinanceCexStream {
  private ws: WebSocket | undefined;
  private symbols: string[];
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempts = 0;

  constructor(
    symbols: string[],
    private readonly handlers: {
      onDepth?: (depth: NormalizedDepth) => void;
      onTrade?: (trade: NormalizedTrade) => void;
    },
    private readonly baseUrl: string = 'wss://stream.binance.com:9443',
  ) {
    this.symbols = symbols.map((s) => s.toLowerCase());
  }

  resubscribeSymbols(symbols: string[]): void {
    const canon = symbols.map((s) => s.toLowerCase());
    if (canon.length === this.symbols.length && canon.every((s, i) => s === this.symbols[i])) return;
    this.symbols = canon;
    this.reconnectAttempts = 0;
    try { this.ws?.terminate(); this.ws?.close(); } catch {}
    this.ws = undefined;
    this.stopPing();
    this.start();
  }

  start(): void {
    if (this.ws) return;
    const streams = this.symbols.flatMap((s) => [`${s}@depth20@100ms`, `${s}@trade`]).join('/');
    const ws = new WebSocket(`${this.baseUrl}/stream?streams=${streams}`);
    ws.on('open', () => {
      this.reconnectAttempts = 0;
      console.log(`[cex-stream] connected (${this.symbols.join(',')})`);
      this.startPing();
    });
    ws.on('message', (raw) => { try { this.handleMessage(String(raw)); } catch (err) { console.error('[cex-stream] handler crash', err instanceof Error ? err.message : err); } });
    ws.on('close', () => {
      this.stopPing();
      this.ws = undefined;
      const delay = Math.min(30_000, 2_000 * 2 ** this.reconnectAttempts);
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => this.start(), delay);
      this.reconnectTimer.unref?.();
    });
    ws.on('error', (err) => console.error('[cex-stream] error:', err.message));
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

  private isAlive = true;

  private startPing(): void {
    this.isAlive = true;
    this.ws?.on('pong', () => {
      this.isAlive = true;
    });
    this.pingTimer = setInterval(() => {
      if (!this.ws) return;
      if (this.isAlive === false) {
        this.ws.terminate();
        return;
      }
      this.isAlive = false;
      this.ws.ping();
    }, 30_000);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private handleMessage(raw: string): void {
    let parsed: DepthMessage & TradeMessage;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const stream = parsed.stream ?? '';
    const symbol = stream.split('@')[0]?.toUpperCase() ?? '';
    if (stream.includes('@depth')) {
      const data = parsed.data;
      if (!data?.bids || !data.asks || data.E === undefined) return;
      if (!isTickFresh(symbol, 'BINANCE_SPOT', data.E)) return;
      this.handlers.onDepth?.({
        symbol,
        venue: 'BINANCE_SPOT',
        bids: data.bids.map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
        asks: data.asks.map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
        tsServerMs: data.E,
      });
    } else if (stream.includes('@trade')) {
      const data = parsed.data;
      if (!data?.p || !data.q || data.T === undefined) return;
      if (!isTickFresh(symbol, 'BINANCE_SPOT', data.T)) return;
      const price = Number(data.p);
      const qty = Number(data.q);
      this.handlers.onTrade?.({
        symbol,
        venue: 'BINANCE_SPOT',
        price,
        qty,
        notionalUsd: price * qty,
        isBuyerMaker: Boolean(data.m),
        tsServerMs: data.T,
      });
    }
  }
}
