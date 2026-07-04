# QUANTFORGE — Phases 1–6

QUANTFORGE is an AI strategy-trading lab: **load strategy → backtest → paper trade → confidence gate → live**. This folder contains **Phase 1** (file-based strategy definitions plus an event-driven backtester), **Phase 2** (the paper trading engine: live price feeds, realistic order lifecycle simulation, isolated virtual portfolios in SQLite, and a separate worker process), **Phase 3** (the confidence score, promotion gate with auto-demotion, and global kill switch), **Phase 4** (the advisory-only AI layer: model-agnostic provider adapter, Pine-Script/English→JSON translator, multi-agent performance analyst, daily brief, recommendation ledger, and markdown memory), **Phase 5** (the real dashboard: a third server process pushing live DB state over WebSocket to a terminal-noir React SPA — see the Phase 5 section below), and **Phase 6** (gated live execution — now built, **dry-run by default and Binance TESTNET only**: there is no mainnet code path anywhere; see the Phase 6 section below). Only the trend-jack signal bridge remains unbuilt.

It lives inside the same repository as the (unrelated at runtime) Trend-Jack Engine at the repo root; QUANTFORGE Phase 1 is fully self-contained under `/quantforge` and touches nothing outside it.

## Folder layout

Strictly layered (zvt-style): each layer only talks to the layer directly below it, never around it.

```
quantforge/
├── package.json
├── schema/
│   └── strategy.schema.json      # JSON Schema (draft 2020-12) for strategy files
├── strategies/                   # strategy definitions (JSON or YAML)
│   ├── ema-cross-basic.json      # simple EMA-cross + RSI filter
│   └── engulfing-breakout.json   # candlestick pattern + breakout + external_signal example
├── fixtures/
│   └── BTC_USDT_1h_synthetic.json  # deterministic synthetic OHLCV (400 x 1h candles)
├── scripts/
│   ├── validate.js               # ajv-validates every file in /strategies
│   └── generate-fixture.js       # regenerates the synthetic fixture (seeded PRNG)
└── src/
    ├── data/                     # DATA LAYER: candle loading
    │   └── candleLoader.js       #   local JSON fixtures, or historical crypto candles via ccxt
    ├── indicators/               # INDICATOR/FACTOR LAYER
    │   └── index.js              #   wraps the `technicalindicators` package (RSI, EMA/SMA,
    │                             #   MACD, Bollinger, ATR, volume + candlestick patterns)
    ├── strategy/                 # STRATEGY LAYER
    │   ├── loader.js             #   loads + schema-validates JSON/YAML strategy files
    │   ├── validate.js           #   ajv wrapper for the schema
    │   └── evaluator.js          #   evaluates entry_rules / exit_rules per candle
    └── execution/                # EXECUTION LAYER (Phase 1 = backtester only)
        ├── backtester.js         #   candle-by-candle simulation, fees/slippage, metrics
        └── demo.js               #   offline demo run against the fixture
```

## Install & run

Requires Node.js 18+.

```bash
cd quantforge
npm install
npm run validate    # validate the example strategies against the schema
npm run demo        # backtest both example strategies against the local fixture (offline)
```

The demo prints the full trade list plus metrics — total return, win rate, Sharpe, Sortino, max drawdown, and profit factor — for each example strategy. It uses the committed synthetic fixture, so it needs no network or exchange keys. To backtest one specific strategy: `node src/execution/demo.js strategies/ema-cross-basic.json`. To pull real historical candles instead, use `fetchCandles()` / `getCandles()` from `src/data/candleLoader.js` (ccxt, network required). Regenerate the fixture with `npm run generate-fixture` (seeded, deterministic).

## Historical fixtures

Besides the synthetic demo fixture, `fixtures/BTC_USD_1h_2017_bitfinex.json` holds one full year (8,760 hourly candles, Jan 1 – Dec 31 2017) of REAL Bitfinex BTC/USD data, resampled from the public minute-candle dataset at github.com/Zombie-3000/Bitfinex-historical-data (data provided as-is by that project). Run the year-scale backtest + failure diagnosis over it with:

