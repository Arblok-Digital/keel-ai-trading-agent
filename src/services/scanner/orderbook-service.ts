// Real orderbook analytics — supports 2 strategies: SCALP (15s micro) vs SWING (H4 ATR, ML filtered).
// Sources: Gate.io spot public REST: order_book + candlesticks (ATR).
import { timeService } from '../ingestion/time-sync.js';
import type { TradingStrategy } from '../../config/algo-config.js';
import { ALGO_CONFIG, isScalpCfg } from '../../config/algo-config.js';

export interface OBLevel { price: number; qty: number }

export interface GateOrderBookResponse {
  bids: string[][];
  asks: string[][];
}

export interface GateCandle {
  ts: string;
  volume: string;
  close: string;
  high: string;
  low: string;
  open: string;
}

export type GateCandlestickResponse = GateCandle[] | { message?: string; label?: string };

export interface OrderbookAnalysis {
  symbol: string;              // e.g. BTC_USDT (Gate format)
  ts: number;
  bestBid: number; bestAsk: number; mid: number; spreadPct: number;
  bidDepth1pctUsd: number; askDepth1pctUsd: number; // notional within ±1% of mid
  imbalance: number;           // >1 = bid-heavy (accumulation pressure)
  bidWall: OBLevel | null; askWall: OBLevel | null; // largest resting orders
  atr1h: number | null;        // Average True Range (14) on 1h candles
  plan: {
    side: 'BUY' | 'SELL' | 'NONE';
    entry: number;
    stop: number;              // absolute price
    target: number;            // absolute price
    stopPct: number;           // % from entry (positive number)
    tpPct: number;
    sizePct: number;           // risk-based: 0.5% equity risk / stopPct, clamped 2..5
    reason: string;            // human-readable derivation
  };
}

const GATE = 'https://api.gateio.ws/api/v4';

function notionalWithin(levels: OBLevel[], mid: number, bandPct = 0.01): number {
  return levels
    .filter(l => Math.abs(l.price - mid) / mid <= bandPct)
    .reduce((s, l) => s + l.price * l.qty, 0);
}

function largestLevel(levels: OBLevel[]): OBLevel | null {
  if (!levels.length) return null;
  return levels.reduce((a, b) => (a.price * a.qty >= b.price * b.qty ? a : b));
}

function atrFromCandles(candles: GateCandle[]): number | null {
  // Gate candlestick: {ts, volume, close, high, low, open}
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (!cur || !prev) continue;
    const h = Number(cur.high);
    const l = Number(cur.low);
    const prevClose = Number(prev.close);
    if (!h || !l || !prevClose) continue;
    trs.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  if (trs.length < 5) return null;
  const atr = trs.slice(-14).reduce((s, t) => s + t, 0) / Math.min(14, trs.length);
  return atr > 0 ? atr : null;
}

