# AGENTS.md — Autonomous Agent Operating System

## READING ORDER
Read these source-of-truth documents in sequence before modifying code:
1. `.specify/constitution.md` — Core governing principles and non-negotiables.
2. `specs/ai-trading-agent/spec.md` — Functional specifications and acceptance criteria.
3. `PLAN.md` — Single source of truth: active workstream + owner decision registry.
4. `specs/ai-trading-agent/plan.md` — System architecture and layer boundaries.
5. `contracts/openapi.yaml` — API endpoints, request schemas, and response contracts.
6. `db/schema.ts` — Drizzle ORM database tables, enums, and relation definitions.
7. `db/rls.sql` — PostgreSQL Row-Level Security policies and security-definer routines.
8. `docs/security.md` — Threat mitigations, auth tokens, and the RBAC permissions matrix.
9. `docs/audit.md` — Audit trail design, write patterns, and tamper-evident guarantees.
10. `docs/folder-map.txt` — Project structure layout and module boundaries.

---

## HARD RULES
1. **Contract-First Schema**: All domain models derive from `db/schema.ts`. Use `drizzle-zod` for API validation. Untyped `any` or schema drift between database and `contracts/openapi.yaml` fails builds.
2. **Persist-Before-Execute**: Every autonomous action MUST commit a record to `trade_decisions` with `risk_passed` and `mm_thesis` BEFORE dispatching requests to exchange adapters.
3. **Deterministic clientOrderId**: Every order must set `client_order_id` derived directly from `decision_id` in `orders`. If an order times out, query the exchange by `client_order_id` before retrying.
4. **Mandatory Pre-Trade Risk Limits**: Execute zero-bypass pre-trade checks: Spot-only, max 5 open `positions`, max 10 orders/hr, 2-5% position size, -2% stop-loss, and max 3% daily drawdown.
5. **Transactional Audit Logging**: Every state-changing operation must write an `audit_logs` row inside the exact same database transaction boundary.
6. **RLS on Every Table**: Every table defined in `db/schema.ts` must have RLS enabled with explicit policies in `db/rls.sql` applied in the same migration.
7. **Matrix-Governed RBAC**: Role-based access checks (`owner`, `viewer`, `system_agent`) must strictly follow the permissions matrix in `docs/security.md`. Never use ad-hoc string checks.
8. **Server-Time Synchronization**: All order timing and staleness checks must use exchange server time (`server_time` in `orders`), never local machine clocks. Discard market ticks stale by >1500ms.
9. **Continuous Reconciliation**: Run a 15-second loop recording to `reconciliation_reports`. Any balance mismatch between database ledgers and exchange balances must immediately halt all trading.
10. **Unidirectional Order FSM**: Order status transitions in `orders` are strictly unidirectional: `PENDING` -> `PARTIALLY_FILLED` -> `FILLED` / `REJECTED` / `CANCELLED`.
11. **Market-Maker Lens Validation**: Signals must populate liquidity depth and smart-money flow (`ACCUMULATION`, `DISTRIBUTION`, `NEUTRAL`) in `early_detection_tokens`. Naked indicators without MTF confluence are rejected.

---

## COMMANDS
```bash
# Development & Execution
npm run dev               # Start Hono API server and background worker
npm run worker            # Run background worker for market feeds and reconciliation

# Database & Migrations
npm run db:generate       # Generate Drizzle migration files from db/schema.ts
npm run db:migrate        # Apply migrations and execute db/rls.sql policies
npm run db:studio         # Launch Drizzle Studio for database inspection

# Testing & Quality Assurance
npm run typecheck         # Run strict TypeScript compiler verification (tsc --noEmit)
npm run lint              # Run ESLint to enforce type discipline and security rules
npm run test              # Execute unit and integration test suites
npm run test:risk         # Run risk gatekeeper and drawdown limit verification tests
```

---

## FORBIDDEN
- NEVER place an exchange or DEX order without a committed `trade_decisions` entry in PostgreSQL.
- NEVER enable margin, leverage, futures, or withdrawal capabilities (spot-only strictly enforced).
- NEVER use `Date.now()` or local system time for order timing, staleness checks, or decision triggers.
- NEVER log, dump, or transmit unencrypted exchange API credentials or private keys.
- NEVER bypass the synchronous risk gatekeeper or mutate position limits outside `db/schema.ts`.
- NEVER use ad-hoc authorization checks; all endpoints must evaluate the matrix in `docs/security.md`.
- NEVER modify database schemas without updating both `db/schema.ts` and `contracts/openapi.yaml`.
- NEVER permit `UPDATE` or `DELETE` operations on append-only tables (`audit_logs`, `trade_decisions`, `reconciliation_reports`).