```bash
node scripts/backtest-year.js                 # all strategies vs the 2017 fixture
node scripts/backtest-year.js <fixture> <strategy.json...>   # or pick your own
```

It prints, per strategy: headline metrics vs buy & hold, monthly P&L against the market's monthly move and an efficiency ratio (low = chop), exit-reason breakdown, worst trades, longest losing streak, and the max-drawdown window — i.e. not just how much the rules made, but where and why they lose.

## How the strategy schema works

Strategy files live in `/strategies` as JSON (or YAML) and are validated against `schema/strategy.schema.json` (JSON Schema draft 2020-12) before loading. A strategy has:

- `name`, `symbols` (e.g. `["BTC/USDT"]`), `timeframe` (ccxt notation, e.g. `"1h"`)
- `entry_rules` / `exit_rules` — arrays of condition objects, **ANDed** together. Each condition has a `type` discriminator:
  - `indicator_comparison` — compare an indicator (rsi, sma, ema, macd, bollinger, atr, volume) against a constant `value`, a candle `price` field, or **another indicator**; operators include `gt/gte/lt/lte/eq` and `crosses_above`/`crosses_below`
  - `candlestick_pattern` — any pattern-recognition function exported by the `technicalindicators` package (e.g. `bullishengulfingpattern`, `bearishengulfingpattern`, `doji`, `hammerpattern`); detection is fully delegated to that package
  - `price_level` — breakout above / breakdown below the rolling N-bar high/low (dynamic resistance/support) or a fixed price value
  - `external_signal` — OPTIONAL, advisory-only in Phase 1 (see below)
- `risk` — `stop_loss_pct`, `take_profit_pct`, `max_position_pct`, `max_daily_loss_pct`
- `pine_source` (optional) — raw Pine Script text. Phase 1 only validates/stores it; a future-phase AI translation layer will convert Pine Script into the declarative rule schema.

The backtester iterates candle by candle with **no lookahead**: rules for candle *i* only see indicator values computable from candles up to and including *i* (all wrapped indicators are causal, patterns use a window ending at *i*, price levels use bars strictly before *i*), and a signal on the close of candle *i* fills at the open of candle *i+1*. Fees and slippage (both in bps) are applied to every simulated fill; stop-loss/take-profit are checked intrabar with the stop assumed to fire first.

## Trend-Jack coexistence (future integration path)

The Trend-Jack pipeline at the repo root scrapes trending topics/memes and writes runs to `output/trends_*.json`, where each item carries a `score` (derived from Reddit post score / virality signals) and keyword tracking that includes finance-adjacent terms such as `"crypto"` and `"stocks"`. The strategy schema already reserves an `external_signal` condition type for exactly this feed: a rule can reference `source: "trend-jack"` with a `keyword` (or `symbol`) and a `min_score` threshold on a normalized 0–10 scale — see the last entry rule in `strategies/engulfing-breakout.json` for a concrete example ("bias entries when crypto is trending"). In Phase 1 this is **schema support only**: no bridge/adapter reads the trend-jack output, and the evaluator treats `external_signal` conditions as neutral (always satisfied) while logging a warning. A future phase will add an adapter that normalizes `output/trends_*.json` scores to the 0–10 scale and injects them into the evaluator via its `externalSignals` provider hook.

## Phase 1 boundaries

Phase 1 itself contains only the layers above — its execution layer is the backtester. Order-fill simulation for paper trading, worker processes, and the database **now exist as Phase 2**, the confidence score / promotion gate / kill switch **now exist as Phase 3**, the AI providers / Pine Script translator / analyst / daily brief **now exist as Phase 4**, the dashboard **now exists as Phase 5**, and gated live execution (dry-run by default, testnet-only) **now exists as Phase 6** (all below), built alongside the Phase 1 modules without changing them. Still deliberately **not** built: the trend-jack signal bridge.

## Phase 2 — paper trading engine