function parseLevels(levels: string[][] | undefined): OBLevel[] {
  if (!Array.isArray(levels) || levels.length === 0) return [];
  return levels
    .filter((row) => Array.isArray(row) && row.length >= 2)
    .map((row) => ({ price: Number(row[0]), qty: Number(row[1]) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.qty));
}

const obCache = new Map<string, { at: number; data: OrderbookAnalysis }>();
const OB_TTL_MS = 15_000;
const OB_MAX_STALE_MS = 6_000; // if no fresh tick in 6s, orderbook dianggap mati -> jangan trading

export async function analyzeOrderbook(pair: string, strategy: TradingStrategy = 'SCALP'): Promise<OrderbookAnalysis | null> {
  // STALENESS GUARD: if last successful fetch was too long ago, return null so caller skips the trade
  const cachedAt = obCache.get(pair)?.at ?? 0;
  if (cachedAt && timeService.now() - cachedAt > OB_MAX_STALE_MS && !obCache.has(pair)) {
    return null;
  }
  const cached = obCache.get(pair);
  if (cached && timeService.now() - cached.at < OB_TTL_MS) return cached.data;
  try {
    const [obJson, cdJson] = await Promise.all([
      fetch(`${GATE}/spot/order_book?currency_pair=${pair}&limit=50`).then((r) => r.json() as Promise<GateOrderBookResponse>),
      fetch(`${GATE}/spot/candlesticks?currency_pair=${pair}&interval=1h&limit=20`)
        .then((r) => r.json() as Promise<GateCandlestickResponse>)
        .catch(() => null),
    ]);
    const bids: OBLevel[] = parseLevels(obJson?.bids);
    const asks: OBLevel[] = parseLevels(obJson?.asks);
    if (!bids.length || !asks.length) return null;
    const bestBid = bids[0]!.price;
    const bestAsk = asks[0]!.price;
    const mid = (bestBid + bestAsk) / 2;
    const spreadPct = ((bestAsk - bestBid) / mid) * 100;
    const bidDepth1pctUsd = notionalWithin(bids, mid);
    const askDepth1pctUsd = notionalWithin(asks, mid);
    const imbalance = askDepth1pctUsd > 0 ? bidDepth1pctUsd / askDepth1pctUsd : 1;
    const bidWall = largestLevel(bids), askWall = largestLevel(asks);
    const atr1h = Array.isArray(cdJson) ? atrFromCandles(cdJson) : null;

    // ---- decision plan: SCALP uses tight micro walls; SWING uses H4 ATR wide levels ----
    const scalp = ALGO_CONFIG.SCALP as import('../../config/algo-config.js').ScalpConfig;
    const swing = ALGO_CONFIG.SWING as import('../../config/algo-config.js').SwingConfig;
    const cfg = isScalpCfg(ALGO_CONFIG[strategy]) ? scalp : swing;
    const imbBuy = (cfg as unknown as { imbalanceBuy?: number }).imbalanceBuy ?? 1.15;
    const imbSell = (cfg as unknown as { imbalanceSell?: number }).imbalanceSell ?? 0.85;
    const side: 'BUY' | 'SELL' | 'NONE' = imbalance >= imbBuy ? 'BUY' : imbalance <= imbSell ? 'SELL' : 'NONE';
    const entry = mid;
    let stop: number, target: number, reason: string;
    const atrFallback = strategy === 'SWING' ? mid * 0.012 : mid * 0.004; // swing wider
    const atrTpMult = strategy === 'SWING' ? 2.0 : 1.5;
    const atrBase = atr1h ?? atrFallback;
    if (side === 'BUY') {
      const wall = bidWall ? bidWall.price : bestBid;
      stop = Math.min(wall * 0.9985, bestBid * (1 - Math.max(0.0015, atrBase / mid * 0.75)));
      const askWallP = askWall && askWall.price > entry * (strategy==='SWING'?1.012:1.004) ? askWall.price : null;
      target = askWallP ?? entry + atrTpMult * atrBase;
      reason = `[${strategy}] imbalance ${imbalance.toFixed(2)} bid-heavy; SL below bid wall ${bidWall ? bidWall.price.toPrecision(6) : 'best bid'}; TP ${askWallP ? 'at ask wall' : atrTpMult+'×ATR'+(atr1h?'':'*')}`;
    } else if (side === 'SELL') {
      const wall = askWall ? askWall.price : bestAsk;
      stop = Math.max(wall * 1.0015, bestAsk * (1 + Math.max(0.0015, atrBase / mid * 0.75)));
      const bidWallP = bidWall && bidWall.price < entry * (strategy==='SWING'?0.988:0.996) ? bidWall.price : null;
      target = bidWallP ?? entry - atrTpMult * atrBase;
      reason = `[${strategy}] imbalance ${imbalance.toFixed(2)} ask-heavy; SL above ask wall; TP ${bidWallP ? 'at bid wall' : atrTpMult+'×ATR'+(atr1h?'':'*')}`;
    } else {
      stop = entry - 1.2 * atrBase;
      target = entry + atrTpMult * atrBase;
      reason = `[${strategy}] imbalance neutral ${imbalance.toFixed(2)} — no edge, plan ref only (${atr1h?'ATR':'fallback'} ${atrBase.toFixed(2)})`;
    }
    const stopPct = Math.abs((entry - stop) / entry) * 100;
    const tpPct = Math.abs((target - entry) / entry) * 100;
    const riskPct = (cfg as unknown as { riskPct?: number }).riskPct ?? 0.5;
    const rawSize = (riskPct / Math.max(0.3, stopPct)) * 100;
    const sizePct = Math.max(2, Math.min(5, Number(rawSize.toFixed(1))));

    const data: OrderbookAnalysis = {
      symbol: pair, ts: timeService.now(),
      bestBid, bestAsk, mid, spreadPct,
      bidDepth1pctUsd, askDepth1pctUsd, imbalance,
      bidWall, askWall, atr1h,
      plan: { side, entry, stop, target, stopPct: Number(stopPct.toFixed(2)), tpPct: Number(tpPct.toFixed(2)), sizePct, reason },
    };
    obCache.set(pair, { at: timeService.now(), data });
    return data;
  } catch {
    return null;
  }
}

export function toGatePair(symbol: string): string {
  // BTCUSDT -> BTC_USDT ; SOL/USDC -> SOL_USDC
  const s = symbol.replace('/', '');
  if (s.endsWith('USDT')) return s.slice(0, -4) + '_USDT';
  if (s.endsWith('USDC')) return s.slice(0, -4) + '_USDC';
  return s;
}
