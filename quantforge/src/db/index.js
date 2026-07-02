/**
 * QUANTFORGE data store (Phases 2-3): SQLite via better-sqlite3.
 *
 * The engine and the worker are SEPARATE OS processes sharing one DB file, so
 * the database is opened in WAL mode with a busy timeout: WAL lets one writer
 * and many readers coexist across processes, and the busy timeout makes the
 * occasional write-lock collision block briefly instead of throwing.
 *
 * Schema is written with an eventual Postgres migration in mind: plain SQL
 * types, no SQLite-only tricks beyond the pragmas here. Timestamps are epoch
 * milliseconds (BIGINT-compatible INTEGER). Columns holding *market* time
 * (candle timestamps: requested_at, filled_at, opened_at, closed_at,
 * market_state.ts) come from the price feed; snapshots.ts is wall-clock time
 * of the worker run.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Default on-disk location for the paper-trading DB (gitignored). */
export const DEFAULT_DB_PATH = path.join(ROOT, "var", "quantforge.db");

export const ORDER_STATUSES = ["NEW", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS portfolios (
  id              INTEGER PRIMARY KEY,
  strategy_name   TEXT NOT NULL UNIQUE,
  cash            REAL NOT NULL,
  initial_cash    REAL NOT NULL,
  created_at      INTEGER NOT NULL,
  -- Phase 3 promotion gate. Resting states are ONLY 'paper' and 'live':
  -- demotion is an EVENT (logged in notifications + demoted_at/demotion_reason
  -- kept for history), after which the portfolio simply paper-trades again
  -- and may re-earn promotion.
  status          TEXT NOT NULL DEFAULT 'paper' CHECK (status IN ('paper','live')),
  promoted_at     INTEGER,
  live_capital_cap REAL,
  demoted_at      INTEGER,
  demotion_reason TEXT
);

CREATE TABLE IF NOT EXISTS positions (
  id              INTEGER PRIMARY KEY,
  portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id),
  symbol          TEXT NOT NULL,
  qty             REAL NOT NULL,
  avg_entry_price REAL NOT NULL,
  entry_fees      REAL NOT NULL DEFAULT 0,
  stop_price      REAL,
  target_price    REAL,
  opened_at       INTEGER NOT NULL,
  UNIQUE (portfolio_id, symbol)
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY,
  portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id),
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  qty             REAL NOT NULL,
  filled_qty      REAL NOT NULL DEFAULT 0,
  order_type      TEXT NOT NULL DEFAULT 'MARKET',
  status          TEXT NOT NULL CHECK (status IN ('NEW','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED')),
  reason          TEXT,
  stop_loss_pct   REAL,
  take_profit_pct REAL,
  requested_at    INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fills (
  id        INTEGER PRIMARY KEY,
  order_id  INTEGER NOT NULL REFERENCES orders(id),
  qty       REAL NOT NULL,
  price     REAL NOT NULL,
  fee       REAL NOT NULL,
  filled_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id           INTEGER PRIMARY KEY,
  portfolio_id INTEGER NOT NULL REFERENCES portfolios(id),
  symbol       TEXT NOT NULL,
  qty          REAL NOT NULL,
  entry_price  REAL NOT NULL,
  exit_price   REAL NOT NULL,
  fees         REAL NOT NULL,
  pnl          REAL NOT NULL,
  reason       TEXT NOT NULL,
  opened_at    INTEGER NOT NULL,
  closed_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id             INTEGER PRIMARY KEY,
  portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id),
  ts             INTEGER NOT NULL,
  equity         REAL NOT NULL,
  cash           REAL NOT NULL,
  open_positions INTEGER NOT NULL
);

-- Last closed candle per (symbol, timeframe), written by the engine on every
-- tick. This is how the worker prices positions without touching the feed.
CREATE TABLE IF NOT EXISTS market_state (
  symbol     TEXT NOT NULL,
  timeframe  TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  open       REAL NOT NULL,
  high       REAL NOT NULL,
  low        REAL NOT NULL,
  close      REAL NOT NULL,
  volume     REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);

