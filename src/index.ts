import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createNodeWebSocket } from '@hono/node-ws';
import { sql } from 'drizzle-orm';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { getEnv } from './config/env.js';
import { closeDb, getDb } from './db/index.js';
import { withActorContext } from './db/actor.js';
import { hashPassword } from './auth/passwords.js';
import { installGlobalLogScrubber } from './services/execution/vault.js';
import { timeService } from './services/ingestion/time-sync.js';
import { agentEvents } from './services/events.js';
import { closeRedis } from './services/redis.js';
import { authRoutes } from './routes/auth.routes.js';
import { systemRoutes } from './routes/system.routes.js';
import { readRoutes, executeRoutes } from './routes/trading.routes.js';
import { marketRoutes } from './routes/market.routes.js';
import { manualRoutes } from './routes/manual.routes.js';
import { requireRole } from './middleware/auth.js';
import type { AgentEvent } from './services/events.js';

installGlobalLogScrubber();

const app = new Hono();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use('*', cors({
  origin: ['http://localhost:8289', 'http://localhost:3000', 'http://127.0.0.1:8289'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-mfa-code'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

app.get('/api/v1/system/data-sources', requireRole('owner', 'viewer', 'system_agent'), async (c) => {
  const { MultiSourceFeedManager } = await import('./services/ingestion/feed-manager.js');
  const redisState = await MultiSourceFeedManager.readStateFromRedis();
  if (redisState) return c.json(redisState);
  const fm = (globalThis as unknown as { __feedManager?: { getState?: () => unknown } }).__feedManager;
  const state = fm?.getState?.() ?? { depth: {}, trade: {}, active: {} };
  return c.json({ atServerMs: timeService.now(), state });
});

app.use('*', async (c, next) => {
  c.set('rawBody', (await c.req.text().catch(() => '')) ?? '');
  await next();
});

app.get('/api/v1/health', async (c) => {
  let dbOk = false;
  try {
    await getDb().execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const sync = timeService.lastSyncInfo();
  return c.json({
    ok: true,
    db: dbOk ? 'up' : 'down',
    serverTime: timeService.now(),
    timeSync: sync,
    mode: 'PAPER (default)',
  });
});

app.get('/', (c) => c.redirect('/app'));

app.get('/app', (c) => {
  try {
    const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
    return c.html(html);
  } catch {
    return c.html(`<h1>Terminal belum ter-copy</h1><p>Jalankan: copy opendesign/mockups/ai-trading-terminal/index.html ke public/index.html</p>`, 500);
  }
});

const MIME: Record<string, string> = { '.css':'text/css','.js':'application/javascript','.json':'application/json','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff' };
app.get('/design-systems/*', (c) => {
  const p = c.req.path.replace(/^\//,'');
  const file = join(process.cwd(), 'public', p);
  if (!existsSync(file)) return c.text('not found', 404);
  try { const body = readFileSync(file); const ext = extname(file); return new Response(body, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control':'public, max-age=86400' } }); } catch { return c.text('not found', 404); }
});
app.get('/public/*', (c) => {
  const p = c.req.path.replace(/^\//,'');
  const file = join(process.cwd(), p);
  if (!existsSync(file)) return c.text('not found', 404);
  try { const body = readFileSync(file); return new Response(body, { headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' } }); } catch { return c.text('not found', 404); }
});

app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/system', systemRoutes);
app.route('/api/v1', executeRoutes);
app.route('/api/v1', readRoutes);
app.route('/api/v1', marketRoutes);
app.route('/api/v1', manualRoutes);

app.get(
  '/api/v1/ws',
  requireRole('owner', 'viewer', 'system_agent'),
  upgradeWebSocket(() => {
    let forward: ((event: AgentEvent) => void) | null = null;
    return {
      onOpen(_evt, ws) {
        forward = (event: AgentEvent) => {
          try {
            ws.send(JSON.stringify(event));
          } catch {
            /* socket closed */
          }
        };
        agentEvents.on('event', forward);
        try {
          ws.send(JSON.stringify({ type: 'hello', atServerMs: timeService.now() }));
        } catch {
          /* socket closed */
        }
      },
      onClose() {
        if (forward) agentEvents.off('event', forward);
        forward = null;
      },
      onMessage() {
        /* telemetry stream is one-way */
      },
    };
  }),
);

async function bootstrapOwner(): Promise<void> {
  const env = getEnv();
  const ownerEmail = env.OWNER_EMAIL;
  const ownerPassword = env.OWNER_PASSWORD;
  if (!ownerEmail || !ownerPassword) return;
  await withActorContext('00000000-0000-0000-0000-00000000a001', async (tx) => {
    await tx.execute(sql`SELECT bootstrap_owner(${ownerEmail}, ${hashPassword(ownerPassword)})`);
  });
  console.log('[boot] owner ensured');
}

export function buildApp(): Hono {
  return app;
}

async function main(): Promise<void> {
  getEnv();
  timeService.registerProvider('gate', async () => {
    const r = await fetch('https://api.gateio.ws/api/v4/spot/time', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`gate time ${r.status}`);
    const j = await r.json() as { server_time?: number; serverTime?: number };
    const ms = j.server_time ?? j.serverTime;
    if (typeof ms !== 'number') throw new Error('gate time invalid');
    return ms > 1e12 ? ms : ms * 1000;
  });
  timeService.startAutoSync();
  try {
    getDb();
    await bootstrapOwner();
  } catch (err) {
    console.warn(
      '[boot] database unavailable — serving degraded (health/status only):',
      err instanceof Error ? err.message : err,
    );
  }

  const port = getEnv().PORT;
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[api] listening on http://localhost:${info.port}`);
  });
  injectWebSocket(server);

  const shutdown = () => {
    console.log('[api] shutting down');
    timeService.stopAutoSync();
    server.close();
    void Promise.all([closeDb(), closeRedis()]).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('src/index.ts');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[api] boot failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
