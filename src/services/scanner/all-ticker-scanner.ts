import ccxt from 'ccxt';
import { analyzeOrderbook, toGatePair } from './orderbook-service.js';
export type { OrderbookAnalysis } from './orderbook-service.js';
// MM early detection for daily/swing — akumulasi dini sebelum pump
// Score 0-100: volume naik tapi price belum, liquidity tipis, bid/ask imbalance

export type EarlyCandidate = {
  symbol: string;
  venue: string;
  price: number;
  change24hPct: number;
  volumeUsd24h: number;
  bid: number | null;
  ask: number | null;
  score: number;
  flow: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL';
  liquidityUsd: number;
  narrativeVelocity: number;
  mtfAlignment: boolean;
  ob?: {
    imbalance: number;
    bidWall: { price: number; qty: number } | null;
    askWall: { price: number; qty: number } | null;
    bidDepth1pctUsd: number;
    askDepth1pctUsd: number;
    atr1h: number | null;
    spreadPct: number;
    plan: {
      side: 'BUY' | 'SELL' | 'NONE';
      entry: number;
      stop: number;
      target: number;
      stopPct: number;
      tpPct: number;
      sizePct: number;
      reason: string;
    };
  };
};

interface Ticker {
  symbol: string;
  last: number;
  percentage: number;
  quoteVolume: number;
  bid: number | null;
  ask: number | null;
}

type TickerMap = Record<string, Ticker>;
type Flow = EarlyCandidate['flow'];

const COMPASS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDC', 'PEPE/USDT', 'BNB/USDT'];

function computeScore(t: { price: number; change: number; volume: number }, volMedian: number): { score: number; flow: Flow } {
  const volSpike = t.volume / Math.max(1, volMedian);
  // majors (BTC/ETH) volume gede tiap hari = jangan dianggap spike
  const isMajor = t.volume > 5_000_000_000;
  let volScore = Math.min(22, Math.max(-8, (Math.log10(Math.max(0.5, volSpike)) * 14)));
  if (isMajor) volScore *= 0.35; // BTC 36B / 0.8M = 45k spike tapi itu normal buat BTC
  const changeAbs = Math.abs(t.change);
  const stealth = t.change >= -0.8 && t.change <= 2.2 && volSpike > 1.7 ? 18 : changeAbs < 1.2 && volSpike > 1.35 ? 10 : changeAbs > 5.5 ? -16 : -2;
  const damp = t.change < -3.5 ? -10 : 0;
  let score = Math.round(44 + volScore + stealth + damp);
  score = Math.max(18, Math.min(89, score));
  let flow: Flow = 'NEUTRAL';
  if (score >= 66 && t.change >= -1.2 && volSpike > 1.4) flow = 'ACCUMULATION';
  else if (t.change < -3.8 || score < 36) flow = 'DISTRIBUTION';
  return { score, flow };
}

interface BybitTickersResponse {
  result?: { list?: Array<Record<string, string>> };
}

interface RawTicker {
  last?: number;
  percentage?: number;
  quoteVolume?: number;
  bid?: number;
  ask?: number;
}

function normalizeBybitFromItself(tickers: Record<string, RawTicker>): TickerMap {
  const out: TickerMap = {};
  for (const [k, v] of Object.entries(tickers)) {
    if (k.includes('/') && (k.endsWith('/USDT') || k.endsWith('/USDC')) && !k.includes(':')) {
      out[k] = {
        symbol: k,
        last: Number(v.last ?? 0),
        percentage: Number(v.percentage ?? 0),
        quoteVolume: Number(v.quoteVolume ?? 0),
        bid: v.bid != null ? Number(v.bid) : null,
        ask: v.ask != null ? Number(v.ask) : null,
      };
    }
  }
  return out;
}