-- Phase 3: confidence score history. One row per recalculation; ONLY the
-- latest row per portfolio is the current score (older rows are history for
-- a future dashboard). Sub-scores are stored individually so the dashboard
-- can render the full breakdown without re-deriving it.
CREATE TABLE IF NOT EXISTS confidence_scores (
  id                  INTEGER PRIMARY KEY,
  portfolio_id        INTEGER NOT NULL REFERENCES portfolios(id),
  ts                  INTEGER NOT NULL,
  score               INTEGER NOT NULL,
  capped              INTEGER NOT NULL DEFAULT 0, -- 1 = sample-size hard cap (60) in force
  win_rate_score      REAL NOT NULL,
  profit_factor_score REAL NOT NULL,
  sharpe_score        REAL NOT NULL,
  drawdown_score      REAL NOT NULL,
  sample_size_score   REAL NOT NULL,
  consistency_score   REAL NOT NULL,
  trades_count        INTEGER NOT NULL,
  days_elapsed        REAL NOT NULL
);

-- Phase 3: cached Phase 1 backtest metrics per strategy, used by the
-- backtest<->paper consistency component. Populated by the confidence job
-- (running the real backtester against the committed fixture) or seeded
-- explicitly (source = 'seeded_stub') for portfolios without a strategy file.
CREATE TABLE IF NOT EXISTS backtest_metrics (
  strategy_name        TEXT PRIMARY KEY,
  trades               INTEGER NOT NULL,
  win_rate_pct         REAL NOT NULL,
  avg_trade_return_pct REAL NOT NULL,
  profit_factor        REAL NOT NULL,
  source               TEXT NOT NULL DEFAULT 'backtest',
  computed_at          INTEGER NOT NULL
);

-- Phase 3: operator/safety event log (demotions, kill-switch actions).
-- A future dashboard reads this; for now it is written by the worker and
-- the promotion/kill-switch modules and printed by demos.
CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY,
  portfolio_id INTEGER REFERENCES portfolios(id), -- NULL for system-wide events
  ts           INTEGER NOT NULL,
  type         TEXT NOT NULL,
  message      TEXT NOT NULL
);

-- Phase 3: global kill switch. Single row (id = 1), created on openDb.
-- While engaged: the paper broker rejects NEW BUY orders and the worker's
-- settlement sweep force-flattens every open position across all portfolios.
CREATE TABLE IF NOT EXISTS system_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  kill_switch_engaged INTEGER NOT NULL DEFAULT 0,
  engaged_at          INTEGER,
  reason              TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_open ON orders (portfolio_id, symbol, status);
CREATE INDEX IF NOT EXISTS idx_fills_order ON fills (order_id);
CREATE INDEX IF NOT EXISTS idx_trades_portfolio ON trades (portfolio_id, closed_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_portfolio ON snapshots (portfolio_id, ts);
CREATE INDEX IF NOT EXISTS idx_confidence_portfolio ON confidence_scores (portfolio_id, ts);
CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications (ts);
`;

/**
 * Forward-compatible migration for pre-Phase-3 database files: portfolios
 * created by the old CREATE TABLE (no status/promotion columns) get the new
 * columns via ALTER TABLE. CHECK constraints cannot be added by ALTER in
 * SQLite, so migrated DBs rely on application code for the status enum —
 * fresh DBs get the CHECK from the schema above.
 */
function migratePortfolios(db) {
  const existing = new Set(
    db.prepare("SELECT name FROM pragma_table_info('portfolios')").all().map((r) => r.name)
  );
  const wanted = [
    ["status", "TEXT NOT NULL DEFAULT 'paper'"],
    ["promoted_at", "INTEGER"],
    ["live_capital_cap", "REAL"],
    ["demoted_at", "INTEGER"],
    ["demotion_reason", "TEXT"],
  ];
  for (const [name, decl] of wanted) {
    if (!existing.has(name)) db.exec(`ALTER TABLE portfolios ADD COLUMN ${name} ${decl}`);
  }
}

/** Open (creating if needed) the shared paper-trading database. */
export function openDb(dbPath = DEFAULT_DB_PATH) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migratePortfolios(db);
  // Kill switch defaults to disengaged; the single row always exists so
  // readers never need to handle a missing-row case.
  db.prepare("INSERT OR IGNORE INTO system_state (id, kill_switch_engaged) VALUES (1, 0)").run();
  return db;
}
