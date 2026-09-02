import { Hono } from 'hono';
import { requireRole } from '../middleware/auth.js';
import { tokenBucket } from '../middleware/ratelimit.js';
import { analyzeOrderbook, toGatePair } from '../services/scanner/orderbook-service.js';
import { timeService } from '../services/ingestion/time-sync.js';

type CacheEntry = { at: number; payload: unknown };
const klineCache = new Map<string, CacheEntry>();
const obCache2 = new Map<string, CacheEntry>();
const TTL_MS = 30_000;

export const marketRoutes = new Hono();

marketRoutes.get('/market/orderbook', requireRole('owner','viewer','system_agent'), tokenBucket(60,60), async (c) => {
  const symbol = (c.req.query('symbol') ?? 'BTCUSDT').toUpperCase();
  const pair = toGatePair(symbol);
  const key = `ob:${pair}`;
  const hit = obCache2.get(key);
  if (hit && timeService.now() - hit.at < TTL_MS) return c.json(hit.payload as never);
  const ob = await analyzeOrderbook(pair);
  if (!ob) return c.json({ error: 'orderbook_unavailable', pair }, 503);
  const payload = { atServerMs: timeService.now(), source: 'GATE.IO', pair, ...ob };
  obCache2.set(key, { at: timeService.now(), payload });
  return c.json(payload as never);
});

marketRoutes.get('/market/klines', requireRole('owner','viewer','system_agent'), tokenBucket(30,60), async (c) => {
  const symbol = (c.req.query('symbol') ?? 'BTCUSDT').toUpperCase();
  const key = `kl:${symbol}`;
  const hit = klineCache.get(key);
  if (hit && timeService.now() - hit.at < TTL_MS) return c.json(hit.payload as never);
  const intervals = ['15m','1h','4h','1d'] as const;
  const results = await Promise.all(intervals.map(async (iv) => {
    try {
      const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${iv}&limit=50`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [iv, { error: res.status }] as const;
      const arr = await res.json() as unknown[];
      return [iv, { source: 'BINANCE_VISION', count: (arr as unknown[]).length, sample: (arr as unknown[]).slice(-2) }] as const;
    } catch { return [iv, { error: 'fetch_failed' }] as const; }
  }));
  const out: Record<string, unknown> = {};
  for (const [iv, v] of results) out[iv as string] = v;
  const payload = { atServerMs: timeService.now(), symbol, klines: out };
  klineCache.set(key, { at: timeService.now(), payload });
  return c.json(payload as never);
});

marketRoutes.get('/market/tape', requireRole('owner','viewer','system_agent'), tokenBucket(60,60), async (c) => {
  const symbol = (c.req.query('symbol') ?? 'BTCUSDT').toUpperCase();
  const pair = toGatePair(symbol);
  try {
    const res = await fetch(`https://api.gateio.ws/api/v4/spot/trades?currency_pair=${pair}&limit=50`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return c.json({ error: 'tape_unavailable' }, 503);
    const j = await res.json() as unknown;
    return c.json({ atServerMs: timeService.now(), source: 'GATE.IO', pair, tape: j });
  } catch { return c.json({ error: 'tape_fetch_failed' }, 503); }
});