function normalizeBybitRest(): Promise<TickerMap> {
  return fetch('https://api.bybit.com/v5/market/tickers?category=spot')
    .then((r) => r.json() as Promise<BybitTickersResponse>)
    .then((j) => {
      const map: TickerMap = {};
      const list = j?.result?.list ?? [];
      for (const it of list) {
        const sym: string = it.symbol ?? ''; // BTCUSDT
        if (!sym.endsWith('USDT') && !sym.endsWith('USDC')) continue;
        const norm = sym.replace('USDT', '/USDT').replace('USDC', '/USDC');
        map[norm] = {
          symbol: norm,
          last: Number(it.lastPrice ?? 0),
          percentage: Number(it.price24hPcnt ?? 0) * 100,
          quoteVolume: Number(it.volume24h ?? 0) * Number(it.lastPrice ?? 0),
          bid: Number(it.bid1Price) || null,
          ask: Number(it.ask1Price) || null,
        };
      }
      return map;
    });
}

interface GateTicker {
  currency_pair?: string;
  last?: string;
  change_percentage?: string;
  quote_volume?: string;
  highest_bid?: string;
  lowest_ask?: string;
}

interface CoinGeckoCoin {
  symbol?: string;
  current_price?: number;
  price_change_percentage_24h?: number;
  total_volume?: number;
}

function loadFromBybit(): Promise<TickerMap> {
  type BybitLike = { loadMarkets(): Promise<unknown>; fetchTickers(): Promise<Record<string, RawTicker>> };
  const BybitKlass = (ccxt as unknown as { bybit: new (opts: object) => BybitLike }).bybit;
  const instance = new BybitKlass({ enableRateLimit: true, timeout: 8000 });
  return instance
    .loadMarkets()
    .catch(() => undefined)
    .then(() => instance.fetchTickers())
    .then((tickers) => normalizeBybitFromItself(tickers));
}

