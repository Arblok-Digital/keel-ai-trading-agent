import { getEnv } from './config/env.js';
import { getDb } from './db/index.js';
import { withActorContext } from './db/actor.js';
import { positions, orders, tradeDecisions } from '../db/schema.js';
import { installGlobalLogScrubber } from './services/execution/vault.js';
import { timeService } from './services/ingestion/time-sync.js';
import { onStaleTick } from './services/ingestion/staleness-gate.js';
import { BinanceCexStream } from './services/ingestion/cex-stream.js';
import { GateStream } from './services/ingestion/gate-ws-stream.js';
import { CoinbaseStream } from './services/ingestion/coinbase-stream.js';
import { BinanceVisionPoller } from './services/ingestion/binance-vision-rest.js';
import { MultiSourceFeedManager } from './services/ingestion/feed-manager.js';
import { paperFeed, paperAdapter } from './services/execution/paper-adapter.js';
import { binanceSpotAdapter } from './services/execution/binance-spot.js';
import { getTradingMode } from './services/execution/executor.js';
import { loadExchangeCredentials } from './services/execution/vault.js';
import { startLedgerSyncLoop } from './services/reconciliation/ledger-sync.js';
import { verifyAuditChain } from './services/audit/hash-verifier.js';
import { generateSignal } from './services/mm-brain/signal-generator.js';
import { temporalMemory } from './services/mm-brain/temporal-memory.js';
import { KlineAggregator } from './services/ingestion/kline-aggregator.js';
import { MTFEngine } from './services/mm-brain/mtf-engine.js';
import { VolumeVelocityTracker } from './services/ingestion/narrative-velocity.js';
import { runExitMonitor } from './services/risk/exit-monitor.js';
import type { NormalizedDepth, NormalizedTrade } from './types/exchange.js';
import { SYSTEM_PRINCIPAL_ID } from './db/actor.js';
import { reserveAndPersistDecision } from './services/risk/gatekeeper.js';
import { executeDecision } from './services/execution/executor.js';
import { isKillSwitchActiveTx } from './services/risk/kill-switch.js';
import { computeDrawdownPct } from './services/risk/drawdown-monitor.js';
import { AuditService } from './services/audit/audit-service.js';
import { startDepthKlineSampler } from './services/recorder/signal-recorder.js';
import { eq } from 'drizzle-orm';
import { getRedis } from './services/redis.js';

installGlobalLogScrubber();

const WATCH_SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const WATCH_DYNAMIC = { enabled: true, limit: 6, spreadMaxPct: 0.6, minLiquidityUsd: 30_000 };
let lastWatchRefreshAt = 0;
const latestDepths = new Map<string, NormalizedDepth>();
const recentTrades = new Map<string, NormalizedTrade[]>();
const klineAggregator = new KlineAggregator();
const mtfEngine = new MTFEngine();
const narrativeTracker = new VolumeVelocityTracker();
let lastNarrativeCompute = 0;
let cachedNarrativeVelocity = 0;

