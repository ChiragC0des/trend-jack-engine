# QUANTFORGE — Phases 1 & 2

QUANTFORGE is an AI strategy-trading lab: **load strategy → backtest → paper trade → confidence gate → live**. This folder contains **Phase 1** (file-based strategy definitions plus an event-driven backtester) and **Phase 2** (the paper trading engine: live price feeds, realistic order lifecycle simulation, isolated virtual portfolios in SQLite, and a separate worker process — see the Phase 2 section below). There is no confidence gate, AI layer, dashboard, or live execution yet — those are later phases.

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

Phase 1 itself contains only the layers above — its execution layer is the backtester. Order-fill simulation for paper trading, worker processes, and the database **now exist as Phase 2** (below), built alongside the Phase 1 modules without changing them. Still deliberately **not** built: the confidence score / promotion gate (Phase 3), AI providers including the Pine Script translator and daily brief (Phase 4), dashboards (Phase 5), live-money execution, and the trend-jack signal bridge.

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
└── var/                          # runtime SQLite files (gitignored)
```

**Data layer.** `better-sqlite3` with `PRAGMA journal_mode=WAL` plus a busy timeout, because the engine and worker are separate processes writing the same file. Tables: `portfolios` (one isolated virtual portfolio per strategy, starting cash configurable, default 10000), `positions`, `orders`, `fills` (one row per partial or full fill), `trades` (closed round-trip journal), `snapshots` (equity over time, written ONLY by the worker — nothing recomputes equity from raw trades at read time), and `market_state` (latest candle per symbol/timeframe, written by the engine — it is how the worker prices positions). Plain SQL types throughout with an eventual Postgres migration in mind; no migration tooling yet, just create-if-missing schema init.

**Order lifecycle.** No instant fills: an order placed on the close of candle *i* rests until candle *i+1* and fills at that open with slippage (buys worse/higher, sells worse/lower — Phase 1 conventions via `fillMath.js`). Each tick fills at most a configurable fraction of the remaining qty and a configurable notional cap, one `fills` row per increment, so large orders pass through `PARTIALLY_FILLED` across several ticks before `FILLED`. Orders failing sanity checks (non-positive qty, insufficient cash for a buy) are `REJECTED`; unfilled remainders are `CANCELLED` on engine shutdown or when an exit signal supersedes a still-filling entry.

**Engine vs worker.** The engine (`npm run engine`) runs both example strategies concurrently — each against its own portfolio, isolated by `portfolio_id`; one strategy never touches another's cash, positions, or orders. It evaluates rules per closed candle by re-running the Phase 1 evaluator over a growing candle buffer (all indicators are causal, so this is signal-identical to streaming). The worker (`npm run worker`) is a **separate OS process** running exactly two scheduled jobs: settlement sweeps (default every 2 s: stop-loss / take-profit hits checked intrabar against the latest candle, stop first; positions older than a configurable market-time age force-closed as stale) and equity snapshots (default every 5 min). Confidence recalculation (Phase 3) and the AI daily brief (Phase 4) are intentionally absent from the job list. Both processes are configured by env vars (`QF_DB_PATH`, `QF_FEED`, `QF_SETTLE_MS`, `QF_SNAPSHOT_MS`, `QF_STALE_MS`, fee/slippage/fill caps — see the entry-point headers).

**Run it:**

```bash
npm run engine-demo   # offline end-to-end demo: engine + a real spawned worker process
                      # replaying the 400-candle fixture in a few seconds; prints final
                      # equity per portfolio, trades, and order-status breakdowns
npm run engine        # real engine process (Binance WebSocket feed by default)
npm run worker        # real worker process (start alongside the engine)
```

The demo spawns `src/worker/index.js` via `node:child_process` — the same two-process, WAL-concurrency path as real deployment, just with a throwaway DB in `var/`, accelerated replay, and short worker intervals. There is no separate `worker-demo` script: a worker with no engine writing market data has nothing observable to do, so the demo exercises both together.