export async function fetchAllEarlyCandidates(limit = 20): Promise<{ compass: EarlyCandidate[]; top: EarlyCandidate[]; allCount: number }> {
  let tickers: TickerMap = {};
  let venue = 'BYBIT_SPOT';

  try {
    tickers = await loadFromBybit();
  } catch {
    try {
      tickers = await normalizeBybitRest();
    } catch {
      tickers = {};
    }
  }
  if (Object.keys(tickers).length === 0) {
    try {
      const res = await fetch('https://api.gateio.ws/api/v4/spot/tickers');
      const list = (await res.json()) as GateTicker[];
      const gateMap: TickerMap = {};
      for (const it of list) {
        const sym: string = it.currency_pair ?? ''; // NMR_USDT
        if (!sym.endsWith('_USDT') && !sym.endsWith('_USDC')) continue;
        const norm = sym.replace('_', '/');
        gateMap[norm] = {
          symbol: norm,
          last: Number(it.last ?? 0),
          percentage: Number(it.change_percentage ?? 0),
          quoteVolume: Number(it.quote_volume ?? 0),
          bid: Number(it.highest_bid) || null,
          ask: Number(it.lowest_ask) || null,
        };
      }
      if (Object.keys(gateMap).length) {
        tickers = gateMap;
        venue = 'GATE_SPOT';
      }
    } catch {}
  }
  if (Object.keys(tickers).length === 0) {
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h');
      const list = (await res.json()) as CoinGeckoCoin[];
      const cgMap: TickerMap = {};
      for (const it of list) {
        const sym = (it.symbol ?? '').toUpperCase() + '/USDT';
        cgMap[sym] = {
          symbol: sym,
          last: Number(it.current_price ?? 0),
          percentage: Number(it.price_change_percentage_24h ?? 0),
          quoteVolume: Number(it.total_volume ?? 0),
          bid: null,
          ask: null,
        };
      }
      tickers = cgMap;
      venue = 'COINGECKO';
    } catch {}
  }

  const STABLE = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'USDE', 'TUSD', 'USDD', 'PYUSD']);
  const vols = Object.values(tickers)
    .map((t) => Number(t.quoteVolume))
    .filter((v) => v > 300_000)
    .sort((a, b) => a - b);
  const volMedian = vols.length ? (vols[Math.floor(vols.length / 2)] ?? 800_000) : 800_000;
  const all: EarlyCandidate[] = [];
  for (const [sym, t] of Object.entries(tickers)) {
    const base = (sym.split('/')[0] ?? '');
    if (STABLE.has(base)) continue;
    if (['USD1', 'USDG', 'USDX'].includes(base)) continue;
    const price = Number(t.last);
    if (!price || price <= 0) continue;
    const vol = Number(t.quoteVolume);
    if (vol < 300_000) continue;
    const change = Number(t.percentage);
    const { score, flow } = computeScore({ price, change, volume: vol }, volMedian);
    all.push({
      symbol: sym.replace('/USDT', 'USDT').replace('/USDC', '/USDC'),
      venue,
      price,
      change24hPct: change,
      volumeUsd24h: vol,
      bid: t.bid,
      ask: t.ask,
      score,
      flow,
      liquidityUsd: vol * 0.8, // provisional — overwritten by orderbook real depth for enriched top-N below
      narrativeVelocity: Number(change.toFixed(1)), // provisional — overwritten when multisource trade velocity available
      mtfAlignment: false, // provisional — overwritten for enriched symbols when real MTF engine available
    });
  }

  all.sort((a, b) => b.score - a.score);

  const enrichN = Math.min(10, Math.max(limit, 5));
  // strategy wiring: SCALP uses 15s micro books, SWING uses H4-wide ATR levels
  const strategy: import('../../config/algo-config.js').TradingStrategy = (globalThis as unknown as { __keelStrategy?: string }).__keelStrategy === 'SWING' ? 'SWING' : 'SCALP';
  const toEnrich = all.slice(0, enrichN);
  const analyses = await Promise.all(
    toEnrich.map(async (c) => ({ c, ob: await analyzeOrderbook(toGatePair(c.symbol), strategy as never) })),
  );
  for (const { c, ob } of analyses) {
    if (!ob) continue;
    // overwrite provisional scanner metrics with real orderbook analytics
    c.liquidityUsd = Math.round(ob.bidDepth1pctUsd + ob.askDepth1pctUsd);
    c.mtfAlignment = ob.plan.side !== 'NONE';
    c.ob = {
      imbalance: Number(ob.imbalance.toFixed(3)),
      bidWall: ob.bidWall,
      askWall: ob.askWall,
      bidDepth1pctUsd: ob.bidDepth1pctUsd,
      askDepth1pctUsd: ob.askDepth1pctUsd,
      atr1h: ob.atr1h,
      spreadPct: Number(ob.spreadPct.toFixed(3)),
      plan: ob.plan,
    };
    if (ob.plan.side === 'BUY') c.flow = 'ACCUMULATION';
    else if (ob.plan.side === 'SELL') c.flow = 'DISTRIBUTION';
  }
  all.sort((a, b) => b.score - a.score);

  const compass: EarlyCandidate[] = [];
  for (const c of COMPASS) {
    const key = c.replace('/', '').replace('USDT', 'USDT');
    const found = all.find(
      (x) => x.symbol.replace('/', '') === key.replace('/', '') || x.symbol === c.replace('/', '') || x.symbol === c,
    );
    if (found) {
      compass.push(found);
    } else {
      const t = tickers[c];
      if (t) {
        compass.push({
          symbol: c.replace('/', ''),
          venue,
          price: Number(t.last),
          change24hPct: Number(t.percentage),
          volumeUsd24h: Number(t.quoteVolume),
          bid: t.bid,
          ask: t.ask,
          score: 50,
          flow: 'NEUTRAL',
          liquidityUsd: Number(t.quoteVolume) * 0.8,
          narrativeVelocity: 0,
          mtfAlignment: false,
        });
      }
    }
  }

  const top = all.slice(0, limit);
  return { compass, top, allCount: all.length };
}
