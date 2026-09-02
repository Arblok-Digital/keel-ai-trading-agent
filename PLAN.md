# PLAN.md — keel (Single Source of Truth, 02 Sep 2026)

> **AGENTS SOT** — baca ini dulu sebelum edit apapun. Menggantikan
> `MASTER_ACTION_LIST.md`, `MASTER_ACTION_LIST_v1_*`, `SPEC_MM_BRAIN_PIPELINE.md`, `AUDIT_REPORT.md`, `AUDIT_IMPLEMENTATION.md` (backup di git history).

---

## READING ORDER (mirror AGENTS.md)
1. `.specify/constitution.md`  2. `specs/ai-trading-agent/spec.md`  3. **`PLAN.md` (ini) — workstream + registry**
4. `specs/ai-trading-agent/plan.md`  5. `contracts/openapi.yaml`  6. `db/schema.ts`  7. `db/rls.sql`

---

## §1 — SUDAH BERES & TERVERIFIKASI (jangan dikerjakan ulang)

| Area | Status | Bukti |
|------|--------|-------|
| P0-1 creds LIVE | PASS | vault + order-exists guard |
| P0-2 composite index | PASS | hanya decision_transitions_decision_id_to_state_key |
| P0-3 trigger terminal_state | PASS | 9 trigger + GRANT col-level |
| P0-5 drawdown false-positive | PASS | equity = cash + positions |
| P0-6 audit_logs RLS | PASS | owner OR system_agent |
| P0-7 binance cancelAll | PASS | signed GET+DELETE |
| P2-2 time-sync RTT | PASS | NTP offset; future tick reject |
| P2-3 staleness future tick | PASS | latencyMs < 0 reject |
| P2-5 DB pool leak | PASS | singleton + closeDb |
| P2-6 RLS grant order | PASS | GRANT setelah CREATE |
| P2-7 orders FSM | PASS* | whitelist (*same-value no-op) |
| P2-8 log scrubber | PASS | [REDACTED] + registry |
| FINDING-2 drop index | CLOSED | _migrations fresh |
| PB-2 paper inventory | done | SELL > holdings REJECTED |
| PB-3/4/5 exit-monitor | done | closing order + FSM + audit |
| PB-6 MTF brain (R5) | done | aggregator+engine+narrative real |
| PB-10 live test tanpa VPN | done | visionAvailable gate |
| G-1 reconciliation valuasi | done | per-aset valuation live |
| PB-11 recorder | done | signal_features + sampler |
| C1 core + manual endpoint | done | R8 E2E verified |
| Infra | done | pg16+redis; 87/87 test; tsc+lint |

PB-1 = keputusan Opsi B (lihat 2) — intentional no-op.

---

## 2 — REGISTRY KEPUTUSAN OWNER

| # | Keputusan | Isi | File |
|---|-----------|-----|------|
| Opsi B (31 Aug) | SL = data-driven | SL/TP dari entry-risk-engine (wall+vol). Gatekeeper cuma SL < 0, TIDAK enforce -2%. stopLossPct (-2) = fallback default. Override HARD RULE 4 literal. | entry-risk-engine, gatekeeper |
| PAPER-first | PAPER 100% dulu | LIVE 1 bulan. PB-13/14/15 FASE 4; PB-11 jalan sekarang. | — |
| R8-FIX pending | dual-state + staleness + guard + UI | Ditangani P0-2. | paper-adapter, gatekeeper |

---

## 3 — WORKSTREAM AKTIF (P0-P4)

### P0 — Konsolidasi & bugfix (wajib typecheck+lint+test)
- [x] P0-1 SOT — PLAN.md ini + hapus 4 MD usang + update AGENTS reading order
- [x] P0-2a wall-dynamics.ts:28 prevBidWall pakai current.bids (bug)
- [x] P0-2b HOLD zombification (PENDING abadi -> terminal REJECTED, skip executor)
- [x] P0-2c executor LIVE quoteQtyFor fallback ke 100/10000 -> fetch orderbook atau 503
- [x] P0-2d Drawdown snapshot fresh di tx gatekeeper (gatekeeper resolves null→0, interval 15s masih HWM source — honest)
- [x] P0-3 Market-structure real (BOS/CHoCH/FVG/CVD) — MTF bias institutional hari 1
- [x] P0-4 Scanner metrik palsu (liquidityUsd=vol*0.8, mtfAlignment fake) -> real atau jujur