async function refreshWatchlist(): Promise<void> {
  if (!WATCH_DYNAMIC.enabled) return;
  const now = timeService.now();
  if (now - lastWatchRefreshAt < 90_000) return;
  lastWatchRefreshAt = now;
  try {
    const { fetchAllEarlyCandidates } = await import('./services/scanner/all-ticker-scanner.js');
    const { allCount, top } = await fetchAllEarlyCandidates(Math.max(20, WATCH_DYNAMIC.limit + 10));
    void allCount;
    const eligible = top
      .filter((c) => {
        if (c.ob && c.ob.spreadPct > WATCH_DYNAMIC.spreadMaxPct) return false;
        if (c.ob && (c.ob.bidDepth1pctUsd + c.ob.askDepth1pctUsd) < WATCH_DYNAMIC.minLiquidityUsd) return false;
        if (!c.ob && c.liquidityUsd < WATCH_DYNAMIC.minLiquidityUsd) return false;
        return c.score >= 52;
      })
      .slice(0, WATCH_DYNAMIC.limit)
      .map((c) => c.symbol.toUpperCase().replace('/', ''));
    const keep = new Set(['BTCUSDT','ETHUSDT']);
    const merged = [...keep];
    for (const s of eligible) if (!keep.has(s) && merged.length < keep.size + WATCH_DYNAMIC.limit) merged.push(s);
    if (merged.length > WATCH_SYMBOLS.length || merged.some((s, i) => WATCH_SYMBOLS[i] !== s)) {
      WATCH_SYMBOLS.splice(0, WATCH_SYMBOLS.length, ...merged);
      console.log(`[watchlist] refreshed: ${WATCH_SYMBOLS.join(', ')}`);
      try {
        const fm = (globalThis as unknown as { __feedManagerInstance?: { resubscribe: (s: string[]) => void } }).__feedManagerInstance;
        if (fm) fm.resubscribe([...WATCH_SYMBOLS]);
      } catch {}
      try {
        const { getRedis } = await import('./services/redis.js');
        const redis = getRedis();
        if (redis && typeof (redis as unknown as { publish?: unknown }).publish === 'function') {
          await (redis as unknown as { publish: (c: string, m: string) => Promise<number> }).publish('watchlist:updated', JSON.stringify({ at: now, symbols: WATCH_SYMBOLS }));
        }
      } catch {}
      try {
        const resub = (globalThis as unknown as { __visionPollerResubscribe?: (s: string[]) => void }).__visionPollerResubscribe;
        if (typeof resub === 'function') resub([...WATCH_SYMBOLS]);
      } catch {}
    }
  } catch (e) {
    console.warn('[watchlist] refresh failed:', e instanceof Error ? e.message : String(e));
  }
}

function seedPaperPrices(): void {
  paperFeed.set('BTCUSDT', 60_000);
  paperFeed.set('ETHUSDT', 3_000);
  const extra = ['SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','PEPEUSDT','SHIBUSDT','AVAXUSDT','ADAUSDT','LTCUSDT','LINKUSDT'];
  for (const s of extra) paperFeed.set(s, 100);
  async function refreshPaperMids(): Promise<void> {
    try{
      const { analyzeOrderbook, toGatePair } = await import('./services/scanner/orderbook-service.js');
      for (const s of ['BTCUSDT','ETHUSDT',...extra]) {
        try{
          const ob=await analyzeOrderbook(toGatePair(s));
          // only accept fresh orderbook; if fetch returns null (stale), keep old but mark stale
          if(ob) paperFeed.set(s, ob.mid);
        }catch{}
      }
    }catch{}
  }
  void refreshPaperMids();
  const feedTimer = setInterval(()=>{ void refreshPaperMids(); }, 15_000);
  feedTimer.unref?.();
  // watchdog: if laptop woke from sleep, timeService drift > 10s gap → force refresh
  let lastWall = timeService.now();
  setInterval(()=>{
    const now = timeService.now();
    if (now - lastWall > 20_000) { void refreshPaperMids(); }
    lastWall = now;
  }, 10_000).unref?.();
}

