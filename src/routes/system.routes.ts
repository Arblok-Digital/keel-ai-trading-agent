import { Hono } from 'hono';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { credentials, systemMode, VENUES } from '../../db/schema.js';
import { SYSTEM_PRINCIPAL_ID, withActorContext } from '../db/actor.js';
import { requireMfa, requireRole } from '../middleware/auth.js';
import { validateBody, validatedBody } from '../middleware/validation.js';
import { tokenBucket } from '../middleware/ratelimit.js';
import { assertSpotOnlyScopes, decryptSecret, encryptSecret, keyFingerprint } from '../services/execution/vault.js';
import { binanceSpotAdapter } from '../services/execution/binance-spot.js';
import { SpotOnlyViolationError } from '../services/execution/exchange-adapter.js';
import { engageKillSwitch } from '../services/risk/kill-switch.js';
import { getTradingMode } from '../services/execution/executor.js';
import { AuditService } from '../services/audit/audit-service.js';
import { latestReport } from '../services/reconciliation/ledger-sync.js';
import { serializeReconciliationReport } from '../serializers/serialize.js';
import { timeService } from '../services/ingestion/time-sync.js';

export const systemRoutes = new Hono();

const credentialsSchema = z.object({
  venue: z.enum(VENUES),
  label: z.string().min(1).max(64),
  apiKey: z.string().min(8),
  apiSecret: z.string().min(8),
  scopes: z.array(z.string()).default(['spot']),
});

systemRoutes.post(
  '/credentials',
  requireRole('owner'),
  requireMfa(),
  tokenBucket(10, 5),
  validateBody(credentialsSchema),
  async (c) => {
    const actor = c.get('actor');
    const body = validatedBody<z.infer<typeof credentialsSchema>>(c);
    try {
      if (body.venue === 'BINANCE_SPOT') {
        await binanceSpotAdapter.probePermissions({
          apiKey: body.apiKey,
          apiSecret: body.apiSecret,
          scopes: body.scopes,
        });
      }
      const probe = assertSpotOnlyScopes(body.scopes);
      if (!probe.valid) throw new SpotOnlyViolationError(probe.violations);
      const sealed = encryptSecret(JSON.stringify({ apiKey: body.apiKey, apiSecret: body.apiSecret }));
      const stored = await withActorContext(actor.id, async (tx) => {
        const [row] = await tx
          .insert(credentials)
          .values({
            venue: body.venue,
            label: body.label,
            keyFingerprint: keyFingerprint(body.apiKey),
            ciphertext: sealed.ciphertext,
            iv: sealed.iv,
            authTag: sealed.authTag,
            scopes: body.scopes,
            probePassed: true,
            createdBy: actor.id,
          })
          .returning();
        return row;
      });
      await withActorContext(actor.id, (tx) =>
        AuditService.recordInTx(tx, {
          actorId: actor.id,
          action: 'CREDENTIALS_ROTATED',
          entity: 'credentials',
          entityId: stored?.id ?? 'unknown',
          diff: { venue: body.venue, keyFingerprint: keyFingerprint(body.apiKey), permissionsValidated: true },
        }),
      );
      return c.json(
        {
          id: stored?.id,
          venue: body.venue,
          label: body.label,
          keyFingerprint: keyFingerprint(body.apiKey),
          probePassed: true,
          scopes: body.scopes,
        },
        201,
      );
    } catch (err) {
      if (err instanceof SpotOnlyViolationError) {
        await engageKillSwitch({
          actorId: actor.id,
          reason: `credential rejected: non-spot scope ${err.violations.join(',')}`,
        });
        return c.json({ error: 'spot_only_violation', violations: err.violations }, 422);
      }
      throw err;
    }
  },
);

const modeSchema = z.object({ mode: z.enum(['PAPER', 'LIVE']), reason: z.string().max(500).optional() });

systemRoutes.get('/mode', requireRole('owner', 'viewer', 'system_agent'), async (c) => {
  const mode = await getTradingMode();
  return c.json({ mode });
});

systemRoutes.post(
  '/mode',
  requireRole('owner'),
  requireMfa(),
  tokenBucket(5, 5),
  validateBody(modeSchema),
  async (c) => {
    const actor = c.get('actor');
    const { mode, reason } = validatedBody<z.infer<typeof modeSchema>>(c);
    const previousMode = await getTradingMode();
    const updatedAt = new Date(timeService.now());
    const updated = await withActorContext(actor.id, async (tx) => {
      const [row] = await tx
        .update(systemMode)
        .set({ mode, updatedAt, updatedBy: actor.id })
        .where(eq(systemMode.mode, previousMode))
        .returning();
      if (!row) {
        const [created] = await tx.insert(systemMode).values({ mode, updatedBy: actor.id }).returning();
        return created;
      }
      return row;
    });
    await withActorContext(actor.id, (tx) =>
      AuditService.recordInTx(tx, {
        actorId: actor.id,
        action: 'TRADING_MODE_CHANGED',
        entity: 'system_mode',
        entityId: updated?.id ?? 'singleton',
        diff: { previousMode, newMode: mode, reason: reason ?? null },
      }),
    );
    return c.json({ mode: updated?.mode ?? mode });
  },
);

const killSwitchSchema = z.object({ reason: z.string().min(3).max(500) });

