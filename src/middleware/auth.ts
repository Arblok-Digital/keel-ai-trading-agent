import { createHmac, timingSafeEqual } from 'node:crypto';
import { getCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import { verifyAccessToken } from '../auth/jwt.js';
import { verifyTotp } from '../auth/mfa.js';
import { getEnv } from '../config/env.js';
import { timeService } from '../services/ingestion/time-sync.js';

export interface Actor {
  id: string;
  role: 'owner' | 'viewer' | 'system_agent';
}

declare module 'hono' {
  interface ContextVariableMap {
    actor: Actor;
    rawBody: string;
  }
}

export const ACCESS_COOKIE = 'keel_at';
export const REFRESH_COOKIE = 'keel_rt';

export function cookieBase(c: Context) {
  void c;
  return {
    httpOnly: true,
    secure: getEnv().NODE_ENV === 'production',
    sameSite: 'Strict',
    path: '/',
  } as const;
}

export async function resolveActor(c: Context): Promise<Actor | null> {
  const token = getCookie(c, ACCESS_COOKIE);
  if (!token) return null;
  const claims = await verifyAccessToken(token);
  if (!claims) return null;
  return { id: claims.sub, role: claims.role };
}

export function requireRole(...allowed: Actor['role'][]): MiddlewareHandler {
  return async (c, next) => {
    const actor = await resolveActor(c);
    if (!actor) return c.json({ error: 'unauthenticated' }, 401);
    if (!allowed.includes(actor.role)) return c.json({ error: 'forbidden', required: allowed }, 403);
    c.set('actor', actor);
    await next();
  };
}

export function requireMfa(): MiddlewareHandler {
  return async (c, next) => {
    const code = c.req.header('x-mfa-code');
    const secret = getEnv().MFA_SECRET;
    if (!code || !secret) return c.json({ error: 'mfa_required' }, 403);
    if (!verifyTotp(secret, code, timeService.now())) {
      return c.json({ error: 'mfa_invalid' }, 403);
    }
    await next();
  };
}

export async function verifyInternalSignature(
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
): Promise<boolean> {
  const secret = getEnv().INTERNAL_HMAC_SECRET;
  if (!secret || !timestampHeader || !signatureHeader) return false;
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(timeService.now() - ts) > 30_000) return false;
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${timestampHeader}.${rawBody}`).digest('hex'),
    'hex',
  );
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHeader, 'hex');
  } catch {
    return false;
  }
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
