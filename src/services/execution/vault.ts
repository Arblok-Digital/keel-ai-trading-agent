import { createCipheriv, createDecipheriv, createHash, createHmac, createSecretKey, randomBytes } from 'node:crypto';
import { getEnv } from '../../config/env.js';
import { FORBIDDEN_KEY_SCOPES } from '../../config/risk-constants.js';

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

const registeredSecrets = new Set<string>();

function masterKey(): Buffer {
  const raw = getEnv().VAULT_MASTER_KEY;
  if (!raw) throw new Error('VAULT_MASTER_KEY not configured');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('VAULT_MASTER_KEY must decode to 32 bytes');
  return key;
}

export function encryptSecret(plaintext: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  registeredSecrets.add(plaintext);
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), authTag: authTag.toString('base64') };
}

export function decryptSecret(sealed: SealedSecret): string {
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  registeredSecrets.add(plain);
  return plain;
}

export function keyFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

export interface ScopeProbe {
  valid: boolean;
  violations: string[];
}

export function assertSpotOnlyScopes(scopes: string[]): ScopeProbe {
  const normalized = scopes.map((s) => s.toLowerCase());
  const violations = normalized.filter((s) => (FORBIDDEN_KEY_SCOPES as readonly string[]).includes(s));
  return { valid: violations.length === 0 && normalized.length > 0, violations };
}

const SCRUB_PATTERNS: RegExp[] = [
  /(X-MBX-APIKEY|X-API-KEY|Authorization)\s*[:=]\s*\S+/gi,
  /api[_-]?[Kk]ey["']?\s*[:=]\s*["'][^"']+["']/g,
  /api[_-]?[Ss]ecret["']?\s*[:=]\s*["'][^"']+["']/g,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
];

export function scrubLogLine(line: string): string {
  let out = line;
  for (const secret of registeredSecrets) {
    if (secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  }
  for (const pattern of SCRUB_PATTERNS) {
    out = out.replace(pattern, (match, g1: string | undefined, offset: number, str: string, _groups: unknown) => {
      if (g1 !== undefined && typeof g1 === 'string' && str.includes(g1)) return `${g1}=[REDACTED]`;
      return '[REDACTED]';
    });
  }
  return out;
}

let installed = false;

export function installGlobalLogScrubber(): void {
  if (installed) return;
  installed = true;
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    const original = console[method].bind(console);
    Object.defineProperty(console, method, {
      value: (...args: unknown[]) => {
        original(...args.map((a) => (typeof a === 'string' ? scrubLogLine(a) : a)));
      },
      writable: true,
      configurable: true,
    });
  }
}

export function hmacSha256Hex(secretKey: string | Buffer, payload: string): string {
  return createHmac('sha256', createSecretKey(typeof secretKey === 'string' ? Buffer.from(secretKey) : secretKey))
    .update(payload)
    .digest('hex');
}

interface SealedCredentialRow {
  ciphertext: string;
  iv: string;
  auth_tag: string;
  scopes: string[];
}

export async function loadExchangeCredentials(
  venue: string,
): Promise<{ apiKey: string; apiSecret: string; scopes: string[] }> {
  const { withActorContext } = await import('../../db/actor.js');
  const { sql } = await import('drizzle-orm');

  const rows = await withActorContext('00000000-0000-0000-0000-00000000a001', (tx) =>
    tx.execute(sql`SELECT * FROM get_credential_ciphertext(${venue})`),
  );
  const list = (rows as unknown as { rows?: SealedCredentialRow[] }).rows ?? [];
  const first = list[0];
  if (!first) throw new Error(`no ${venue} credential stored`);
  const parsed = JSON.parse(
    decryptSecret({ ciphertext: first.ciphertext, iv: first.iv, authTag: first.auth_tag }),
  ) as { apiKey: string; apiSecret: string };
  return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret, scopes: first.scopes };
}
