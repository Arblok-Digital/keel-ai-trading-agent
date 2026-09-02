# keel — AI Trading Agent · Market-Maker Spot Terminal

> Institutional-grade autonomous **spot-only** trading agent: market-maker brain, pre-pump early detection, multi-timeframe confluence, persist-before-execute audit trail, and idempotent exchange execution.

![status](https://img.shields.io/badge/mode-PAPER--first-yellow) ![tests](https://img.shields.io/badge/tests-87%2F87-brightgreen) ![typecheck](https://img.shields.io/badge/tsc-strict-blue) ![license](https://img.shields.io/badge/license-proprietary-red)

---

## What it does

```
CEX WS (Binance / Gate / Coinbase) ──► Kline Aggregator (M15/H1/H4/D1) ──► MTF Engine (BOS · HH-HL · FVG)
Vision REST Poller (depth + klines) ──► Orderbook Feed ──► Temporal Microstructure Memory ──► Absorption · Wall Dynamics
                                    └─► Trade Tape ──► Narrative Velocity (smart-money flow)
                                                                        │
                                                                        ▼
                                                    Signal Generator — Zod-validated MM thesis
                                                    (naked indicators are structurally rejected)
                                                                        │
                                                                        ▼
                                   Risk Gatekeeper — FOR UPDATE row lock · drawdown HWM ·
                                   symbol dedupe (position-open / 60m cooldown / 3×/day) ·
                                   probability gate P(win) ≥ threshold & EV > 0
                                                                        │ persist-before-execute
                                                                        ▼
                          Executor — deterministic clientOrderId (cID-<decisionId>) ·
                          idempotent timeout recovery · spot-only scope enforcement
                                                                        │
                                                                        ▼
                 Exit Monitor (5s) — static SL/TP + trailing chandelier (breakeven @1R → 2×ATR, ratchet-only)
                                                                        │
                                                                        ▼
                 signal_outcomes ledger ──► winrate / expectancy / profit-factor analytics
```

### Core guarantees (hard rules, zero-bypass)

| Rule | Mechanism |
|---|---|
| **Persist-before-execute** | `trade_decisions` + `decision_transitions` + audit row committed in **one transaction** before any exchange call |
| **Deterministic orders** | `clientOrderId = cID-<decisionId>`; on timeout, exchange is queried by `clientOrderId` before any retry |
| **Risk limits** | Max 5 open positions · 10 orders/hour · 2–5% size · SL < 0 mandatory · 3% daily drawdown auto-halt · kill switch < 500ms |
| **Server-time discipline** | Binance + Gate time sync (RTT-corrected); ticks stale > 1500ms rejected & audited |
| **Reconciliation** | 15s loop DB ⇄ exchange; any mismatch → instant halt + Telegram alert |
| **Tamper-evident audit** | SHA-256 hash chain on `audit_logs`, verifier every 6h, append-only enforced at DB level |
| **Market-maker lens** | Signals require liquidity depth + smart-money flow + MTF confluence — naked RSI/MACD bots are structurally impossible |

## Stack

- **Runtime:** Node 20+, TypeScript (strict, `noUncheckedIndexedAccess`), tsx
- **API:** Hono + WebSocket (`@hono/node-ws`), Redis pub/sub
- **DB:** PostgreSQL 16 + Drizzle ORM + drizzle-zod + Row-Level Security (`keel_app` role, deny-by-default)
- **Feeds:** Binance WS, Gate WS, Coinbase WS, Binance Vision REST (auto-failover via `MultiSourceFeedManager`)
- **Execution:** Binance Spot adapter · Uniswap V3 (viem) · Raydium (@solana/web3.js) · Paper adapter
- **Secrets:** AES-256-GCM vault, global log scrubber, spot-only scope rejection (withdrawal/margin keys = instant lockdown)

## Quick start

```bash
# 1. Infra
docker compose up -d          # postgres 16 + redis 7

# 2. Configure
cp .env.example .env          # fill: VAULT_MASTER_KEY, JWT keys, MFA_SECRET, OWNER_EMAIL/PASSWORD
npm ci

# 3. Migrate (schema + RLS in the same transaction)
npm run db:migrate

# 4. Run (API + worker)
npm run dev                   # API   → http://localhost:3000/app
npm run worker                # feeds, signals, exit monitor, reconciliation
```

Windows detached launcher (survives terminal close):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\keel-run.ps1     # start API + worker
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-keel.ps1    # stop (by-PID, never blanket-kills node)
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | API server (Hono) with watch |
| `npm run worker` | Ingestion · signals · exit monitor · reconciliation |
| `npm run typecheck` | Strict `tsc --noEmit` |
| `npm run lint` | ESLint (bans `Date.now()` outside TimeService, bans ad-hoc auth) |
| `npm test` | Unit + integration suites (87 tests) |
| `npm run test:risk` | Risk gatekeeper + drawdown suites |
| `npm run db:generate` / `db:migrate` / `db:studio` | Drizzle workflow |

## Repository layout

```
├── PLAN.md               # Single source of truth: workstream status + owner decision registry
├── AGENTS.md             # Operating rules for autonomous agents (reading order, hard rules)
├── .specify/constitution.md  # Governing principles
├── specs/ai-trading-agent/   # PRD + architecture
├── contracts/openapi.yaml    # API contract (drizzle-zod aligned)
├── db/                   # schema.ts · rls.sql (RLS + FSM + triggers) · migrations
├── src/                  # auth · routes · services (ingestion, mm-brain, risk, execution, audit)
├── tests/                # vitest — risk races, idempotency, RLS matrix, tamper detection
└── scripts/              # detached launcher / stopper (Windows)
```

## Safety posture

- **PAPER-first**: default mode is `PAPER`; switching to `LIVE` requires owner role + TOTP MFA step-up.
- Exchange API keys are validated at insert: any key holding `withdrawal`/`margin`/`transfer` scopes is rejected and the agent locks down.
- `.env` is git-ignored; only `.env.example` ships. Rotate `VAULT_MASTER_KEY` per environment — it encrypts exchange credentials at rest (AES-256-GCM).
- All `Date.now()` usage outside `TimeService` is lint-banned — order timing never trusts local clocks.

## Status

Active development — PAPER campaign phase (winrate/expectancy telemetry accumulates in `signal_outcomes`; probability engine runs in shadow until 200 samples). See [`PLAN.md`](./PLAN.md) for the live workstream registry.

---

**Proprietary & confidential.** Private repository — do not redistribute without owner consent.
