import Redis from 'ioredis';
import { getEnv } from '../config/env.js';

let client: Redis | null = null;
let connecting = false;
let warnedNoRedis = false;

let pending: Promise<Redis | null> | null = null;
export function getRedis(): Redis | null {
  const url = getEnv().REDIS_URL;
  if (!url) {
    if (!warnedNoRedis) { warnedNoRedis = true; console.warn('[redis] REDIS_URL empty — execution queue disabled (manual BUY will stall at PENDING)'); }
    return null;
  }
  if (client) {
    if (client.status === 'end' || client.status === 'close') {
      void client.connect().catch(() => undefined);
    }
    return client;
  }
  if (connecting) return pending ? null : null;
  connecting = true;
  const create = new Promise<Redis | null>((resolve) => {
    try {
      const instance = new Redis(url, {
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => Math.min(times * 500, 5000),
        enableReadyCheck: true,
      });
      instance.on('error', (e) => console.warn('[redis] error:', e instanceof Error ? e.message : e));
      instance.on('ready', () => console.log('[redis] ready'));
      instance.on('close', () => console.warn('[redis] close'));
      client = instance;
      void client.connect().catch((e) => console.warn('[redis] connect failed:', e instanceof Error ? e.message : e));
      resolve(instance);
    } catch (e) {
      console.warn('[redis] create failed:', e instanceof Error ? e.message : e);
      client = null;
      resolve(null);
    } finally {
      connecting = false;
      pending = null;
    }
  });
  pending = create;
  return null;
}

export function closeRedis(): Promise<void> {
  const quit = client?.quit().then(() => undefined).catch(() => undefined);
  return quit ?? Promise.resolve();
}
