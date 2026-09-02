import { randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { sessions } from '../../db/schema.js';
import { withActorContext } from '../db/actor.js';
import { timeService } from '../services/ingestion/time-sync.js';
import { getEnv } from '../config/env.js';
import { sql } from 'drizzle-orm';

const REFRESH_BYTES = 32;

export interface RefreshPair {
  sessionId: string;
  familyId: string;
  refreshToken: string;
  expiresAtMs: number;
}

export interface RotatedSession {
  userId: string;
  role: string;
  pair: RefreshPair;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function issueSession(userId: string): Promise<RefreshPair> {
  const refreshToken = randomBytes(REFRESH_BYTES).toString('base64url');
  const familyId = crypto.randomUUID();
  const ttlSec = getEnv().JWT_REFRESH_TTL_SEC;
  const expiresAtMs = timeService.now() + ttlSec * 1000;
  const row = await withActorContext(userId, async (tx) => {
    const [created] = await tx
      .insert(sessions)
      .values({
        userId,
        familyId,
        tokenHash: sha256Hex(refreshToken),
        expiresAt: new Date(expiresAtMs),
      })
      .returning();
    return created;
  });
  if (!row) throw new SessionError('session insert failed');
  return { sessionId: row.id, familyId, refreshToken, expiresAtMs };
}

export async function rotateSession(
  refreshToken: string,
): Promise<RotatedSession> {
  const tokenHash = sha256Hex(refreshToken);
  const nowMs = timeService.now();
  const ttlSec = getEnv().JWT_REFRESH_TTL_SEC;
  const newRefreshToken = randomBytes(REFRESH_BYTES).toString('base64url');
  const newExpiresAt = new Date(nowMs + ttlSec * 1000);
  const newTokenHash = sha256Hex(newRefreshToken);

  const result = await withActorContext('00000000-0000-0000-0000-00000000a001', async (tx) => {
    const rows = await tx.execute(
      sql`SELECT * FROM rotate_refresh_token(${tokenHash}, ${newTokenHash}, ${newExpiresAt})`,
    );
    const data = (rows as unknown as { rows?: Array<{ user_id: string; role: string }> }).rows ?? [];
    const row = data[0];
    if (!row) throw new SessionError('rotate_refresh_token failed');
    return {
      userId: row.user_id,
      role: row.role,
      pair: {
        sessionId: '',
        familyId: '',
        refreshToken: newRefreshToken,
        expiresAtMs: nowMs + ttlSec * 1000,
      },
    };
  });

  if (!result) throw new SessionError('rotate_refresh_token returned no rows');
  return result;
}

export async function revokeFamily(familyId: string, userId: string): Promise<void> {
  await withActorContext(userId, async (tx) => {
    await tx
      .update(sessions)
      .set({ revokedAt: new Date(timeService.now()) })
      .where(eq(sessions.familyId, familyId));
  });
}

export class SessionError extends Error {}