Phase 2 adds live/paper trading as **separate OS processes** (never one monolith) that share a SQLite database:

```
quantforge/
├── src/
│   ├── db/
│   │   └── index.js              # openDb(): SQLite via better-sqlite3, PRAGMA journal_mode=WAL,
│   │                             #   creates the schema if missing (portable SQL, Postgres-minded)
│   ├── data/feed/                # LIVE PRICE FEEDS (behind one interface)
│   │   ├── feed.js               #   base class: subscribe(symbol, timeframe) / "candle" events
│   │   ├── binanceFeed.js        #   real keyless Binance WebSocket kline stream (closed candles
│   │   │                         #   only; connection failures warn + retry, never crash)
│   │   ├── fixtureReplayFeed.js  #   replays the committed fixture at accelerated speed (offline)
│   │   └── index.js              #   barrel + interface contract docs
│   ├── engine/                   # ENGINE PROCESS: strategy evaluation + order/position lifecycle
│   │   ├── index.js              #   entry point: npm run engine
│   │   ├── engine.js             #   per-tick loop; one isolated virtual portfolio per strategy
│   │   ├── paperBroker.js        #   order lifecycle: NEW -> PARTIALLY_FILLED -> FILLED /
│   │   │                         #   CANCELLED / REJECTED; slippage, fees, per-tick fill caps
│   │   ├── liveEvaluator.js      #   incremental wrapper reusing the Phase 1 rule evaluator
│   │   └── demo.js               #   npm run engine-demo (offline, spawns a real worker process)
│   ├── execution/
│   │   └── fillMath.js           #   shared slippage/fee conventions (same bps math as Phase 1)
│   └── worker/                   # WORKER PROCESS: scheduled jobs, never inside the engine
│       ├── index.js              #   entry point: npm run worker
│       └── worker.js             #   settlement sweeps (stop/target/stale closes) + equity snapshots
│                                 #   (+ Phase 3: confidence recalculation job)
└── var/                          # runtime SQLite files (gitignored)
```

**Data layer.** `better-sqlite3` with `PRAGMA journal_mode=WAL` plus a busy timeout, because the engine and worker are separate processes writing the same file. Tables: `portfolios` (one isolated virtual portfolio per strategy, starting cash configurable, default 10000), `positions`, `orders`, `fills` (one row per partial or full fill), `trades` (closed round-trip journal), `snapshots` (equity over time, written ONLY by the worker — nothing recomputes equity from raw trades at read time), and `market_state` (latest candle per symbol/timeframe, written by the engine — it is how the worker prices positions). Plain SQL types throughout with an eventual Postgres migration in mind; no migration tooling yet, just create-if-missing schema init.

**Order lifecycle.** No instant fills: an order placed on the close of candle *i* rests until candle *i+1* and fills at that open with slippage (buys worse/higher, sells worse/lower — Phase 1 conventions via `fillMath.js`). Each tick fills at most a configurable fraction of the remaining qty and a configurable notional cap, one `fills` row per increment, so large orders pass through `PARTIALLY_FILLED` across several ticks before `FILLED`. Orders failing sanity checks (non-positive qty, insufficient cash for a buy) are `REJECTED`; unfilled remainders are `CANCELLED` on engine shutdown or when an exit signal supersedes a still-filling entry.

**Engine vs worker.** The engine (`npm run engine`) runs both example strategies concurrently — each against its own portfolio, isolated by `portfolio_id`; one strategy never touches another's cash, positions, or orders. It evaluates rules per closed candle by re-running the Phase 1 evaluator over a growing candle buffer (all indicators are causal, so this is signal-identical to streaming). The worker (`npm run worker`) is a **separate OS process** running exactly four scheduled jobs: settlement sweeps (default every 2 s: stop-loss / take-profit hits checked intrabar against the latest candle, stop first; positions older than a configurable market-time age force-closed as stale), equity snapshots (default every 5 min), confidence recalculation (Phase 3, default every 30 s, see below), and — since Phase 4 — the AI daily brief (default every 24 h, see the Phase 4 section). Both processes are configured by env vars (`QF_DB_PATH`, `QF_FEED`, `QF_SETTLE_MS`, `QF_SNAPSHOT_MS`, `QF_CONFIDENCE_MS`, `QF_BRIEF_MS`, `QF_STALE_MS`, fee/slippage/fill caps — see the entry-point headers).

