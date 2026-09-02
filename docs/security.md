# Security Model — ai-trading-agent

## 1. Roles & Permissions Matrix

| Capability Area | `owner` | `viewer` | `system_agent` |
| :--- | :--- | :--- | :--- |
| Exchange Key Management (Vault) | ALLOW | DENY | DENY (Read Decrypted In-Memory Only) |
| Execution Mode Toggle (Paper / Live) | ALLOW | DENY | DENY |
| Kill Switch Trigger / Cancel All | ALLOW | DENY | ALLOW (Automated Risk Breach) |
| Decision Log View (`trade_decisions`) | ALLOW | ALLOW | ALLOW |
| Decision Insertion (`trade_decisions`) | DENY | DENY | ALLOW |
| Order Execution (`orders`) | DENY | DENY | ALLOW |
| Balance Reconciliation View/Run | ALLOW | ALLOW (Read) | ALLOW (Write / Execute) |
| Early Detection Tokens View | ALLOW | ALLOW | ALLOW (Write / Ingest) |
| Audit Trail Inspection (`audit_logs`)| ALLOW | DENY | ALLOW (Write) |

## 2. Authentication

- **Human Principals (`owner`, `viewer`)**: Session tokens issued as EdDSA (Ed25519) signed JWTs delivered via `Secure`, `HttpOnly`, `SameSite=Strict` cookies. Access token TTL: 15 minutes; sliding refresh token TTL: 7 days with automatic reuse revocation. Mandatory FIDO2 / WebAuthn TOTP challenge on `owner` credential mutation and live execution toggles.
- **Service Principal (`system_agent`)**: Ephemeral, mutual TLS (mTLS) worker authentication combined with HMAC-SHA256 signed internal execution nonces verified on every database transaction.
- **Credential Storage**: Exchange API secrets encrypted at rest using AES-256-GCM with keys managed in environment envelope storage; never written to disk, database plaintext, or telemetry streams.

## 3. Authorization Enforcement

- **Database RLS (`db/rls.sql`)**: Row-Level Security checks `app.current_user_role` against PostgreSQL session variables on every query.
  - `trade_decisions`, `audit_logs`, `reconciliation_reports`: Append-only (`FOR INSERT` granted strictly to `system_agent`; `UPDATE` and `DELETE` denied to all roles).
  - `orders`, `positions`: Insert/Update restricted to `system_agent`. Read allowed for `owner` and `viewer`.
  - `early_detection_tokens`: Read allowed for all authenticated roles; mutation locked to `system_agent`.
- **API Guard Middleware (`contracts/openapi.yaml`)**:
  - `/api/v1/system/*`: Guarded by `requireRole('owner')`. Emergency `/kill-switch` also permits `system_agent` context.
  - `/api/v1/decisions`, `/api/v1/system/reconciliation`, `/api/v1/tokens`: Guarded by `requireRole('viewer', 'owner', 'system_agent')`.
  - Ingestion and Order execution webhooks rejected if principal is not `system_agent`.

## 3.1 Kill Switch Semantics per Venue

| Venue | Kill Switch Effect |
| :--- | :--- |
| Binance Spot | Halts new dispatch AND cancels all resting open orders via `DELETE /api/v3/openOrders`. |
| Uniswap V3 | Halts new dispatch only. Committed on-chain swaps are immutable; no cancellation path exists. |
| Raydium | Halts new dispatch only. Committed on-chain swaps are immutable; no cancellation path exists. |

The owner expectation is explicit: engaging the kill switch guarantees zero *new* order dispatch across all venues within <500ms, plus CEX order cancellation. It cannot revert already-submitted DEX transactions.

## 4. Input & Abuse Controls

- **Runtime Schema Validation**: All Hono API endpoints and worker inputs strictly validated via `drizzle-zod` derived schemas. Unrecognized properties stripped, requests failing validation return `422 Unprocessable Entity`.
- **Rate Limits (Token Bucket per IP / Actor)**:
  - `/api/v1/tokens/early-feed`: 60 requests/min.
  - `/api/v1/system/mode`: 5 requests/min (requires MFA header).
  - `/api/v1/system/kill-switch`: 30 requests/min (never rate-limited for emergency cancellations).
- **Payload Constraints**: Maximum JSON body size capped at 32 KB across all REST endpoints.

## 5. Threat Checklist

| # | Domain-Specific Threat | Mitigation Strategy | Owning Layer |
| :- | :--- | :--- | :--- |
| 1 | **Unauthorized Withdrawal Scope**: API key uploaded with transfer/withdrawal permissions. | Zero-trust validation probe upon key entry; API client rejects keys possessing non-spot permissions. | Ingestion / Vault Adapter |
| 2 | **Concurrent Position Cap Breach**: Race condition attempting >5 concurrent positions. | Pessimistic locking (`SELECT ... FOR UPDATE` on risk row) before decision persistence in `db/schema.ts`. | Pre-Trade Risk Gatekeeper |
| 3 | **Stale Market Data Exploitation**: Processing out-of-order ticks during network congestion. | Clock synchronization against Binance `/api/v3/time`; discard ticks with staleness >1500ms. | Market Ingestion Layer |
| 4 | **Orphan Orders / Duplicate Fills**: Placement timeout causes retries that create duplicate orders. | Deterministic `clientOrderId` derived from decision UUID; mandatory exchange query before retry. | Execution Adapter Layer |
| 5 | **Balance Desynchronization**: Unreported slippage or phantom fills causing internal drift. | Continuous 15-second reconciliation loop comparing DB state to CEX/DEX; mismatch halts trading. | Safety Supervisor |
| 6 | **Credential Leakage in Logs**: Exchange API keys dumped during debugging or error traces. | Global sanitization middleware scrubbing headers and payloads matching key signatures before logging. | Control Plane / Logger |
| 7 | **Unauthorized Live Mode Trigger**: Viewer session hijack attempting real capital deployment. | WebAuthn step-up authentication required to transition execution mode from paper to live. | Hono API Auth Layer |
