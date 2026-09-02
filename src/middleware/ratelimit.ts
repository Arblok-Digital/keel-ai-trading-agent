import type { Context, MiddlewareHandler } from 'hono';
import { getRedis } from '../services/redis.js';
import { timeService } from '../services/ingestion/time-sync.js';

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const memoryBuckets = new Map<string, Bucket>();

export function tokenBucket(capacity: number, refillPerMinute: number): MiddlewareHandler {
  return async (c: Context, next) => {
    const identity =
      c.get('actor')?.id ?? c.req.header('x-forwarded-for') ?? 'anonymous';
    const key = `${c.req.path}|${identity}`;
    const nowServerMs = timeService.now();
    const refillPerMs = refillPerMinute / 60_000;

    const redis = getRedis();
    if (redis && redis.status === 'ready') {
      try {
        const windowMs = 60_000;
        const bucketKey = `rl:${key}`;
        const state = await redis.hmget(bucketKey, 'tokens', 'ts');
        const prevTokens = Number(state[0] ?? capacity);
        const prevTs = Number(state[1] ?? nowServerMs);
        const refilled = Math.min(capacity, prevTokens + (nowServerMs - prevTs) * refillPerMs);
        if (refilled < 1) return c.json({ error: 'rate_limited' }, 429);
        await redis.hset(bucketKey, { tokens: refilled - 1, ts: nowServerMs });
        await redis.pexpire(bucketKey, windowMs * 2);
        await next();
        return;
      } catch {
        console.warn('[ratelimit] redis unavailable; falling back to memory');
      }
    }

    const bucket = memoryBuckets.get(key) ?? { tokens: capacity, lastRefillMs: nowServerMs };
    bucket.tokens = Math.min(capacity, bucket.tokens + (nowServerMs - bucket.lastRefillMs) * refillPerMs);
    bucket.lastRefillMs = nowServerMs;
    if (bucket.tokens < 1) {
      memoryBuckets.set(key, bucket);
      return c.json({ error: 'rate_limited' }, 429);
    }
    bucket.tokens -= 1;
    memoryBuckets.set(key, bucket);
    await next();
  };
}
