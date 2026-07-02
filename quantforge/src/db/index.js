/**
 * QUANTFORGE data store (Phase 2): SQLite via better-sqlite3.
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
  id            INTEGER PRIMARY KEY,
  strategy_name TEXT NOT NULL UNIQUE,
  cash          REAL NOT NULL,
  initial_cash  REAL NOT NULL,
  created_at    INTEGER NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_orders_open ON orders (portfolio_id, symbol, status);
CREATE INDEX IF NOT EXISTS idx_fills_order ON fills (order_id);
CREATE INDEX IF NOT EXISTS idx_trades_portfolio ON trades (portfolio_id, closed_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_portfolio ON snapshots (portfolio_id, ts);
`;

/** Open (creating if needed) the shared paper-trading database. */
export function openDb(dbPath = DEFAULT_DB_PATH) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
