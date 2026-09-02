import { getDb } from '../../db/index.js';
import { signalFeatures, signalOutcomes } from '../../../db/schema.js';
import { sql } from 'drizzle-orm';

export interface ProbInput {
  flow: string;
  confluenceScore: number; // 0-1
  absorptionScore: number; // 0-100
  wallAction: string;
  spreadPct: number;
  imbalance: number;
}

export interface ProbResult {
  p: number;       // P(TP before SL) 0-1
  n: number;       // samples that informed p
  prior: boolean;  // true if cold-start prior (no data yet)
  ev: number;      // expected value: p*tpPct - (1-p)*|slPct|
}

const COLD_PRIOR_P = 0.52;
const COLD_N = 12; // prior strength (Laplace pseudo-count)

function bucketOf(i: ProbInput): string {
  // coarse bucket: flow × confluence bin × absorption bin × wall presence
  const cBin = i.confluenceScore >= 0.8 ? 'hi' : i.confluenceScore >= 0.5 ? 'mid' : 'lo';
  const aBin = i.absorptionScore >= 75 ? 'hi' : i.absorptionScore >= 40 ? 'mid' : 'lo';
  const wall = i.wallAction !== 'NONE' ? 'wall' : 'nowall';
  return `${i.flow}:${cBin}:${aBin}:${wall}`;
}

type OutcomeRow = { outcome: string; count: number };

let cache: { at: number; byBucket: Map<string, OutcomeRow[]> } | null = null;
const CACHE_TTL_MS = 45_000;
// eslint-disable-next-line no-restricted-syntax -- cache wall-clock, not trading time
const wallNow = (): number => Date.now();

export async function calibratedProb(input: ProbInput, tpPct: number, slPctAbs: number): Promise<ProbResult> {
  const bucket = bucketOf(input);
  let byBucket = cache?.byBucket;
  if (!cache || wallNow() - cache.at > CACHE_TTL_MS) {
    byBucket = await loadOutcomeCounts();
    cache = { at: wallNow(), byBucket };
  }
  const safeBucket = byBucket ?? new Map<string, OutcomeRow[]>();
  const rows = safeBucket.get(bucket) ?? [];
  // aggregate across bucket + fallback to global if thin
  let wins = rows.filter((r) => r.outcome === 'TP').reduce((s, r) => s + r.count, 0);
  let total = rows.reduce((s, r) => s + r.count, 0);
  let prior = false;
  if (total < 15) {
    const globalWins = [...safeBucket.values()].flat().filter((r) => r.outcome === 'TP').reduce((s, r) => s + r.count, 0);
    const globalTotal = [...safeBucket.values()].flat().reduce((s, r) => s + r.count, 0);
    if (globalTotal >= 10) {
      wins = globalWins; total = globalTotal;
    } else {
      prior = true;
      // Laplace smoothing around cold prior
      const pSmooth = (wins + COLD_PRIOR_P * COLD_N) / (total + COLD_N);
      const ev = pSmooth * tpPct - (1 - pSmooth) * slPctAbs;
      return { p: pSmooth, n: total, prior, ev };
    }
  }
  // Wilson lower-bound style: shrink toward 0.5 when thin
  const raw = total > 0 ? wins / total : COLD_PRIOR_P;
  const shrink = Math.min(1, total / 80);
  const p = raw * shrink + 0.5 * (1 - shrink) * 0.15; // mild prior toward 0.5, not dominant
  const ev = p * tpPct - (1 - p) * slPctAbs;
  return { p, n: total, prior, ev };
}

async function loadOutcomeCounts(): Promise<Map<string, OutcomeRow[]>> {
  const m = new Map<string, OutcomeRow[]>();
  try {
    const db = getDb();
    // outcomes don't have bucket column yet; infer bucket from signalFeatures joined on decisionId
    // Fallback: treat all closed outcomes as global bucket "__global__"
    const rows = await db
      .select({ outcome: signalOutcomes.outcome, cnt: sql<number>`count(*)::int` })
      .from(signalOutcomes)
      .groupBy(signalOutcomes.outcome);
    const coerce = (rows as unknown as Array<{ outcome: string; cnt: number }>)
      .map((r) => ({ outcome: r.outcome, count: r.cnt }));
    // Also try to load per-bucket if raw bucket field exists in signal_features.raw
    // For now expose global only; bucket split will populate as we record bucket in raw.
    const globalRows = coerce;
    m.set('__global__', globalRows);
    // also expose a synthetic bucket key for every bucket string as global fallback is used
    // (calibratedProb falls back to globalWins anyway)
    // Keep bucket keys populated lazily by recording bucket in recorder (see § recordOutcomeWithBucket)
    try {
      const featRows = await db
        .select({ raw: signalFeatures.raw, outcome: signalOutcomes.outcome })
        .from(signalOutcomes)
        .innerJoin(signalFeatures, sql`${signalFeatures.decisionId} = ${signalOutcomes.decisionId}`)
        .limit(2000);
      for (const r of featRows as Array<{ raw: Record<string, unknown> | null; outcome: string }>) {
        const b = (r.raw as Record<string, unknown> | null)?.['probBucket'] as string | undefined;
        if (!b) continue;
        const arr = m.get(b) ?? [];
        const hit = arr.find((x) => x.outcome === r.outcome);
        if (hit) hit.count += 1; else arr.push({ outcome: r.outcome, count: 1 });
        m.set(b, arr);
      }
    } catch { /* join path optional */ }
  } catch { /* DB unavailable in unit tests */ }
  if (!m.has('__global__')) m.set('__global__', []);
  return m;
}

export function exposeBucketForRecording(input: ProbInput): string {
  return bucketOf(input);
}
