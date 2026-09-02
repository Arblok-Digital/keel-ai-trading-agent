# CONSTITUTION: AI-TRADING-AGENT

## 1. CONTRACT-FIRST SCHEMA & STRICT TYPE DISCIPLINE
All domain structures—tokens, signals, decisions, orders, and positions—originate in the Drizzle ORM schema. Runtime validation across Hono routes, worker jobs, and exchange payloads must derive directly from Drizzle tables via `drizzle-zod`. Direct hand-written type overrides or untyped `any` castings are strictly prohibited; schema drift between the database and the execution engine fails the build immediately.

## 2. PERSIST-BEFORE-EXECUTE & DETERMINISTIC AUDIT TRAIL
Every autonomous action requires an append-only decision record containing market maker thesis, multi-timeframe confluence scores, and risk parameters committed to Postgres *before* hitting any exchange adapter. Every order MUST carry a deterministic `clientOrderId` directly derived from the decision UUID. If an order placement times out, the engine must query the exchange for that `clientOrderId` prior to retrying, and every decision must transition to a terminal state (`filled`, `rejected`, `failed`) even during network degradation.

## 3. MANDATORY PRE-TRADE RISK LIMITS & HARD FAIL-SAFE
No order can reach the exchange adapter without passing the synchronous, zero-bypass risk evaluator: spot-only check, max 5 open positions, max 10 orders per hour, 2-5% position size, per-trade -2% SL, and max 3% daily drawdown. If the kill switch is triggered or daily drawdown hits 3%, all active limit orders cancel immediately and order generation halts. All timing logic must synchronize against the exchange server-time endpoint; relying on local system clocks for execution timing or staleness checks (>1500ms data staleness) is strictly forbidden.

## 4. LEAST-PRIVILEGE CREDENTIAL VAULT & DATABASE RLS
Exchange API keys and private keys must be encrypted at rest (AES-256-GCM), decrypted only in-memory within worker execution contexts, and scrubbed from all application logs and telemetry. API keys must enforce spot trading permissions only; any key possessing withdrawal or margin permissions must trigger an immediate validation failure and agent lockdown. PostgreSQL Row-Level Security (RLS) and Hono middleware enforce RBAC (`owner`, `viewer`, and `system_agent`) defaulting to deny-all.

## 5. CONTINUOUS RECONCILIATION & IDEMPOTENT SYNC
The worker process must run continuous reconciliation intervals comparing database positions and balances against exchange balances and DEX pool states. Any unresolvable discrepancy between local ledger state and exchange state halts trading operations instantly and broadcasts a high-priority alert. Order state transitions are unidirectional: `pending` → `partially_filled` → `filled` / `rejected` / `cancelled`.

## 6. MARKET-MAKER REASONING VALIDATION
Signal evaluation must reject retail-default naked technical indicators. Every signal payload must explicitly populate liquidity pool depth, smart-money flow shift, and multi-timeframe bias (M15/H1/H4/D1). Conflicting timeframes or missing institutional liquidity hypotheses invalidate the signal at schema validation and are logged as discarded candidates.
