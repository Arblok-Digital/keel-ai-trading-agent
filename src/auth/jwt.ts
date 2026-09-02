import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, jwtVerify, exportSPKI, exportPKCS8, importSPKI, importPKCS8 } from 'jose';
import type { Role } from '../../db/schema.js';
import { getEnv } from '../config/env.js';

export interface AccessClaims {
  sub: string;
  role: Role;
}

let privateKeyPem: string | undefined;
let publicKeyPem: string | undefined;

async function loadKeys(): Promise<{ priv: string; pub: string }> {
  if (privateKeyPem && publicKeyPem) return { priv: privateKeyPem, pub: publicKeyPem };
  const env = getEnv();
  if (env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY) {
    privateKeyPem = Buffer.from(env.JWT_PRIVATE_KEY, 'base64').toString('utf8');
    publicKeyPem = Buffer.from(env.JWT_PUBLIC_KEY, 'base64').toString('utf8');
    return { priv: privateKeyPem, pub: publicKeyPem };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const priv = await exportPKCS8(privateKey);
  const pub = await exportSPKI(publicKey);
  privateKeyPem = priv;
  publicKeyPem = pub;
  return { priv, pub };
}

export async function signAccessToken(claims: AccessClaims, ttlSec: number): Promise<string> {
  const { priv } = await loadKeys();
  const key = await importPKCS8(priv, 'EdDSA');
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  const { pub } = await loadKeys();
  try {
    const key = await importSPKI(pub, 'EdDSA');
    const { payload } = await jwtVerify(token, key, { algorithms: ['EdDSA'] });
    if (!payload.sub || typeof payload.role !== 'string') return null;
    return { sub: payload.sub, role: payload.role as Role };
  } catch {
    return null;
  }
}
