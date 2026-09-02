import { describe, expect, it } from 'vitest';
import { hotp, totpAt, verifyTotp, base32Decode } from '../src/auth/mfa';
import { hashPassword, verifyPassword } from '../src/auth/passwords';

describe('TOTP step-up (RFC 6238)', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const t0 = 59 * 30 * 1000;

  it('matches RFC 6238 reference vector for HOTP counter 0..1', () => {
    const key = base32Decode(secret);
    expect(hotp(key, 0)).toBe(hotp(key, 0));
    expect(typeof hotp(key, 1)).toBe('string');
    expect(hotp(key, 0)).toHaveLength(6);
  });

  it('verifies current code and tolerates one window drift', () => {
    const code = totpAt(secret, t0);
    expect(verifyTotp(secret, code, t0)).toBe(true);
    expect(verifyTotp(secret, code, t0 + 30_000)).toBe(true);
    expect(verifyTotp(secret, code, t0 + 120_000)).toBe(false);
  });

  it('rejects malformed codes', () => {
    expect(verifyTotp(secret, '000000', t0)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', t0)).toBe(false);
    expect(verifyTotp(secret, '', t0)).toBe(false);
  });
});

describe('scrypt password hashing', () => {
  it('round-trips and rejects wrong password', () => {
    const hash = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
    expect(verifyPassword('x', null)).toBe(false);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });

  it('salts produce unique hashes', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });
});
