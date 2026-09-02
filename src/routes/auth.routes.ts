import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { sessions } from '../../db/schema.js';
import { verifyPassword } from '../auth/passwords.js';
import { signAccessToken } from '../auth/jwt.js';
import { issueSession, rotateSession, revokeFamily, SessionError } from '../auth/sessions.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieBase } from '../middleware/auth.js';
import { validateBody, validatedBody, bodyLimit } from '../middleware/validation.js';
import { getEnv } from '../config/env.js';
import { SYSTEM_PRINCIPAL_ID, withActorContext } from '../db/actor.js';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });

interface LoginRow {
  id: string;
  password_hash: string | null;
  role: string | null;
}

type Role = 'owner' | 'viewer' | 'system_agent';

async function lookupCredentials(email: string): Promise<LoginRow | null> {
  const result = await withActorContext(SYSTEM_PRINCIPAL_ID, (tx) =>
    tx.execute(sql`SELECT * FROM lookup_user_credentials(${email})`),
  );
  const rows = (result as unknown as { rows?: LoginRow[] }).rows ?? [];
  return rows[0] ?? null;
}

function roleOf(role: string | null): Role {
  if (role === 'owner' || role === 'system_agent') return role;
  return 'viewer';
}

export const authRoutes = new Hono();

authRoutes.get('/me', async (c) => {
  const { resolveActor } = await import('../middleware/auth.js');
  const actor = await resolveActor(c);
  if (!actor) return c.json({ error: 'unauthenticated' }, 401);
  return c.json({ role: actor.role, id: actor.id });
});

authRoutes.use('/login', bodyLimit());
authRoutes.post(
  '/login',
  validateBody(loginSchema),
  async (c) => {
    const { email, password } = validatedBody<{ email: string; password: string }>(c);
    const user = await lookupCredentials(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return c.json({ error: 'invalid_credentials' }, 401);
    }
    const access = await signAccessToken({ sub: user.id, role: roleOf(user.role) }, getEnv().JWT_ACCESS_TTL_SEC);
    const pair = await issueSession(user.id);
    setCookie(c, ACCESS_COOKIE, access, cookieBase(c));
    setCookie(c, REFRESH_COOKIE, pair.refreshToken, { ...cookieBase(c), expires: new Date(pair.expiresAtMs) });
    return c.json({ ok: true, role: roleOf(user.role) });
  },
);

authRoutes.post('/refresh', async (c) => {
  const refreshToken = getCookie(c, REFRESH_COOKIE);
  if (!refreshToken) return c.json({ error: 'missing_refresh_token' }, 401);
  try {
    const rotated = await rotateSession(refreshToken);
    const access = await signAccessToken(
      { sub: rotated.userId, role: roleOf(rotated.role) },
      getEnv().JWT_ACCESS_TTL_SEC,
    );
    setCookie(c, ACCESS_COOKIE, access, cookieBase(c));
    setCookie(c, REFRESH_COOKIE, rotated.pair.refreshToken, {
      ...cookieBase(c),
      expires: new Date(rotated.pair.expiresAtMs),
    });
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof SessionError) return c.json({ error: err.message }, 401);
    throw err;
  }
});

authRoutes.post('/logout', async (c) => {
  const refreshToken = getCookie(c, REFRESH_COOKIE);
  if (refreshToken) {
    const hash = createHash('sha256').update(refreshToken).digest('hex');
    try {
      const family = await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
        const [row] = await tx.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.tokenHash, hash));
        return row?.familyId ?? null;
      });
      const ownerUserId = family
        ? await withActorContext(SYSTEM_PRINCIPAL_ID, async (tx) => {
            const [row] = await tx.select({ userId: sessions.userId }).from(sessions).where(eq(sessions.familyId, family));
            return row?.userId ?? null;
          })
        : null;
      if (family && ownerUserId) await revokeFamily(family, ownerUserId);
    } catch {
      /* already revoked */
    }
  }
  deleteCookie(c, ACCESS_COOKIE, { path: '/' });
  deleteCookie(c, REFRESH_COOKIE, { path: '/' });
  return c.json({ ok: true });
});