async function runSignalCycle(): Promise<void> {
  await refreshWatchlist().catch(() => undefined);
  for (const symbol of WATCH_SYMBOLS) {
    const depth = latestDepths.get(symbol) ?? null;
    if (!depth) continue;
    const trades = recentTrades.get(symbol) ?? [];
    const klines = klineAggregator.getKlines(symbol);
    const mtfTrend = mtfEngine.computeAll(symbol, klines);
    const mtfBias = { m15: mtfTrend.m15, h1: mtfTrend.h1, h4: mtfTrend.h4, d1: mtfTrend.d1 };
    if (timeService.now() - lastNarrativeCompute > 5_000) {
      const volWindow = trades.reduce((s,t)=>s+t.notionalUsd,0);
      cachedNarrativeVelocity = narrativeTracker.observe(volWindow, timeService.now());
      lastNarrativeCompute = timeService.now();
    }
    const result = generateSignal({
      symbol,
      venue: 'BINANCE_SPOT',
      depth,
      recentTrades: trades,
      mtfBias,
      narrativeVelocity: cachedNarrativeVelocity,
      entryPrice: depth.asks[0]?.price ?? 0,
      detectedAtServerMs: timeService.now(),
    });
    if (!result.signal) {
      console.log(`[signal] discarded ${symbol}: ${result.discardedReason}`);
      continue;
    }
    // P2 probability gate (prop TP + EV) — shadow until 200 samples unless enforced
    try {
      const { calibratedProb, exposeBucketForRecording } = await import('./services/execution/probability-engine.js');
      const tpPctAbs = Math.abs(Number(result.signal.takeProfitPct));
      const slPctAbs = Math.abs(Number(result.signal.stopLossPct));
      const prob = await calibratedProb({
        flow: result.signal.smartMoneyFlow,
        confluenceScore: result.confluence.score,
        absorptionScore: result.absorption?.score ?? 0,
        wallAction: result.wall?.action ?? 'NONE',
        spreadPct: Number(result.levels?.volatilityPct ?? 0.4),
        imbalance: Number(result.levels?.reason?.match(/imbalance ([\d.]+)/)?.[1] ?? 1),
      }, tpPctAbs, slPctAbs);
      const isSwing = (globalThis as unknown as { __keelStrategy?: string }).__keelStrategy === 'SWING';
      const cfg = isSwing ? (await import('./config/algo-config.js')).ALGO_CONFIG.SWING as import('./config/algo-config.js').SwingConfig : null;
      const minProb = (cfg as unknown as { mlMinProb?: number } | null)?.mlMinProb ?? 0.55;
      const shadowOnly = (cfg as unknown as { mlShadowOnly?: boolean } | null)?.mlShadowOnly ?? true;
      const { recordFeature } = await import('./services/recorder/signal-recorder.js');
      const bucket = exposeBucketForRecording({ flow: result.signal.smartMoneyFlow, confluenceScore: result.confluence.score, absorptionScore: result.absorption?.score ?? 0, wallAction: result.wall?.action ?? 'NONE', spreadPct: 0.4, imbalance: 1 });
      void recordFeature({
        symbol, ts: timeService.now(), source: 'prob-gate',
        compositeScore: String(result.compositeScore), liquidityDepthUsd: String(result.liquidityDepthUsd),
        mtf: result.signal.mtfBias, entryPrice: String(result.signal.entryPrice),
        stopLossPct: String(result.signal.stopLossPct), takeProfitPct: String(result.signal.takeProfitPct),
        sizePct: String(result.signal.sizePct), planReason: `p=${prob.p.toFixed(3)} n=${prob.n} ev=${prob.ev.toFixed(2)} bucket=${bucket}`,
        raw: { p: prob.p, n: prob.n, ev: prob.ev, prior: prob.prior, bucket, wall: result.wall, absorption: result.absorption, confluence: result.confluence } as unknown as Record<string,unknown>,
      } as never);
      if (!prob.prior && !shadowOnly && (prob.p < minProb || prob.ev <= 0)) {
        console.log(`[prob] ${symbol} gated: p=${prob.p.toFixed(3)} < ${minProb} or ev=${prob.ev.toFixed(2)} <=0 — discarding`);
        continue;
      }
      if (prob.prior || shadowOnly) console.log(`[prob:shadow] ${symbol} p=${prob.p.toFixed(3)} n=${prob.n} ev=${prob.ev.toFixed(2)} (shadow — not gating)`);
    } catch { /* probability-engine unavailable — proceed */ }
    const outcome = await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
      const killSwitchActive = await isKillSwitchActiveTx(tx);
      return reserveAndPersistDecision(tx, result.signal!, SYSTEM_PRINCIPAL_ID, {
        dailyDrawdownPct: currentDrawdownPct,
        killSwitchActive,
      });
    });
    if (!outcome.passed) {
      console.log(`[signal] ${symbol} rejected by risk: ${outcome.reasons.join(';')}`);
      continue;
    }
    // symbol dedupe + HOLD zombie already handled in reserveAndPersistDecision;
    // additionally skip executor for HOLD terminal REJECTED to keep old poll loops cheap
    if (result.signal.action === 'HOLD') {
      console.log(`[signal] ${symbol} HOLD -> terminal REJECTED (no execution)`);
      continue;
    }
    const executed = await executeDecision(outcome.decisionId).catch((err) => {
      console.error('[execute] failed:', err instanceof Error ? err.message : err);
      return null;
    });
    if (executed) console.log(`[execute] ${symbol} -> ${executed.terminalState} (${outcome.decisionId})`);
  }
}

