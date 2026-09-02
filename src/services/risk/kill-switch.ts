import { desc, eq } from 'drizzle-orm';
import { killSwitchEvents } from '../../../db/schema.js';
import { SYSTEM_PRINCIPAL_ID, withActorContext, type ActorTx } from '../../db/actor.js';
import { agentEvents } from '../events.js';
import { telegram } from '../notifications/telegram.js';
import { timeService } from '../ingestion/time-sync.js';

let volatileLatch = false;

export async function isKillSwitchActiveTx(tx: ActorTx): Promise<boolean> {
  if (volatileLatch) return true;
  const [latest] = await tx
    .select()
    .from(killSwitchEvents)
    .orderBy(desc(killSwitchEvents.createdAt))
    .limit(1);
  return latest?.isActive ?? false;
}

export interface EngageResult {
  eventId: string;
  cancelledOrdersCount: number;
}

export async function engageKillSwitch(params: {
  actorId: string;
  reason: string;
  cancelFn?: () => Promise<number>;
}): Promise<EngageResult> {
  volatileLatch = true;
  const eventId = await withActorContext(params.actorId, async (tx) => {
    const [event] = await tx
      .insert(killSwitchEvents)
      .values({ triggeredBy: params.actorId, reason: params.reason, isActive: true })
      .returning();
    return event;
  });
  let cancelled = 0;
  if (params.cancelFn) {
    try {
      cancelled = await params.cancelFn();
    } catch (err) {
      console.error('[kill-switch] cancelAll failed:', err instanceof Error ? err.message : err);
    }
  }
  agentEvents.publish('kill-switch', { reason: params.reason, cancelledOrdersCount: cancelled });
  void telegram.alert('kill-switch', `KILL SWITCH ENGAGED: ${params.reason}`, timeService.now());
  return { eventId: eventId?.id ?? '', cancelledOrdersCount: cancelled };
}

export async function disengageKillSwitch(ownerId: string): Promise<string> {
  const eventId = await withActorContext(ownerId, async (tx) => {
    const [event] = await tx
      .insert(killSwitchEvents)
      .values({ triggeredBy: ownerId, reason: 'manual disengage by owner', isActive: false })
      .returning();
    return event;
  });
  volatileLatch = false;
  telegram.resolveIncident('kill-switch');
  agentEvents.publish('kill-switch-release', {});
  return eventId?.id ?? '';
}

export async function loadLatestEvents(limit = 20): Promise<Array<typeof killSwitchEvents.$inferSelect>> {
  return withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
    tx.select().from(killSwitchEvents).orderBy(desc(killSwitchEvents.createdAt)).limit(limit),
  );
}

export function resetVolatileLatchForTests(): void {
  volatileLatch = false;
}

export async function findEventById(id: string): Promise<typeof killSwitchEvents.$inferSelect | undefined> {
  return withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
    tx.select().from(killSwitchEvents).where(eq(killSwitchEvents.id, id)).limit(1).then((rows) => rows[0]),
  );
}