**Run it:**

```bash
npm run engine-demo   # offline end-to-end demo: engine + a real spawned worker process
                      # replaying the 400-candle fixture in a few seconds; prints final
                      # equity per portfolio, trades, and order-status breakdowns
npm run engine        # real engine process (Binance WebSocket feed by default)
npm run worker        # real worker process (start alongside the engine)
```

The demo spawns `src/worker/index.js` via `node:child_process` — the same two-process, WAL-concurrency path as real deployment, just with a throwaway DB in `var/`, accelerated replay, and short worker intervals. There is no separate `worker-demo` script: a worker with no engine writing market data has nothing observable to do, so the demo exercises both together.

## Phase 3 — confidence score, promotion gate, kill switch

Phase 3 decides **which paper strategies deserve live status** and enforces the safety rails around that status. Promotion here flips `portfolios.status` to `'live'` and applies rules (capital cap, auto-demotion, kill switch) — it does **not** route orders to a real exchange; that is Phase 6 (below), which sits strictly downstream of this gate and re-checks it per order.

```
quantforge/
├── src/confidence/               # CONFIDENCE LAYER (orchestration, no UI)
│   ├── score.js                  #   the weighted composite score + persistence
│   ├── promotion.js              #   promote() gate + auto-demotion checks
│   ├── killSwitch.js             #   setKillSwitch()/isKillSwitchEngaged()
│   └── demo.js                   #   npm run confidence-demo (offline)
└── scripts/kill-switch.js        #   npm run kill-switch -- on|off|status
```

**Confidence score.** A weighted composite in 0–100, recomputed by the worker's third scheduled job (`QF_CONFIDENCE_MS`, default 30 s — never by the engine, never at read time) and persisted with its **full per-component breakdown** to the `confidence_scores` table (latest row per portfolio is current; older rows are history for the Phase 5 dashboard). Components (full rationale in `src/confidence/score.js`): paper win rate vs the breakeven win rate implied by the strategy's own avg win/avg loss (**20%**), profit factor scaled 1→3 (**20%**), annualized Sharpe over the `snapshots` equity curve using the Phase 1 annualization convention (**20%**), max-drawdown penalty 5%→25% (**15%**), a sample-size factor scaling with progress toward 50 trades / 14 calendar days (**15%**), and backtest↔paper consistency vs the strategy's own Phase 1 backtest metrics, cached in `backtest_metrics` (**10%**). Separately from the sample-size sub-score, the composite is **hard-capped at 60** (stored as an explicit `capped` flag) until the portfolio has ≥ 50 closed trades **and** ≥ 14 calendar days of history — an immature portfolio can never clear the promotion bar on a lucky streak.

**Promotion gate.** `promote(db, strategyName, typedConfirmation, { liveCapitalCap })` in `src/confidence/promotion.js` requires the latest confidence score ≥ 75 **and** the caller to type the strategy name back exactly (case-sensitive, untrimmed) — Invariant #1: no strategy reaches live without explicit confirmation. Every attempt, success or rejection, is logged with the failed gate. **Auto-demotion** runs from the worker (folded into the confidence job): a live portfolio is knocked back to `paper` when its `risk.max_daily_loss_pct` is breached in realized pnl over the current UTC day, or on a 3-day losing streak (the last 3 UTC calendar days that had ≥ 1 closed trade were each net-negative). Demotion is an event, not a resting status — the portfolio keeps paper trading and can re-earn promotion; the record lives in `demoted_at` / `demotion_reason` and a `notifications` row.

