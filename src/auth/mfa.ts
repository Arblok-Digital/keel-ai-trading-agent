import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secretBytes: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secretBytes).update(buf).digest();
  const lastByte = hmac[hmac.length - 1];
  if (lastByte === undefined) return '0'.repeat(digits);
  const offset = lastByte & 0xf;
  const p1 = ((hmac[offset] as number | undefined ?? 0) & 0x7f) << 24;
  const p2 = (hmac[offset + 1] as number | undefined ?? 0) << 16;
  const p3 = (hmac[offset + 2] as number | undefined ?? 0) << 8;
  const p4 = hmac[offset + 3] as number | undefined ?? 0;
  const code = p1 | p2 | p3 | p4;
  return (code % 10 ** digits).toString().padStart(digits, '0');
}

export function totpAt(secretBase32: string, timeMs: number, stepSec = 30, digits = 6): string {
  const counter = Math.floor(timeMs / 1000 / stepSec);
  return hotp(base32Decode(secretBase32), counter, digits);
}

export function verifyTotp(
  secretBase32: string,
  code: string,
  timeMs: number,
  windowSteps = 1,
  stepSec = 30,
): boolean {
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(timeMs / 1000 / stepSec);
  for (let drift = -windowSteps; drift <= windowSteps; drift++) {
    if (hotp(secret, counter + drift, 6) === code.trim()) return true;
  }
  return false;
}
