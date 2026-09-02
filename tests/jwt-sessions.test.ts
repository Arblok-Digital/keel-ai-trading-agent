import { describe, expect, it } from 'vitest';
import { signAccessToken, verifyAccessToken } from '../src/auth/jwt';

describe('JWT Ed25519 access tokens', () => {
  it('signs and verifies claims', async () => {
    const token = await signAccessToken({ sub: 'user-1', role: 'owner' }, 60);
    const claims = await verifyAccessToken(token);
    expect(claims?.sub).toBe('user-1');
    expect(claims?.role).toBe('owner');
    expect(token.split('.')).toHaveLength(3);
  });

  it('rejects tampered tokens', async () => {
    const token = await signAccessToken({ sub: 'user-1', role: 'viewer' }, 60);
    const parts = token.split('.');
    parts[2] = `${parts[2]}x`;
    expect(await verifyAccessToken(parts.join('.'))).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const token = await signAccessToken({ sub: 'user-1', role: 'system_agent' }, -10);
    expect(await verifyAccessToken(token)).toBeNull();
  });

  it('rejects garbage input', async () => {
    expect(await verifyAccessToken('not-a-jwt')).toBeNull();
    expect(await verifyAccessToken('')).toBeNull();
  });
});