**Global kill switch.** A single-row `system_state` table. While engaged, the paper broker **rejects every new BUY order** and the worker's settlement sweep **force-flattens every open position across all portfolios** (reason `kill_switch`, with a `notifications` row per close). Operate it with `node scripts/kill-switch.js on ["reason"] | off | status` — there is no dashboard until Phase 5; the future dashboard button will call the same `setKillSwitch()` function.

**Run it:**

```bash
npm run confidence-demo   # offline end-to-end Phase 3 demo: real paper run (capped
                          # scores), a clearly-labelled synthetic matured portfolio
                          # scored through the real function, promotion rejection +
                          # success, auto-demotion, and the kill switch
```

Pre-Phase-3 database files are migrated in place: `openDb()` adds the new `portfolios` columns via `ALTER TABLE` when missing.

## Phase 4 — AI advisory layer

Phase 4 adds the AI: a model-agnostic provider adapter, the Pine-Script / plain-English → strategy-JSON translator, a multi-agent performance analyst, and a daily brief generated by the worker. **Invariant #2 — the single most important rule of this phase: the AI never places orders.** Execution stays deterministic code only. Nothing under `src/ai/` imports the engine or paper broker, calls `promote()` (the typed-confirmation gate of Phase 3 cannot be bypassed by the AI), or writes to `orders`/`fills`/`positions`/`portfolios` — those tables are read-only to it. The AI writes exactly three things: rows in the new `recommendations` table, **new** strategy version files (created with the `O_EXCL` flag — an existing file can never be overwritten), and dated entries in `/quantforge/memory/*.md`. `npm run ai-demo` proves this mechanically: it snapshots order/fill/position/trade counts and every portfolio's status/cash before the first AI call and asserts they are identical after the last one.

```
quantforge/
├── .env.example                  # AI_PROVIDER / AI_MODEL / AI_API_KEY / AI_BASE_URL / QF_BRIEF_MS
├── memory/                       # plain-markdown memory (no vector DB) — injected into every prompt
│   ├── risk-preferences.md       #   operator-editable risk stance the AI must respect
│   ├── portfolio-state.md        #   running lab summary; daily brief appends dated entries
│   └── diagnoses.md              #   analyst appends one distilled conclusion per review
└── src/ai/                       # AI LAYER (advisory only — Invariant #2)
    ├── providers/
    │   ├── index.js              #   createProvider(): anthropic | openai | openrouter | stub,
    │   │                         #   built-in fetch, per-call fallback to stub on any error
    │   └── stub.js               #   deterministic offline placeholder, clearly banner-labelled
    ├── memory.js                 #   readMemory() / appendMemory() over memory/*.md
    ├── recommendations.js        #   the ledger: one row per thing the AI SAID (not executed)
    ├── strategyFiles.js          #   the only write path for generated strategies (never overwrites)
    ├── translate.js              #   Pine/English -> schema-validated strategy JSON -> NEW file
    ├── analyst.js                #   4-role debate (fundamental/sentiment/news/technical) + bull-vs-bear
    ├── dailyBrief.js             #   worker's 4th job: all-portfolio summary -> ledger + memory
    └── demo.js                   #   npm run ai-demo (fully offline, asserts Invariant #2)
```

**Provider adapter.** `createProvider()` reads `AI_PROVIDER` / `AI_MODEL` / `AI_API_KEY` / `AI_BASE_URL` (documented in `.env.example`) and returns one uniform `complete({system, prompt, maxTokens}) → {text, provider, model}` interface. Real adapters for **anthropic** (Messages API), **openai** (Chat Completions), and **openrouter** (OpenAI-compatible endpoint) use the runtime's built-in `fetch` — no HTTP client dependency. With `AI_PROVIDER` unset/`stub` or `AI_API_KEY` missing, the **stub** provider runs instead: a deterministic offline placeholder that never pretends to be a real model (every response starts with `[STUB — no AI_API_KEY configured, …]`) but produces content in the same shape, so all of Phase 4 works and demos with zero network and zero key. A network/auth error from a real provider never crashes anything — the call logs a warning and falls back to the stub.