### P1 — AI pahau ticker + feedback loop (fondasi winrate)
- [x] P1-1 Symbol guard tx: SYMBOL_POSITION_OPEN + COOLDOWN (default 60m) + MAX_REENTRY_PER_DAY (3)
- [x] P1-2 signal_outcomes write path (exit-monitor -> closePosition -> pnl, rMultiple, outcome)
- [x] P1-3 Dashboard winrate rolling (Win% 100 sinyal, expectancy, PF) — GET /api/v1/analytics/winrate
- [x] P1-4 Tests: dedupe guard + outcomes write path

### P2 — Probability TP + trailing (sumber winrate 80%)
- [x] P2-1 probability-engine.ts — P(TP|signal) Laplace/Wilson per kelas sinyal
- [x] P2-2 Gate: P>=threshold (0.55) dan EV>0 — shadow first, ngehormati ALGO_CONFIG.SWING.mlShadowOnly
- [x] P2-3 TP dinamis EV-max (feed via probability-engine + RISK_CONSTANTS baked into entry-risk-engine)
- [x] P2-4 Trailing chandelier di exit-monitor (breakeven@1R -> k=2*ATR trail) + STOP_TRAILED audit per geser
- [ ] P2-5 Tuning menuju winrate 80% terukur (selection ketat + trailing locking) — butuh 200 outcomes menumpuk

### P3 — Early detection -> auto-trade (goal inti)
- [x] P3-1 Watchlist dinamis → feed resubscribe (refreshWatchlist 90s resubscribe feedManager + visionPoller) — fix 02 Sep: resubscribeSymbols di Binance/Gate/Coinbase/Vision + feedManager.resubscribe()
- [x] P3-2 Scanner depth/velocity real (orderbook nyata atau N/A — jangan fabricated) — liquidityUsd overwritten di enriched, mtfAlignment dari plan.side
- [x] P3-3 Batch fetch + cache 15s (sudah ada di orderbook-service) + redis double-init race guarded (pending promise)

### P4 — Structure engine + SWING + ML
- [x] P4-1 Structure engine real — MTFEngine: BOS/HH-HL Donchian + EMA regime + FVG (mengganti supertrendDir EMA-fallback)
- [x] P4-2 mlShadowOnly wiring (log prob tanpa block sampai 200 sampel) — probability-engine shadow + SWING cfg passthrough

> KPI jujur: winrate 80% @ 1.5R ekstrem. Optimasi expectancy dulu; dashboard tunjuk dua-duanya.

```
CEX WS (Binance/Gate/Coinbase) -+- Kline Aggregator (M15/H1/H4/D1) - MTFEngine -+
Vision Poller (depth+kline) ----+  Orderbook -> TemporalMemory -> Absorp+Wall -+-> SignalGenerator (confluence + prob)
                                                                               |        |
                                                                     signal_features <-+        v
                                                                       Gatekeeper (reserve+snapshot+dedupe+prob) -> Executor (deterministic id, idempotent)
                                                                               |
                                                                     signal_outcomes <- ExitMonitor (trailing chandelier) -> closePosition
```

---

## 4 — DEFERRED LIVE GATE (1 bulan ke LIVE)

| # | Item | Est | Prereq |
|---|------|-----|--------|
| G-1 | Live reconciliation per-asset | 1h | — |
| G-2 | Backtest engine (replay Vision klines) | 16-20h | PB-11 |
| G-3 | Feature store + training | 16-20h | PB-11 + 200 sampel |
| G-4 | ML shadow -> filter | 8-12h | G-3 |

---

## 5 — ATURAN KERJA AGENT

1. Lapor daftar file diubah (path+alasan) di akhir — auditor hash diff.
2. Selesai = typecheck + lint + test lulus.
3. Jangan ubah file di luar scope tanpa approval.
4. Perubahan db/schema/rls/migrations wajib verifikasi.
5. **JANGAN PERNAH blanket-kill node.exe** — proses `node` dipakai infra 9router (proxy agent). Kill HANYA by-PID terverifikasi: `Get-CimInstance Win32_Process | ? CommandLine -like '*src/index.ts*'` atau `src/worker.ts`, atau via `scripts/stop-keel.ps1`. Larangan keras: `Get-Process node | Stop-Process`.
6. Server diluncurkan sebagai process terpisah via `scripts/keel-run.ps1` (bukan child terminal Cline) — mati/hang-nya sesi chat TIDAK mematikan API/worker.

---

## 6 — REFERENSI YANG DIGANTI

MASTER_ACTION_LIST v2 + v1, SPEC_MM_BRAIN_PIPELINE, AUDIT_REPORT + AUDIT_IMPLEMENTATION (28 Aug) -> digabung kesini (history di git).

