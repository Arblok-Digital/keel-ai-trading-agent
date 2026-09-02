# Audit Trail Design — ai-trading-agent

## 1. AUDITED EVENTS

All authentication events, risk-rule mutations, decision commits, and execution state transitions must emit structured audit events.

| Event Name | Trigger / Endpoint / Story | Actor | Payload Fields (`diff` JSON) |
|---|---|---|---|
| `CREDENTIALS_ROTATED` | `POST /api/v1/system/credentials` (`US-01`) | `owner` | `venue`, `keyFingerprint`, `permissionsValidated` |
| `TRADING_MODE_CHANGED` | `POST /api/v1/system/mode` (`US-01`) | `owner` | `previousMode`, `newMode`, `reason` |
| `MM_DECISION_PERSISTED` | Signal Pipeline (`US-02`) | `system_agent` | `decisionId`, `symbol`, `action`, `mmThesis`, `mtfBias` |
| `RISK_LIMIT_RESERVED` | Risk Gate (`US-03`) | `system_agent` | `decisionId`, `slotId`, `currentOpenPositions`, `hourlyOrderCount` |
| `ORDER_DISPATCHED` | `POST /api/v1/decisions/{id}/execute` (`US-04`) | `system_agent` | `clientOrderId`, `decisionId`, `symbol`, `requestedQty`, `serverTime` |
| `ORDER_RECONCILED` | Execution Poller (`US-04`) | `system_agent` | `clientOrderId`, `previousStatus`, `terminalStatus`, `executedQty` |
| `KILL_SWITCH_ENGAGED` | `POST /api/v1/system/kill-switch` (`US-05`) | `owner` / `system_agent` | `reason`, `cancelledOrdersCount`, `openPositionsClosed` |
| `RECONCILIATION_BREACH` | Sync Worker (`US-06`) | `system_agent` | `localBalanceUsd`, `exchangeBalanceUsd`, `discrepancyUsd` |
| `STALENESS_REJECTION` | Ingestion Pipeline (`US-07`) | `system_agent` | `symbol`, `venue`, `latencyMs`, `stalenessLimitMs` |

---

## 2. STORAGE

Audit logs are stored in the append-only `audit_logs` table defined in `db/schema.ts`:

- **Table**: `audit_logs` (`id`, `actor_id`, `action`, `entity`, `entity_id`, `diff`, `created_at`).
- **Permission Model**: Defined in `db/rls.sql`. PostgreSQL grants allow `INSERT` and `SELECT` only.
- **Strict Immutability**: `UPDATE`, `DELETE`, and `TRUNCATE` privileges are revoked from all database roles (`PUBLIC`, `authenticated`, `system_agent`, and `owner`). Any mutation attempt triggers a database-level fatal exception.

---

## 3. WRITE PATH

Audit entries must be persisted within the exact same database transaction boundary as the state-changing operation:

```typescript
// Shared transaction write pattern
await db.transaction(async (tx) => {
  // 1. Mutate primary domain entity (e.g., tradeDecisions, orders, positions)
  const [decision] = await tx.insert(tradeDecisions).values(decisionData).returning();

  // 2. Write immutable audit log within the same transactional boundary
  await auditService.recordInTx(tx, {
    actorId: ctx.actor.id,
    action: 'MM_DECISION_PERSISTED',
    entity: 'trade_decisions',
    entityId: decision.id,
    diff: {
      symbol: decision.symbol,
      action: decision.action,
      mmThesis: decision.mmThesis,
      riskPassed: decision.riskPassed,
    },
  });
});
```

- **Service Layer Function**: `AuditService.recordInTx(tx: PgTransaction, params: AuditRecordParams)`.
- **Atomic Failure Guarantee**: If the domain write fails, the audit entry rolls back. If the audit entry fails, the domain state mutation rolls back. Zero execution occurs without an audit write.

---

## 4. RETENTION & ACCESS

- **Access Control**:
  - `owner`: Read-only access to audit logs via `contracts/openapi.yaml` and monitoring UI.
  - `viewer`: Read-only access to non-sensitive execution history (`trade_decisions`, `orders`, `reconciliation_reports`).
  - `system_agent`: Insert-only access to `audit_logs`; no read or update capabilities.
- **Retention Period**: Online operational retention in PostgreSQL is 7 years (2,555 days) to meet financial compliance and audit standards.
- **Cold Archival**: Automated monthly worker exports records older than 90 days to encrypted AWS S3 buckets configured with Object Lock (WORM compliance mode).

---

## 5. TAMPER-EVIDENCE

Tamper-evident verification guarantees cryptographic audit integrity across distributed execution nodes:

1. **Deterministic Hashes**: Every audit row includes a SHA-256 digest calculated over `(actor_id || action || entity || entity_id || canonical_json(diff) || created_at)`.
2. **Database Trigger Guard**: A PostgreSQL `BEFORE UPDATE OR DELETE` trigger on `audit_logs` raises an uncatchable exception (`RAISE EXCEPTION 'audit_logs is append-only'`), blocking manual tampering by database superusers.
3. **Continuous Cryptographic Verification**: A scheduled audit job recalculates hash chains sequentially. Any discrepancy between computed and stored hashes triggers an immediate system lockdown and engages the kill switch (`US-05`).
