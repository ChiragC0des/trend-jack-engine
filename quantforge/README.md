# QUANTFORGE — Phase 1

QUANTFORGE is an AI strategy-trading lab: **load strategy → backtest → paper trade → confidence gate → live**. This folder contains **Phase 1 only**: file-based strategy definitions plus an event-driven backtester. There is no paper-trading engine, dashboard, AI layer, database, or live execution yet — those are later phases.

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

Deliberately **not** built yet: order-fill simulation for paper/live trading, worker processes, dashboards, AI providers (including the Pine Script translator), databases, and the trend-jack signal bridge. The execution layer contains only the backtester.