let currentDrawdownPct: number | null = null;

async function main(): Promise<void> {
  getEnv();
  getDb();
  seedPaperPrices();
  const gateTimeProvider = async () => {
    const res = await fetch('https://api.gateio.ws/api/v4/spot/time', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`gate time http ${res.status}`);
    const j = await res.json() as { server_time?: number; serverTime?: number };
    const ms = j.server_time ?? j.serverTime;
    if (typeof ms !== 'number') throw new Error('gate time payload invalid');
    return ms > 1e12 ? ms : ms * 1000;
  };
  timeService.registerProvider('gate', gateTimeProvider);
  timeService.startAutoSync();
  let staleAuditQueue: Promise<void> = Promise.resolve();
  onStaleTick((rejection) => {
    // S6: chained in-process queue + recordInTx (prev-hash lookup) — buildValues(null) broke the chain
    staleAuditQueue = staleAuditQueue
      .then(() =>
        withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
          AuditService.recordInTx(tx, {
            actorId: SYSTEM_PRINCIPAL_ID,
            action: 'STALENESS_REJECTION',
            entity: 'market_data',
            entityId: `${rejection.venue}:${rejection.symbol}`,
            diff: { latencyMs: rejection.latencyMs, stalenessLimitMs: rejection.limitMs },
          }),
        ),
      )
      .catch(() => undefined);
    console.warn('[worker] stale tick rejected:', JSON.stringify(rejection));
  });

  const feedManager = new MultiSourceFeedManager();
  // expose for watchlist resubscribe (refreshWatchlist runs later, after closure init)
  // @ts-expect-error runtime handle for resubscribe
  (globalThis as unknown as { __feedManagerInstance?: typeof feedManager }).__feedManagerInstance = feedManager as unknown as { resubscribe: (s: string[]) => void };
  const visionPoller = new BinanceVisionPoller();
  // @ts-expect-error runtime handle
  (globalThis as unknown as { __visionPollerResubscribe?: (s: string[]) => void }).__visionPollerResubscribe = (s: string[]) => visionPoller.resubscribeSymbols(s);
  visionPoller.registerKlineHandler((symbol, kline, interval) => {
    const tfMap: Record<string, 'm15'|'h1'|'h4'|'d1'> = { m15: 'm15', h1: 'h1', h4: 'h4', d1: 'd1' };
    const tf = tfMap[interval];
    if (tf) {
      klineAggregator.seedKline(symbol, tf, kline);
      const price = kline.close;
      if (price > 0) paperFeed.set(symbol, price);
    }
  });
  feedManager.register(new BinanceCexStream(WATCH_SYMBOLS, { onDepth: () => {}, onTrade: () => {} }) as unknown as import('./services/ingestion/feed-manager.js').FeedProvider);
  feedManager.register(new GateStream() as unknown as import('./services/ingestion/feed-manager.js').FeedProvider);
  feedManager.register(visionPoller as unknown as import('./services/ingestion/feed-manager.js').FeedProvider);
  if (getEnv().ENABLE_COINBASE) {
    feedManager.register(new CoinbaseStream() as unknown as import('./services/ingestion/coinbase-stream.js').CoinbaseStream & import('./services/ingestion/feed-manager.js').FeedProvider);
  }
  try {
    feedManager.start(WATCH_SYMBOLS, {
      onDepth: (d) => {
        latestDepths.set(d.symbol, d);
        temporalMemory.recordDepth(d);
        const mid = d.bids[0]?.price && d.asks[0]?.price ? (d.bids[0].price + d.asks[0].price)/2 : d.bids[0]?.price ?? d.asks[0]?.price ?? null;
        if (mid) paperFeed.set(d.symbol, mid);
        else if (d.bids[0]?.price) paperFeed.set(d.symbol, d.bids[0].price);
      },
      onTrade: (t) => {
        const list = recentTrades.get(t.symbol) ?? [];
        list.push(t);
        if (list.length > 500) list.shift();
        recentTrades.set(t.symbol, list);
        temporalMemory.recordTrades(t.symbol, [t]);
        klineAggregator.onTrade(t.symbol, t);
      },
    });
  } catch (err) {
    console.warn('[worker] feed manager unavailable:', err instanceof Error ? err.message : err);
  }
  (globalThis as unknown as { __feedManager?: MultiSourceFeedManager }).__feedManager = feedManager;

  // S1: single execution plane — worker is the ONLY executor of paper trades.
  // API manual endpoint creates the decision (PENDING) + publishes decisionId here.
  // Also poll for PENDING-without-order as fallback (survives Redis misconfig).
  let manualSub: InstanceType<typeof import('ioredis').default> | null = null;
  function setupManualSub(): void {
    const manualRedis = getRedis();
    if (!manualRedis) return;
    manualSub = manualRedis.duplicate();
    manualSub.on('message', (channel: string, message: string) => {
      if (channel !== 'manual:execute') return;
      const decisionId = String(message || '').trim();
      if (!decisionId) return;
      console.log(`[manual] executing queued decision ${decisionId}`);
      void executeDecision(decisionId)
        .then((res) => console.log(`[manual] ${decisionId} -> ${res.terminalState}`))
        .catch((err) => console.error(`[manual] ${decisionId} failed:`, err instanceof Error ? err.message : err));
    });
    manualSub.on('error', (err) => console.warn('[manual] sub error:', err instanceof Error ? err.message : err));
    void manualSub.connect().then(() => manualSub!.subscribe('manual:execute')).then(() => console.log('[manual] subscribed manual:execute')).catch((err) =>
      console.error('[manual] subscribe failed:', err instanceof Error ? err.message : err),
    );
  }
  setupManualSub();

  // Fallback poll: if Redis publish missed (lazyConnect race), execute PENDING without order within 3s
  const fallbackPoll = setInterval(async () => {
    try {
      if (manualSub && manualSub.status === 'ready') return; // Redis healthy — subscription will handle it
      const db = getDb();
      const pendings = await db
        .select({ id: tradeDecisions.id, sid: tradeDecisions.symbol, tm: tradeDecisions.createdAt })
        .from(tradeDecisions)
        .where(eq(tradeDecisions.terminalState, 'PENDING'));
      for (const row of pendings) {
        const ageMs = timeService.now() - new Date(row.tm as unknown as string).getTime();
        if (ageMs < 2500) continue; // give Redis path 2.5s to deliver publish first
        if (ageMs > 90_000) continue; // skip stale manual leftovers
        const [existing] = await db.select({ id: orders.id }).from(orders).where(eq(orders.decisionId, row.id)).limit(1);
        if (existing) continue;
        console.log(`[manual-fallback] executing PENDING without order ${row.id} (${row.sid})`);
        await executeDecision(row.id).catch((err) =>
          console.error(`[manual-fallback] ${row.id} failed:`, err instanceof Error ? err.message : err),
        );
      }
    } catch { /* ignore */ }
  }, 3000);
  fallbackPoll.unref?.();

  // S1: recovery sweep — decisions stuck PENDING without an order are executed on boot
  void (async () => {
    try {
      const db = getDb();
      const pending = await db
        .select({ id: tradeDecisions.id })
        .from(tradeDecisions)
        .where(eq(tradeDecisions.terminalState, 'PENDING'));
      for (const row of pending) {
        const [existing] = await db.select({ id: orders.id }).from(orders).where(eq(orders.decisionId, row.id)).limit(1);
        if (existing) continue;
        console.log(`[recovery] executing stuck PENDING decision ${row.id}`);
        await executeDecision(row.id).catch((err) =>
          console.error(`[recovery] ${row.id} failed:`, err instanceof Error ? err.message : err),
        );
      }
    } catch (err) {
      console.error('[recovery] sweep failed:', err instanceof Error ? err.message : err);
    }
  })();

  async function computePaperEquityUsd(): Promise<number> {
    const db = getDb();
    const openPositions = await db.select().from(positions).where(eq(positions.isOpen, true));
    const positionsWithOrders = await Promise.all(
      openPositions.map(async (pos) => {
        const [order] = await db.select().from(orders).where(eq(orders.id, pos.orderId)).limit(1);
        return {
          symbol: pos.symbol,
          sizePct: pos.sizePct,
          entryPrice: pos.entryPrice,
          executedQty: order?.executedQty ?? '0',
          requestedQty: order?.requestedQty ?? '0',
        };
      }),
    );
    return paperAdapter.getTotalEquityUsd(positionsWithOrders);
  }

  const STABLE_ASSETS = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD']);
  function isStableAsset(a: string): boolean { return STABLE_ASSETS.has(a.toUpperCase()); }
  async function computeLiveLocalEquityUsd(): Promise<number> {
    const creds = await loadExchangeCredentials('BINANCE_SPOT');
    const balances = await binanceSpotAdapter.balances(creds);
    const stableCashUsd = balances.filter((b) => isStableAsset(b.asset)).reduce((sum, b) => sum + b.usdValue, 0);
    const livePositionsUsd = await computeLiveInventoryValueUsd();
    return stableCashUsd + livePositionsUsd;
  }

  async function computeLiveInventoryValueUsd(): Promise<number> {
    const db = getDb();
    const openPositions = await db.select().from(positions).where(eq(positions.isOpen, true));
    let sum = 0;
    for (const pos of openPositions) {
      const [order] = await db.select().from(orders).where(eq(orders.id, pos.orderId)).limit(1);
      const qty = Number(order?.executedQty ?? order?.requestedQty ?? '0');
      if (qty <= 0) continue;
      const price = paperFeed.priceUsd(pos.symbol);
      if (price !== null) sum += qty * price;
      else if (Number(pos.entryPrice) > 0) sum += qty * Number(pos.entryPrice);
    }
    return sum;
  }

  startLedgerSyncLoop({
    localEquityUsd: async () => {
      const mode = await getTradingMode();
      if (mode === 'LIVE') return computeLiveLocalEquityUsd();
      return computePaperEquityUsd();
    },
    exchangeEquityUsd: async () => {
      const mode = await getTradingMode();
      if (mode === 'LIVE') {
        const creds = await loadExchangeCredentials('BINANCE_SPOT');
        const balances = await binanceSpotAdapter.balances(creds);
        return balances.reduce((sum, b) => sum + b.usdValue, 0);
      }
      return computePaperEquityUsd();
    },
    breakdown: async (): Promise<Record<string, { localUsd: number; exchangeUsd: number }>> => {
      const mode = await getTradingMode();
      if (mode === 'LIVE') {
        const localUsd = await computeLiveLocalEquityUsd();
        const creds = await loadExchangeCredentials('BINANCE_SPOT');
        const balances = await binanceSpotAdapter.balances(creds);
        const exchangeUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
        return { BINANCE_SPOT: { localUsd, exchangeUsd } };
      }
      const paperUsd = await computePaperEquityUsd();
      return { PAPER: { localUsd: paperUsd, exchangeUsd: paperUsd } };
    },
  });

  let hwm = 10_000;
  setInterval(async () => {
    const mode = await getTradingMode();
    const equity = mode === 'LIVE' ? await computeLiveLocalEquityUsd().catch(() => 0) : await computePaperEquityUsd().catch(() => 0);
    if (equity <= 0) return;
    hwm = Math.max(hwm, equity);
    currentDrawdownPct = computeDrawdownPct(equity, hwm);
  }, 15_000).unref?.();

  setInterval(() => {
    void runSignalCycle().catch((err) =>
      console.error('[signal] cycle failed:', err instanceof Error ? err.message : err),
    );
  }, 30_000);

  setInterval(() => {
    void runExitMonitor()
      .then((res) => {
        if (res.closed.length > 0) {
          console.log(`[exit-monitor] closed ${res.closed.length} position(s):`, res.closed.map((c) => `${c.symbol} (${c.reason})`).join(', '));
        }
      })
      .catch((err) => console.error('[exit-monitor] failed:', err instanceof Error ? err.message : err));
  }, 5_000).unref?.();

  setInterval(() => {
    void verifyAuditChain()
      .then((summary) => {
        if (!summary.lockedDown) console.log(`[audit] chain verified (${summary.checked} rows)`);
        else console.error('[audit] TAMPER DETECTED — lockdown engaged');
      })
      .catch(() => undefined);
  }, 6 * 3_600_000).unref?.();

  startDepthKlineSampler();
  console.log('[worker] started');
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('src/worker.ts');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[worker] boot failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
