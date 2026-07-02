/**
 * QUANTFORGE worker (Phase 2): scheduled background jobs.
 *
 * Runs as its OWN OS process (see ./index.js), sharing the SQLite database
 * (WAL mode) with the engine. Heavy/periodic work never runs inside the
 * engine's tick loop — the worker owns it, on timers:
 *
 *   - settlement sweep (every settlementIntervalMs): checks each open
 *     position against the latest market_state candle for stop-loss /
 *     take-profit hits (intrabar via low/high, stop first — conservative,
 *     same as the Phase 1 backtester) and for staleness (open longer than
 *     stalePositionMs of MARKET time), and actually closes them: order +
 *     fill + trade rows, cash update, position delete, atomically.
 *   - equity snapshots (every snapshotIntervalMs): equity = cash + sum of
 *     open position qty * latest close, written to `snapshots`. Snapshots
 *     are the ONLY read model for equity curves — nothing recomputes equity
 *     from raw trades at read time.
 *
 * Phase 3 (confidence recalculation) and Phase 4 (AI daily brief) jobs are
 * intentionally absent — the job list is exactly the two above.
 *
 * Stop/target closes fill fully at the trigger price (plus slippage): unlike
 * the engine's resting market orders, a triggered stop is priced by its level
 * rather than by order size, so the per-tick partial-fill model is not
 * applied here.
 */

import { applySlippage, feeFor } from "../execution/fillMath.js";

const EPS = 1e-9;

export class Worker {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {object} config { feeBps, slippageBps, settlementIntervalMs,
   *                          snapshotIntervalMs, stalePositionMs, log }
   */
  constructor(db, config = {}) {
    this.db = db;
    this.feeBps = config.feeBps ?? 10;
    this.slippageBps = config.slippageBps ?? 5;
    this.settlementIntervalMs = config.settlementIntervalMs ?? 2_000;
    this.snapshotIntervalMs = config.snapshotIntervalMs ?? 300_000;
    this.stalePositionMs = config.stalePositionMs ?? 7 * 24 * 3_600_000;
    this.log = config.log ?? console;
    this.timers = [];
  }

  start() {
    this.timers.push(setInterval(() => this.safely("settlement", () => this.settlementSweep()), this.settlementIntervalMs));
    this.timers.push(setInterval(() => this.safely("snapshot", () => this.snapshotEquity()), this.snapshotIntervalMs));
    this.log.info?.(
      `[worker] started: settlement every ${this.settlementIntervalMs}ms, snapshots every ${this.snapshotIntervalMs}ms`
    );
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  safely(job, fn) {
    try {
      fn();
    } catch (err) {
      this.log.warn(`[worker] ${job} job failed: ${err.message}`);
    }
  }

  /** Latest engine-written candle for a symbol (any timeframe, newest ts). */
  latestCandle(symbol) {
    return this.db
      .prepare("SELECT * FROM market_state WHERE symbol = ? ORDER BY ts DESC LIMIT 1")
      .get(symbol);
  }

  settlementSweep() {
    const positions = this.db.prepare("SELECT * FROM positions").all();
    let closed = 0;
    for (const position of positions) {
      const candle = this.latestCandle(position.symbol);
      if (!candle || candle.ts <= position.opened_at) continue; // no bar after entry yet
      const hasOpenSell = this.db
        .prepare("SELECT 1 FROM orders WHERE portfolio_id = ? AND symbol = ? AND side = 'SELL' AND status IN ('NEW','PARTIALLY_FILLED') LIMIT 1")
        .get(position.portfolio_id, position.symbol);
      if (hasOpenSell) continue; // engine is already exiting this position

      let reason = null;
      let rawPrice = null;
      if (position.stop_price != null && candle.low <= position.stop_price) {
        reason = "stop_loss";
        rawPrice = position.stop_price;
      } else if (position.target_price != null && candle.high >= position.target_price) {
        reason = "take_profit";
        rawPrice = position.target_price;
      } else if (candle.ts - position.opened_at >= this.stalePositionMs) {
        reason = "stale_position";
        rawPrice = candle.close;
      }
      if (!reason) continue;

      this.closePosition(position, rawPrice, reason, candle.ts);
      closed++;
    }
    if (closed > 0) this.log.info?.(`[worker] settlement sweep: closed ${closed} position(s)`);
  }

  closePosition(position, rawPrice, reason, ts) {
    const txn = this.db.transaction(() => {
      // Re-read inside the write lock: the engine may have (partially) sold
      // this position since the sweep query ran.
      const fresh = this.db.prepare("SELECT * FROM positions WHERE id = ?").get(position.id);
      if (!fresh || fresh.qty <= EPS) return false;

      const price = applySlippage(rawPrice, "SELL", this.slippageBps);
      const fee = feeFor(fresh.qty, price, this.feeBps);
      const proceeds = fresh.qty * price - fee;
      const orderInfo = this.db
        .prepare(
          `INSERT INTO orders (portfolio_id, symbol, side, qty, filled_qty, order_type, status, reason, requested_at, updated_at)
           VALUES (?, ?, 'SELL', ?, ?, 'MARKET', 'FILLED', ?, ?, ?)`
        )
        .run(fresh.portfolio_id, fresh.symbol, fresh.qty, fresh.qty, reason, ts, ts);
      this.db
        .prepare("INSERT INTO fills (order_id, qty, price, fee, filled_at) VALUES (?, ?, ?, ?, ?)")
        .run(orderInfo.lastInsertRowid, fresh.qty, price, fee, ts);
      this.db.prepare("UPDATE portfolios SET cash = cash + ? WHERE id = ?").run(proceeds, fresh.portfolio_id);
      const pnl = proceeds - fresh.qty * fresh.avg_entry_price - fresh.entry_fees;
      this.db
        .prepare("INSERT INTO trades (portfolio_id, symbol, qty, entry_price, exit_price, fees, pnl, reason, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(fresh.portfolio_id, fresh.symbol, fresh.qty, fresh.avg_entry_price, price, fresh.entry_fees + fee, pnl, reason, fresh.opened_at, ts);
      this.db.prepare("DELETE FROM positions WHERE id = ?").run(fresh.id);
      return pnl;
    });
    const pnl = txn.immediate();
    if (pnl !== false) {
      this.log.info?.(
        `[worker] settlement: closed portfolio #${position.portfolio_id} ${position.symbol} qty ${position.qty.toFixed(6)} (${reason}, pnl ${Number(pnl).toFixed(2)})`
      );
    }
  }

  snapshotEquity() {
    const now = Date.now();
    const portfolios = this.db.prepare("SELECT * FROM portfolios").all();
    for (const portfolio of portfolios) {
      const positions = this.db.prepare("SELECT * FROM positions WHERE portfolio_id = ?").all(portfolio.id);
      let equity = portfolio.cash;
      for (const position of positions) {
        const candle = this.latestCandle(position.symbol);
        // Without a price yet, value the position at entry (best available).
        equity += position.qty * (candle?.close ?? position.avg_entry_price);
      }
      this.db
        .prepare("INSERT INTO snapshots (portfolio_id, ts, equity, cash, open_positions) VALUES (?, ?, ?, ?, ?)")
        .run(portfolio.id, now, equity, portfolio.cash, positions.length);
      this.log.info?.(
        `[worker] snapshot: portfolio #${portfolio.id} (${portfolio.strategy_name}) equity ${equity.toFixed(2)}, cash ${portfolio.cash.toFixed(2)}, open ${positions.length}`
      );
    }
  }
}