**Recommendation ledger.** New `recommendations` table (`type` ∈ `analysis` | `operation` | `note`): a log of what the AI *said*, deliberately separate from `trades`/`fills` (what was *executed*) so call quality can later be scored independently of execution quality. Every translator run (`operation`), analyst diagnosis (`analysis`), and daily brief (`note`) is one row with provider/model attribution.

**Memory.** Plain markdown under `/quantforge/memory` — no vector DB. `readMemory()` concatenates all files into every prompt; `appendMemory()` adds dated entries. `risk-preferences.md` is the operator's editable risk stance; the analyst appends distilled conclusions to `diagnoses.md`; the daily brief appends to `portfolio-state.md`.

**Translator** (`src/ai/translate.js`). Takes raw Pine Script or a plain-English description, prompts the provider with the real `schema/strategy.schema.json`, then hard-gates the output through `assertValidStrategy` — invalid output is retried once with the validation errors fed back, then rejected loudly (never silently coerced). Valid output is written to a **new** file (name derived from the strategy's `name`, numeric suffix on collision, `ema-cross-basic.json`/`engulfing-breakout.json` untouchable) and logged as an `operation`.

**Performance analyst** (`src/ai/analyst.js`, TradingAgents-inspired). Reads a strategy's real trade journal and latest confidence breakdown, then produces a diagnosis through a multi-agent structure: four distinctly-framed analyst roles — fundamental (payoff economics), sentiment (crowd positioning), news (event/catalyst blindness), technical (rule mechanics/exits) — carried in one structured provider call for API-call economy, followed by an explicit bull-vs-bear debate and a synthesized diagnosis. Logged as ONE `analysis` row (readable markdown, not JSON blobs). A suggested rule change is **always** proposed as a new version file (e.g. `strategies/ema-cross-basic.v2.json`) through the same schema-validated write path — never a mutation of the running strategy.

**Daily brief** (`src/ai/dailyBrief.js`). The worker's fourth scheduled job (`QF_BRIEF_MS`, default 24 h; set it to seconds for demos): surveys all portfolios (status, latest confidence + capped flag, recent trades/pnl, open positions), recent demotion/kill-switch notifications, and the kill-switch state; logs one `note` row and appends a dated entry to `memory/portfolio-state.md`.

**Run it:**

```bash
npm run ai-demo   # fully offline (stub provider, no key): translator -> new
                  # validated strategy file, 4-role analyst on the real
                  # ema-cross-basic paper record (+ .v2 proposal file), daily
                  # brief, the recommendations ledger, and the mechanical
                  # Invariant #2 check (trading tables untouched by AI)
```

To use a real model instead, export `AI_PROVIDER=anthropic` (or `openai` / `openrouter`) with `AI_API_KEY` and optionally `AI_MODEL` — see `.env.example`. The demo and worker behave identically; only the text quality changes.

## Phase 5 — dashboard

Phase 5 adds the real dashboard as the **third OS process** (engine, worker, dashboard server), sharing the same SQLite/WAL file as a **reader**. It computes no metrics of its own — equity curves come from `snapshots`, confidence and its full breakdown from `confidence_scores`, pnl from `trades`; the server's job is to read tables and shape JSON.

```
quantforge/
├── dashboard/
│   ├── server/                   # DASHBOARD SERVER PROCESS (Express + ws)
│   │   ├── index.js              #   entry point: npm run dashboard (QF_DB_PATH, QF_DASHBOARD_PORT=4100)
│   │   ├── server.js             #   REST + WS; serves dashboard/web/dist statically on the same port
│   │   ├── state.js              #   read-only state assembly (no metric computation)
│   │   └── seed-and-run.js       #   npm run dashboard-demo (full 3-process offline stack)
│   └── web/                      # React + Vite + Tailwind SPA (own package.json / npm install)
│       └── src/                  #   header, strategy cards, lattice, ridges, force graph, tape
└── var/                          # runtime SQLite files + demo screenshots (gitignored)
```

**Write paths.** The server has exactly TWO, both explicit human actions calling the Phase 3 functions verbatim: `POST /api/promote {strategyName, typedConfirmation}` → `promote()` (the real gate — score ≥ 75, exact typed name; the thrown gate reason is returned verbatim as `{ok:false, error}` with HTTP 422) and `POST /api/kill-switch {engaged, reason}` → `setKillSwitch()`. Everything else is read-only; `dashboard/server` contains no INSERT/UPDATE/DELETE statements at all.

**Zero client polling.** Clients make one initial `GET /api/state` for first paint, then receive everything as WebSocket pushes (`/ws`): the server polls the DB internally (~750 ms), pushes a full `state` payload **only when it changed** (JSON diff), and pushes each new `trades` row as a small dedicated `trade` message so the live tape appends without re-rendering.

**UI** (terminal-noir: `#0A0A0B`, self-hosted JetBrains Mono via `@fontsource/jetbrains-mono` with a system-mono fallback stack, desaturated red/green, hairline borders, scanline overlay, reduced-motion-aware pulses): PAPER/LIVE badge, UTC clock, WS health dot with auto-reconnect backoff, always-visible kill-switch control, dot-matrix Σ P&L readout (5×7 dot numerals from real snapshot equity); one card per portfolio with an equity sparkline (stored snapshots plotted as-is), return %, the stored win-rate/Sharpe sub-scores, a segmented 0–100 confidence meter (amber < 75, green ≥ 75, explicit CAPPED tag) and a PROMOTE button (disabled under the gate) whose modal demands the exact strategy name and shows the server verdict verbatim; a trade scatter ("probability lattice", display-only return% derivation matching the scorer's convention), per-strategy return-distribution ridges (display-side histogram smoothing only), a `d3-force` relationship graph (strategies ↔ traded symbols ↔ AI recommendation "signal" nodes; strategy color is an explicitly-labelled realized-pnl-trend proxy, NOT a sentiment score), the live trade tape, and the notifications journal.

**Run it:**

```bash
cd dashboard/web && npm install && npm run build && cd ../..   # build the SPA once
npm run dashboard-demo   # fresh var/dashboard-demo.db + engine (looping fixture replay)
                         # + spawned worker process + spawned dashboard server;
                         # open http://localhost:4100 — Ctrl-C stops all three
npm run dashboard        # dashboard server alone against var/quantforge.db
                         # (run alongside `npm run engine` + `npm run worker`)
```

The frontend keeps its own dependency tree (`dashboard/web/package.json`); the built `dist/` is served by the dashboard server on one port, so no Vite process is needed at runtime.

## Phase 6 — gated live execution (dry-run by default, Binance TESTNET only)

Phase 6 is the most dangerous phase, so it is built around two structural rules:

1. **The default — and the demo — is a pure dry-run.** With no configuration, the live runner journals the orders it *would* place (`live_orders` table, `mode='dry_run'`, `status='DRY_RUN'`, a `WOULD place ...` log line, a notification) and touches no exchange and no funds. It also never touches the paper `orders`/`fills`/`positions` tables: dry-run is an audit trail of intent, not a second simulator.
2. **TESTNET only.** The single real adapter (`src/live/binanceTestnetBroker.js`) targets the Binance **spot testnet** via ccxt `setSandboxMode(true)`, and after enabling sandbox mode it *verifies* that every resolved endpoint URL points at the testnet — refusing permanently otherwise. There is deliberately no `mainnet` / `live-real` value for `QF_LIVE_MODE` and no mainnet code path anywhere; real funds are out of scope for this phase, by design.

```
quantforge/src/live/                # LIVE EXECUTION LAYER (4th OS process)
├── index.js                        #   entry point: npm run live — mirrors paper orders of
│                                   #   PROMOTED portfolios through the gated executor
├── executor.js                     #   THE SAFETY CORE: the six-gate stack (below)
├── dryRunBroker.js                 #   DEFAULT broker: journals + logs, places nothing anywhere
├── binanceTestnetBroker.js         #   the ONLY real adapter (testnet); the ONLY file importing ccxt
├── liveOrders.js                   #   shared journal writer + deterministic client order ids
└── demo.js                         #   npm run live-demo — fully offline proof of every gate
```

**The six gates**, evaluated **in order** for every intended order; the first failure journals a `REJECTED` `live_orders` row naming the gate (plus a notification and a log line), and nothing is sent anywhere:

| # | gate | rule (default) |
|---|------|----------------|
| 1 | `promotion` | portfolio `status` must be `'live'` — i.e. it passed the real Phase 3 `promote()` (typed confirmation + confidence ≥ 75). Paper portfolios never place even a dry-run live order. |
| 2 | `confidence` | latest confidence **re-checked at order time**: still ≥ 75 and not capped. |
| 3 | `kill_switch` | global kill switch must be disengaged. |
| 4 | `dry_run_window` | *mode gate:* testnet placement is forbidden until `QF_DRY_RUN_HOURS` (**48**) of wall-clock time have elapsed since `portfolios.dry_run_started_at` (backfilled from `promoted_at` on first contact; re-promotion restarts it). Until then the executor is **forced** into dry-run regardless of configuration. |
| 5 | `live_enablement` | *mode gate:* even after the window, testnet requires the explicit opt-in `QF_LIVE_MODE=testnet`. Any other value (including unset — the default) means dry-run. No mainnet value exists — intentionally. |
| 6 | circuit breakers | `order_size` (finite qty/price; notional ≤ `QF_MAX_ORDER_NOTIONAL` **500** and ≤ `live_capital_cap`), `per_trade_risk` (est. loss-at-stop ≤ `QF_PER_TRADE_RISK_PCT` **1**% of live capital; 5%-of-notional proxy when no stop), `max_concurrent` (open live exposures < `QF_MAX_CONCURRENT` **3**), `daily_loss` (same UTC daily-loss rule as auto-demotion — breach blocks new entries immediately), `idempotency` (deterministic `client_order_id` + UNIQUE constraint: a retried intent is refused, never double-sent). |

Only when the mode resolves to `testnet` **and** all gates pass is the testnet broker called — and that broker itself refuses (journaled `REJECTED`, never a crash) if credentials are missing, if sandbox mode cannot be verified, or if the exchange call errors. Structurally, `executor.js` never imports ccxt: the testnet broker must be *injected*, and `src/live/index.js` only constructs it (dynamic import) when `QF_LIVE_MODE=testnet` and both keys are present. A process that never injects it — like the offline demo — has **no code path to an exchange at all**.

New storage (`src/db/index.js`): the `live_orders` journal (UNIQUE `client_order_id`, `mode` ∈ dry_run/testnet, `status` ∈ DRY_RUN/SUBMITTED/FILLED/REJECTED, `gate`, `reason`) and the `portfolios.dry_run_started_at` column (added via the same forward-compatible migration; NULL on old files until the executor backfills it from `promoted_at`).

**Run it:**

```bash
npm run live-demo   # fully OFFLINE: seeds + genuinely promotes a synthetic portfolio, then
                    # proves every gate (window forcing, missing-key refusal, kill switch,
                    # paper rejection, breakers, idempotent retry) — no network, ever
npm run live        # the real runner (default: pure dry-run against var/quantforge.db).
                    # Arming testnet requires ALL of: QF_LIVE_MODE=testnet, both
                    # QF_BINANCE_TESTNET_KEY/SECRET set, the 48h window elapsed,
                    # and every gate green per order.
```

Env (documented in `.env.example`): `QF_LIVE_MODE` (default `dry_run`), `QF_DRY_RUN_HOURS` (48), `QF_BINANCE_TESTNET_KEY` / `QF_BINANCE_TESTNET_SECRET`, `QF_MAX_ORDER_NOTIONAL` (500), `QF_PER_TRADE_RISK_PCT` (1), `QF_MAX_CONCURRENT` (3), `QF_LIVE_POLL_MS` (5000).
