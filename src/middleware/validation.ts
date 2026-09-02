import type { Context, MiddlewareHandler } from 'hono';
import type { ZodTypeAny } from 'zod';
import type { Actor } from './auth.js';

declare module 'hono' {
  interface ContextVariableMap {
    actor: Actor;
    rawBody: string;
    validatedBody: unknown;
  }
}

export function bodyLimit(maxBytes = 32 * 1024): MiddlewareHandler {
  return async (c, next) => {
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > maxBytes) return c.json({ error: 'payload_too_large' }, 413);
    await next();
  };
}

export function validateBody<T extends ZodTypeAny>(schema: T): MiddlewareHandler {
  return async (c: Context, next) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: 'validation_failed', issues: parsed.error.issues }, 422);
    }
    c.set('validatedBody', parsed.data as never);
    await next();
  };
}

export function validatedBody<T>(c: Context): T {
  return c.get('validatedBody') as T;
}
