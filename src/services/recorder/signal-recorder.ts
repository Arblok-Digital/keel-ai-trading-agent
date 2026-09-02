import { getDb } from '../../db/index.js';
import { signalFeatures, signalOutcomes } from '../../../db/schema.js';
import { timeService } from '../ingestion/time-sync.js';

export async function recordFeature(row: typeof signalFeatures.$inferInsert): Promise<void> {
  try { await getDb().insert(signalFeatures).values({ ...row, ts: row.ts ?? timeService.now() }); } catch { /* best-effort */ }
}
export async function recordOutcome(row: typeof signalOutcomes.$inferInsert): Promise<void> {
  try { await getDb().insert(signalOutcomes).values(row); } catch { /* best-effort */ }
}
let samplerTimer: ReturnType<typeof setInterval> | undefined;
export function startDepthKlineSampler(): void {
  if (samplerTimer) return;
  samplerTimer = setInterval(async () => {
    try {
      const { analyzeOrderbook, toGatePair } = await import('../scanner/orderbook-service.js');
      for (const sym of ['BTCUSDT','ETHUSDT']) {
        // scalp snapshot = training feature for swing ML (daily)
        const obScalp = await analyzeOrderbook(toGatePair(sym), 'SCALP').catch(()=>null);
        const obSwing = await analyzeOrderbook(toGatePair(sym), 'SWING').catch(()=>null);
        const ob = obScalp ?? obSwing;
        if (!ob) continue;
        await recordFeature({
          symbol: sym, ts: timeService.now(), source: 'sampler-1m',
          compositeScore: String(50),
          liquidityDepthUsd: String(ob.bidDepth1pctUsd+ob.askDepth1pctUsd),
          imbalance: String(ob.imbalance), bidDepth1pctUsd: String(ob.bidDepth1pctUsd),
          askDepth1pctUsd: String(ob.askDepth1pctUsd), spreadPct: String(ob.spreadPct),
          atr1h: ob.atr1h!=null? String(ob.atr1h): null, entryPrice: String(ob.mid),
          planReason: `[SCALP ${obScalp?.plan.side??'?'}→SWING ${obSwing?.plan.side??'?'}] `+ob.plan.reason,
          raw: { scalp: obScalp as unknown as Record<string,unknown>, swing: obSwing as unknown as Record<string,unknown> } as Record<string,unknown>,
          mtf: null,
        });
      }
    } catch { /* ignore */ }
  }, 60_000);
  samplerTimer.unref?.();
}
export function stopSampler(){ if(samplerTimer) clearInterval(samplerTimer); samplerTimer=undefined; }