systemRoutes.post(
  '/kill-switch',
  requireRole('owner', 'system_agent'),
  tokenBucket(30, 30),
  validateBody(killSwitchSchema),
  async (c) => {
    const actor = c.get('actor');
    const { reason } = validatedBody<z.infer<typeof killSwitchSchema>>(c);
    let cancelled = 0;
    if (await hasLiveBinanceCredentials()) {
      try {
        cancelled = await binanceSpotAdapter.cancelAll(undefined, await loadBinanceCredentials());
      } catch (err) {
        console.error('[kill-switch] CEX cancel failed:', err instanceof Error ? err.message : err);
      }
    }
    const result = await engageKillSwitch({
      actorId: actor.role === 'system_agent' ? SYSTEM_PRINCIPAL_ID : actor.id,
      reason,
      cancelFn: async () => cancelled,
    });
    await withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
      AuditService.recordInTx(tx, {
        actorId: actor.role === 'system_agent' ? SYSTEM_PRINCIPAL_ID : actor.id,
        action: 'KILL_SWITCH_ENGAGED',
        entity: 'kill_switch_events',
        entityId: result.eventId || 'unknown',
        diff: { reason, cancelledOrdersCount: result.cancelledOrdersCount },
      }),
    );
    return c.json({ ok: true, ...result });
  },
);

systemRoutes.post(
  '/kill-switch/release',
  requireRole('owner'),
  tokenBucket(10, 10),
  async (c) => {
    const actor = c.get('actor');
    const { disengageKillSwitch } = await import('../services/risk/kill-switch.js');
    const eventId = await disengageKillSwitch(actor.id);
    await withActorContext(actor.id, (tx) =>
      AuditService.recordInTx(tx, {
        actorId: actor.id,
        action: 'KILL_SWITCH_RELEASED',
        entity: 'kill_switch_events',
        entityId: eventId || 'unknown',
        diff: { reason: 'owner released via UI/API' },
      }),
    );
    return c.json({ ok: true, eventId, isActive: false });
  },
);

async function hasLiveBinanceCredentials(): Promise<boolean> {
  return (await getTradingMode()) === 'LIVE';
}

interface SealedCredentialRow {
  ciphertext: string;
  iv: string;
  auth_tag: string;
  scopes: string[];
}

async function loadBinanceCredentials() {
  const rows = await withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
    tx.execute(sql`SELECT * FROM get_credential_ciphertext('BINANCE_SPOT')`),
  );
  const list = (rows as unknown as { rows?: SealedCredentialRow[] }).rows ?? [];
  const first = list[0];
  if (!first) throw new Error('no binance credential stored');
  const parsed = JSON.parse(
    decryptSecret({ ciphertext: first.ciphertext, iv: first.iv, authTag: first.auth_tag }),
  ) as { apiKey: string; apiSecret: string };
  return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret, scopes: first.scopes };
}

systemRoutes.get('/reconciliation', requireRole('owner', 'viewer', 'system_agent'), async (c) => {
  const report = await latestReport();
  if (!report) return c.json({ error: 'no_report_yet' }, 404);
  return c.json(serializeReconciliationReport(report));
});

systemRoutes.post('/dev/reset-paper', requireRole('owner'), async (c) => {
  const { positions, orders, tradeDecisions, decisionTransitions, systemMode, killSwitchEvents, auditLogs, reconciliationReports } = await import('../../db/schema.js');
  void (await import('drizzle-orm'));
  const res = await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
    const pos = await tx.delete(positions).returning();
    const ord = await tx.delete(orders).returning();
    await tx.delete(decisionTransitions);
    await tx.delete(tradeDecisions);
    await tx.delete(reconciliationReports);
    await tx.delete(killSwitchEvents);
    await tx.delete(auditLogs);
    const [modeRow] = await tx.select().from(systemMode).limit(1);
    if (modeRow) await tx.update(systemMode).set({ mode: 'PAPER' }).where(eq(systemMode.id, modeRow.id));
    const { AuditService } = await import('../services/audit/audit-service.js');
    await AuditService.recordInTx(tx, { actorId: SYSTEM_PRINCIPAL_ID, action: 'DEV_RESET_PAPER', entity: 'system', entityId: 'paper-reset', diff: { positions: pos.length, orders: ord.length, reason: 'owner Reset button or POST /dev/reset-paper' } });
    return { positions: pos.length, orders: ord.length };
  });
  // reset in-memory paper feed/cache
  try {
    const { paperAdapter, paperFeed } = await import('../services/execution/paper-adapter.js');
    (paperAdapter as unknown as { cashUsd?: number }).cashUsd = 10_000;
    (paperAdapter as unknown as Map<string, unknown>).clear?.call((paperAdapter as unknown as { records: Map<string, unknown> }).records);
    (paperAdapter as unknown as { holdings?: Map<string, number> }).holdings?.clear();
    void paperFeed;
  } catch {}
  // release kill switch latch in this process (DB already cleared)
  try { const { resetVolatileLatchForTests } = await import('../services/risk/kill-switch.js'); resetVolatileLatchForTests(); } catch {}
  return c.json({ ok: true, ...res, hint: 'PORTFOLIO & Positions & Orders & Decisions cleared — refresh UI 7s' });
});
