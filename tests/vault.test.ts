import { describe, expect, it, beforeEach } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  assertSpotOnlyScopes,
  scrubLogLine,
  installGlobalLogScrubber,
} from '../src/services/execution/vault';
import { computeAuditHash, canonicalJson, AuditService, verifyAuditRows } from '../src/services/audit/audit-service';
import { clientOrderIdFor } from '../src/services/execution/id-generator';
import { PaperAdapter, StaticPriceFeed } from '../src/services/execution/paper-adapter';
import { OrderTimeoutError } from '../src/services/execution/exchange-adapter';

describe('vault AES-256-GCM', () => {
  it('round-trips a secret', () => {
    const sealed = encryptSecret('my-super-secret-api-key-123');
    expect(sealed.ciphertext).not.toContain('my-super-secret');
    expect(decryptSecret(sealed)).toBe('my-super-secret-api-key-123');
  });

  it('produces unique ciphertexts per call (random IV)', () => {
    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe('spot-only scope gate', () => {
  it('rejects withdrawal/margin/transfer scopes', () => {
    const probe = assertSpotOnlyScopes(['spot', 'withdrawal']);
    expect(probe.valid).toBe(false);
    expect(probe.violations).toContain('withdrawal');
    expect(assertSpotOnlyScopes(['margin']).valid).toBe(false);
    expect(assertSpotOnlyScopes(['transfer']).valid).toBe(false);
  });

  it('accepts pure spot scopes and rejects empty', () => {
    expect(assertSpotOnlyScopes(['spot']).valid).toBe(true);
    expect(assertSpotOnlyScopes([]).valid).toBe(false);
  });
});

describe('log scrubber', () => {
  beforeEach(() => {
    installGlobalLogScrubber();
  });

  it('redacts registered secrets and API-key headers', () => {
    encryptSecret('SECRETVALUE123456');
    const out = scrubLogLine(`X-MBX-APIKEY: abc123 Authorization=Bearer xyz api_key="hunter2" sk-abcdefghijklmnop1234 SECRETVALUE123456`);
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('SECRETVALUE123456');
  });
});

describe('deterministic audit hash', () => {
  const base = {
    prevHash: null,
    actorId: '00000000-0000-0000-0000-00000000a001',
    action: 'MM_DECISION_PERSISTED',
    entity: 'trade_decisions',
    entityId: 'd-1',
    diff: { b: 2, a: 1 },
    createdAtIso: '2026-01-01T00:00:00.000Z',
  };

  it('is deterministic regardless of diff key order', () => {
    const other = { ...base, diff: { a: 1, b: 2 } };
    expect(computeAuditHash(base)).toBe(computeAuditHash(other));
  });

  it('changes when any payload component changes', () => {
    expect(computeAuditHash({ ...base, entityId: 'd-2' })).not.toBe(computeAuditHash(base));
    expect(computeAuditHash({ ...base, createdAtIso: '2026-01-02T00:00:00.000Z' })).not.toBe(computeAuditHash(base));
  });

  it('verifier detects tampered rows', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const row = {
      id: 'r1',
      actorId: base.actorId,
      action: base.action,
      entity: base.entity,
      entityId: base.entityId,
      diff: base.diff,
      hash: computeAuditHash(base),
      createdAt,
    };
    expect(verifyAuditRows([row])).toEqual([]);
    const tampered = { ...row, diff: { b: 2, a: 1, evil: true } };
    expect(verifyAuditRows([tampered])).toEqual(['r1']);
  });

  it('canonicalJson sorts nested objects', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
  });

  it('buildValues produces hash-consistent audit rows', () => {
    const values = AuditService.buildValues({
      actorId: base.actorId,
      action: base.action,
      entity: base.entity,
      entityId: base.entityId,
      diff: { k: 1 },
    });
    expect(values.hash).toHaveLength(64);
    expect(values.createdAt).toBeInstanceOf(Date);
  });
});

describe('idempotent paper execution semantics (US-04)', () => {
  it('fills at feed price plus slippage and records by clientOrderId', async () => {
    const adapter = new PaperAdapter(new StaticPriceFeed({ BTCUSDT: 60_000 }), 10_000);
    const report = await adapter.placeOrder({
      decisionId: 'd-1',
      clientOrderId: clientOrderIdFor('d-1'),
      venue: 'BINANCE_SPOT',
      symbol: 'BTCUSDT',
      side: 'BUY',
      qty: 0.01,
      quoteUsdEstimate: 600,
      slippageBps: 10,
    });
    expect(report.status).toBe('FILLED');
    expect(report.avgFillPrice).toBeCloseTo(60_000 * 1.001, 6);
    const queried = await adapter.queryByClientOrderId(clientOrderIdFor('d-1'));
    expect(queried?.status).toBe('FILLED');
  });

  it('rejects orders exceeding virtual cash', async () => {
    const adapter = new PaperAdapter(new StaticPriceFeed({ BTCUSDT: 60_000 }), 100);
    const report = await adapter.placeOrder({
      decisionId: 'd-2',
      clientOrderId: clientOrderIdFor('d-2'),
      venue: 'BINANCE_SPOT',
      symbol: 'BTCUSDT',
      side: 'BUY',
      qty: 1,
      quoteUsdEstimate: 60_000,
      slippageBps: 0,
    });
    expect(report.status).toBe('REJECTED');
  });

  it('simulates timeout then recovers via query-by-clientOrderId without duplicate order', async () => {
    const adapter = new PaperAdapter(new StaticPriceFeed({ BTCUSDT: 60_000 }));
    adapter.failNextWithTimeout = true;
    await expect(
      adapter.placeOrder({
        decisionId: 'd-3',
        clientOrderId: clientOrderIdFor('d-3'),
        venue: 'BINANCE_SPOT',
        symbol: 'BTCUSDT',
        side: 'BUY',
        qty: 0.01,
        quoteUsdEstimate: 600,
        slippageBps: 0,
      }),
    ).rejects.toBeInstanceOf(OrderTimeoutError);

    const recovered = await adapter.placeOrder({
      decisionId: 'd-3',
      clientOrderId: clientOrderIdFor('d-3'),
      venue: 'BINANCE_SPOT',
      symbol: 'BTCUSDT',
      side: 'BUY',
      qty: 0.01,
      quoteUsdEstimate: 600,
      slippageBps: 0,
    });
    expect(recovered.clientOrderId).toBe(clientOrderIdFor('d-3'));
    expect(recovered.status).toBe('FILLED');
  });
});
