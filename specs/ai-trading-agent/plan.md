# Architecture Document — ai-trading-agent

## 1. System Layers (Hulu-to-Hilir Data Flow)

1. **Market Data & Ingestion Layer**
   - **Responsibility**: Ingest real-time CEX order books/trades (Binance WS/REST) and DEX pool states/swaps (RPC/indexer). Synchronizes against exchange server-time and discards payloads with staleness >1500ms.
   - **Technology**: Node.js WebSocket, Viem/Ethers (EVM RPC), Exchange Server-Time Sync Worker.
   - **Downstream Contract**: `MarketSnapshotEvent` & `DEXPoolUpdateEvent` containing normalized liquidity depth, taker volume, and exchange-synchronized timestamps.

2. **Market Maker Intelligence & Signal Engine**
   - **Responsibility**: Evaluates multi-timeframe confluence (M15/H1/H4/D1), smart-money accumulation/distribution, and resting liquidity pools. Rejects retail-default naked indicators without an explicit MM thesis.
   - **Technology**: Pure TypeScript domain logic, Zod validation contracts.
   - **Downstream Contract**: `MMValidatedSignal` containing composite early score, institutional liquidity thesis, MTF alignment vector, proposed entry, SL (-2%), and TP (+4%).

3. **Risk Gatekeeper & Decision Audit Layer**
   - **Responsibility**: Synchronous zero-bypass risk evaluation (3% daily drawdown, max 5 positions, max 10 orders/hour, 2-5% size, kill switch status). Commits decision to append-only log in Postgres before execution.
   - **Technology**: PostgreSQL 16 (Row-Level Locking `FOR UPDATE`), Drizzle ORM, Drizzle-Zod.
   - **Downstream Contract**: `PersistedTradeDecision` carrying an immutable decision UUID, deterministic `clientOrderId`, and exact risk parameters.

4. **Execution & Idempotent Adapter Layer**
   - **Responsibility**: Spot-only order placement across CEX/DEX. Enforces deterministic `clientOrderId`, performs pre-retry queries on placement timeouts, and drives unidirectional state transitions (`pending` → `filled`/`rejected`).
   - **Technology**: Spot Exchange REST Adapters, DEX Router Swaps, AES-256-GCM in-memory decryptor.
   - **Downstream Contract**: `OrderExecutionReport` and `PositionStateUpdate` emitted to the internal event bus and persistence ledger.

5. **Continuous Reconciliation & Safety Supervisor**
   - **Responsibility**: Runs 15-second reconciliation loops matching database ledgers against exchange balances and DEX positions. Halts all trading and fires Telegram alerts upon any detected balance mismatch.
   - **Technology**: Cron/Interval Worker, Telegram Bot API client.
   - **Downstream Contract**: `ReconciliationAlert` and automated `KillSwitchTriggerEvent`.

6. **Control Plane & Edge API Layer**
   - **Responsibility**: Exposes RBAC-guarded REST and WebSocket endpoints for dashboard monitoring, manual kill switch toggling, key management, and paper/live mode switching.
   - **Technology**: Hono API framework, Drizzle ORM (PostgreSQL RLS), JWT/Cookie RBAC middleware.
   - **Downstream Contract**: JSON API responses and WebSocket streams consumed by Owner/Viewer frontends.

---

## 2. Layer Deep Dive & Key Architectural Decisions

### Layer 1: Market Data & Ingestion Layer
- **Exchange-Derived Timestamp Sync**: Derived from Binance `/api/v3/time` and block headers; local machine time is never trusted for order triggers or data validity (US-07).
  *Rationale*: Prevents timing drift and execution on out-of-order market data during volatility spikes.
- **Dual-Market Feed Normalization**: Unifies CEX depth ladders with DEX liquidity curves into a single standardized depth format.
  *Rationale*: Allows identical market maker liquidity scoring across both CEX spot pairs and newly launched DEX pools.

### Layer 2: MM Intelligence & Signal Engine
- **Contract-Enforced MM Thesis**: Discards any technical signal lacking smart-money tracking and MTF confluence across M15, H1, H4, and D1 (US-02, US-08).
  *Rationale*: Prevents retail stop-hunt traps and guarantees all orders trade alongside institutional accumulation.
- **Composite Early Detection Scoring**: Ranks tokens on money flow acceleration and narrative velocity before breakout confirmation (US-08).
  *Rationale*: Secures advantageous spot positioning before retail momentum causes slippage.

### Layer 3: Risk Gatekeeper & Decision Audit Layer
- **Persist-Before-Execute Principle**: An immutable decision record must be written to PostgreSQL prior to dispatching any network request to an exchange (US-02).
  *Rationale*: Guarantees a 100% auditable record of all autonomous reasoning, even if hardware or network fails mid-trade.
- **Pessimistic Row-Locking Pre-Trade Checks**: Uses `SELECT ... FOR UPDATE` on the risk singleton row to check drawdown and order rate limits (US-03).
  *Rationale*: Eliminates race conditions across concurrent worker threads attempting to exceed position or rate caps.

### Layer 4: Execution & Idempotent Adapter Layer
- **Deterministic `clientOrderId` Derivation**: Formed as `cID-${decision.uuid}` to ensure 1:1 mapping with the audit record (US-04).
  *Rationale*: Allows immediate idempotent lookup on the exchange if a socket drops or an HTTP timeout occurs.
- **Spot-Only Least-Privilege Gate**: Decrypts API credentials in memory via AES-256-GCM and verifies that withdrawal/margin permissions are absent (US-01).
  *Rationale*: Guarantees zero risk of capital drain or unintended leveraged liquidation.

### Layer 5: Continuous Reconciliation & Safety Supervisor
- **15-Second Ledger Reconciliation Loop**: Compares DB positions and free balances with live exchange balances every 15 seconds (US-06).
  *Rationale*: Detects unauthorized external activity, fees drift, or orphan fills, triggering an immediate fail-safe halt.
- **Global Instant Kill Switch**: Atomic database toggle canceling all active orders and halting further worker dispatch within <500ms (US-05).
  *Rationale*: Provides immediate risk cut-off during extreme market anomalies or exchange downtime.

### Layer 6: Control Plane & Edge API Layer
- **Role-Based Schema-Driven Gateway**: Hono routes strictly validated via `drizzle-zod` with RBAC distinguishing `owner`, `viewer`, and `system_agent` (US-01, US-08).
  *Rationale*: Prevents API schema drift and guarantees read-only access for viewers while protecting execution toggles.
