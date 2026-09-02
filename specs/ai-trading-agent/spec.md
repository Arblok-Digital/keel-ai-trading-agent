# Product Requirements Document (PRD) — ai-trading-agent

## 1. Problem
Retail algorithmic trading bots rely on lagging naked technical indicators, exposing spot capital to institutional stop hunts, liquidity traps, and execution drift. Decentralized token launches and centralized spot markets lack unified early money-flow tracking with institutional pre-trade risk gates. Without mandatory persist-before-execute auditability and deterministic exchange reconciliation, autonomous agents suffer silent order failures, double executions, and catastrophic unhedged drawdowns.

## 2. Users
- **owner**: System administrator with exclusive authority to manage encrypted spot API keys, toggle live/paper execution, configure market maker strategy parameters, and invoke the emergency kill switch.
- **viewer**: Read-only stakeholder monitoring the early-detection feed, live portfolio P&L, multi-timeframe market maker hypotheses, and execution decision audit logs.
- **system_agent**: Autonomous background worker executing ingestion pipelines, pre-trade risk validations, idempotent order placement, and continuous balance reconciliation.

## 3. User Stories
- **US-01**: As an **owner**, I want to securely configure spot-only exchange credentials encrypted with AES-256-GCM and toggle between paper and live trading, so that the agent never has withdrawal scope and can be safely tested before risking capital.
- **US-02**: As a **system_agent**, I want to persist an append-only decision record containing M15/H1/H4/D1 confluence, smart-money flow shift metrics, and liquidity target theses *before* contacting exchange adapters, so that all actions are completely auditable.
- **US-03**: As a **system_agent**, I want to atomically reserve an available position slot (maximum 5 concurrent positions) and rate-limit ticket (maximum 10 orders/hour) using PostgreSQL row-level locking (`SELECT ... FOR UPDATE` on the risk constraint singleton), so that concurrent worker tasks never exceed hard exposure limits.
- **US-04**: As a **system_agent**, I want to issue spot orders using a deterministic `clientOrderId` derived directly from the decision UUID and verify order status against the exchange if a timeout occurs, so that network degradation never produces duplicate or orphan fills.
- **US-05**: As an **owner**, I want to engage an instant kill switch via UI or Telegram that immediately cancels all open orders and halts order placement, so that unforeseen market volatility is mitigated instantaneously.
- **US-06**: As a **system_agent**, I want to continuously reconcile local database positions and balances against exchange balances and DEX pool states every 15 seconds, halting trading automatically if any discrepancy is detected.
- **US-07**: As a **system_agent**, I want to reject any incoming market data feed whose exchange-derived timestamp staleness exceeds 1500ms or lacks multi-timeframe bias alignment, so that execution never occurs on stale or retail-chasing signals.
- **US-08**: As a **viewer**, I want to view real-time token rankings scored by composite early metrics (smart money accumulation, liquidity depth, narrative velocity) alongside the exact institutional reasoning for every trade, so that I have full operational visibility.

## 4. Success Metrics
- **100% Audit Traceability**: Zero orphan exchange orders; 100% of executed orders possess a pre-persisted decision log and deterministic `clientOrderId`.
- **Zero Risk Breaches**: Zero occurrences of exceeding 5 open positions, 10 orders per hour, 2-5% position allocation, or 3% daily drawdown across both paper and live modes.
- **100% Idempotent Recovery**: Zero duplicate order placements during simulated 5-second exchange API timeout windows.

## 5. Non-Goals
- Support for derivatives, perpetuals, margin, or leverage trading (strictly spot market only).
- API key custody with withdrawal, transfer, or sub-account creation permissions (unauthorized scopes cause immediate hard failure).
- Standalone retail technical indicator strategies (naked RSI, MACD, or Bollinger crossovers without institutional liquidity/MM thesis are prohibited).
