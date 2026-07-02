/**
 * QUANTFORGE engine layer: paper broker (Phase 2).
 *
 * All order/position/portfolio state lives in SQLite; this module is the only
 * ENGINE-side writer of it (the worker's settlement sweep is the other writer,
 * in its own process). Order lifecycle is explicit — NEW -> PARTIALLY_FILLED
 * -> FILLED, or NEW -> CANCELLED / REJECTED — never "instant fill at last
 * price":
 *
 *   - Orders rest until the NEXT tick and fill at that candle's open with
 *     slippage applied (buys worse/higher, sells worse/lower — same bps
 *     convention as the Phase 1 backtester).
 *   - Per tick, an order fills at most maxFillFractionPerTick of its remaining
 *     qty AND at most maxFillNotionalPerTick of notional, one `fills` row per
 *     increment, so large orders take several ticks to reach FILLED.
 *   - Sanity rejects: non-positive/non-finite qty, unknown side, and buys
 *     whose estimated cost exceeds portfolio cash.
 *
 * Every mutation runs in a transaction: WAL mode plus the busy timeout make
 * these safe against the worker process writing concurrently. A SELL fill
 * re-checks the position inside the transaction — if the worker already
 * settled it (stop/target/stale), the remainder of the order is cancelled
 * instead of double-closing.
 */

import { applySlippage, feeFor } from "../execution/fillMath.js";

const EPS = 1e-9;

export class PaperBroker {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {object} config { feeBps, slippageBps, maxFillFractionPerTick, maxFillNotionalPerTick, log }
   */
  constructor(db, config = {}) {
    this.db = db;
    this.feeBps = config.feeBps ?? 10;
    this.slippageBps = config.slippageBps ?? 5;
    this.maxFillFractionPerTick = config.maxFillFractionPerTick ?? 1;
    this.maxFillNotionalPerTick = config.maxFillNotionalPerTick ?? Infinity;
    this.log = config.log ?? console;
  }

  /** Find or create the isolated virtual portfolio for a strategy. */
  ensurePortfolio(strategyName, initialCash = 10_000) {
    const existing = this.db
      .prepare("SELECT * FROM portfolios WHERE strategy_name = ?")
      .get(strategyName);
    if (existing) return existing;
    const info = this.db
      .prepare("INSERT INTO portfolios (strategy_name, cash, initial_cash, created_at) VALUES (?, ?, ?, ?)")
      .run(strategyName, initialCash, initialCash, Date.now());
    return this.db.prepare("SELECT * FROM portfolios WHERE id = ?").get(info.lastInsertRowid);
  }

  getPortfolio(portfolioId) {
    return this.db.prepare("SELECT * FROM portfolios WHERE id = ?").get(portfolioId);
  }

  getPosition(portfolioId, symbol) {
    return this.db
      .prepare("SELECT * FROM positions WHERE portfolio_id = ? AND symbol = ?")
      .get(portfolioId, symbol);
  }

  openOrders(portfolioId, symbol) {
    return this.db
      .prepare(
        "SELECT * FROM orders WHERE portfolio_id = ? AND symbol = ? AND status IN ('NEW','PARTIALLY_FILLED') ORDER BY id"
      )
      .all(portfolioId, symbol);
  }

  /**
   * Place a market order. Returns the persisted order row, whose status is
   * NEW (resting, fills on later ticks) or REJECTED (with reason).
   * @param {object} p { portfolioId, symbol, side, qty, reason, ts,
   *                     refPrice, stopLossPct, takeProfitPct }
   */
  placeOrder({ portfolioId, symbol, side, qty, reason, ts, refPrice, stopLossPct = null, takeProfitPct = null }) {
    const insert = this.db.prepare(
      `INSERT INTO orders (portfolio_id, symbol, side, qty, order_type, status, reason, stop_loss_pct, take_profit_pct, requested_at, updated_at)
       VALUES (?, ?, ?, ?, 'MARKET', ?, ?, ?, ?, ?, ?)`
    );
    const persist = (status, why) => {
      const info = insert.run(portfolioId, symbol, side, qty, status, why, stopLossPct, takeProfitPct, ts, ts);
      const order = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(info.lastInsertRowid);
      if (status === "REJECTED") this.log.warn(`[broker] order ${order.id} REJECTED: ${why}`);
      return order;
    };

    if (!["BUY", "SELL"].includes(side)) return persist("REJECTED", `invalid side: ${side}`);
    if (!Number.isFinite(qty) || qty <= 0) return persist("REJECTED", `invalid qty: ${qty}`);
    if (side === "BUY") {
      const portfolio = this.getPortfolio(portfolioId);
      const estPrice = applySlippage(refPrice, "BUY", this.slippageBps);
      const estCost = qty * estPrice + feeFor(qty, estPrice, this.feeBps);
      if (estCost > portfolio.cash + EPS) {
        return persist("REJECTED", `insufficient cash: need ~${estCost.toFixed(2)}, have ${portfolio.cash.toFixed(2)}`);
      }
    }
    return persist("NEW", reason);
  }

  /** Cancel every resting order for a portfolio+symbol (or all symbols). */
  cancelOpenOrders(portfolioId, symbol = null, reason = "cancelled") {
    const rows = symbol
      ? this.openOrders(portfolioId, symbol)
      : this.db
          .prepare("SELECT * FROM orders WHERE portfolio_id = ? AND status IN ('NEW','PARTIALLY_FILLED')")
          .all(portfolioId);
    for (const order of rows) this.cancelOrder(order.id, reason);
    return rows.length;
  }

  cancelOrder(orderId, reason) {
    this.db
      .prepare("UPDATE orders SET status = 'CANCELLED', reason = COALESCE(reason,'') || ' | ' || ?, updated_at = ? WHERE id = ? AND status IN ('NEW','PARTIALLY_FILLED')")
      .run(reason, Date.now(), orderId);
  }

  /**
   * Fill resting orders for one symbol against a new candle. Called by the
   * engine on every tick BEFORE strategy rules are evaluated, so an order
   * placed on the close of candle i first fills at the open of candle i+1
   * (no lookahead, same convention as the Phase 1 backtester).
   */
  processTick(symbol, candle) {
    const orders = this.db
      .prepare("SELECT * FROM orders WHERE symbol = ? AND status IN ('NEW','PARTIALLY_FILLED') ORDER BY id")
      .all(symbol);
    for (const order of orders) {
      if (order.requested_at >= candle.timestamp) continue; // never fill on the signal candle
      this.fillOrderOnTick(order, candle);
    }
  }

  fillOrderOnTick(order, candle) {
    const txn = this.db.transaction(() => {
      const fresh = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id);
      if (!["NEW", "PARTIALLY_FILLED"].includes(fresh.status)) return;

      const price = applySlippage(candle.open, fresh.side, this.slippageBps);
      const remaining = fresh.qty - fresh.filled_qty;
      let fillQty = Math.min(
        remaining,
        remaining * this.maxFillFractionPerTick,
        this.maxFillNotionalPerTick / price
      );

      if (fresh.side === "BUY") {
        const portfolio = this.getPortfolio(fresh.portfolio_id);
        const affordable = portfolio.cash / (price * (1 + this.feeBps / 10_000));
        if (affordable < fillQty) fillQty = affordable;
        if (fillQty <= EPS) {
          this.cancelOrder(fresh.id, "insufficient cash for further fills");
          return;
        }
        this.applyBuyFill(fresh, fillQty, price, candle.timestamp);
      } else {
        const position = this.getPosition(fresh.portfolio_id, fresh.symbol);
        if (!position || position.qty <= EPS) {
          // Worker settled the position first — nothing left to sell.
          this.cancelOrder(fresh.id, "position already closed by settlement");
          return;
        }
        fillQty = Math.min(fillQty, position.qty);
        this.applySellFill(fresh, position, fillQty, price, candle.timestamp);
      }
    });
    txn.immediate();
  }

  applyBuyFill(order, qty, price, ts) {
    const fee = feeFor(qty, price, this.feeBps);
    this.db.prepare("INSERT INTO fills (order_id, qty, price, fee, filled_at) VALUES (?, ?, ?, ?, ?)").run(order.id, qty, price, fee, ts);
    this.db.prepare("UPDATE portfolios SET cash = cash - ? WHERE id = ?").run(qty * price + fee, order.portfolio_id);

    const position = this.getPosition(order.portfolio_id, order.symbol);
    const prevQty = position?.qty ?? 0;
    const prevCost = prevQty * (position?.avg_entry_price ?? 0);
    const newQty = prevQty + qty;
    const avgEntry = (prevCost + qty * price) / newQty;
    const stopPrice = order.stop_loss_pct != null ? avgEntry * (1 - order.stop_loss_pct / 100) : position?.stop_price ?? null;
    const targetPrice = order.take_profit_pct != null ? avgEntry * (1 + order.take_profit_pct / 100) : position?.target_price ?? null;
    if (position) {
      this.db
        .prepare("UPDATE positions SET qty = ?, avg_entry_price = ?, entry_fees = entry_fees + ?, stop_price = ?, target_price = ? WHERE id = ?")
        .run(newQty, avgEntry, fee, stopPrice, targetPrice, position.id);
    } else {
      this.db
        .prepare("INSERT INTO positions (portfolio_id, symbol, qty, avg_entry_price, entry_fees, stop_price, target_price, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(order.portfolio_id, order.symbol, newQty, avgEntry, fee, stopPrice, targetPrice, ts);
    }
    this.finalizeFillProgress(order, qty, ts);
  }

  applySellFill(order, position, qty, price, ts) {
    const fee = feeFor(qty, price, this.feeBps);
    this.db.prepare("INSERT INTO fills (order_id, qty, price, fee, filled_at) VALUES (?, ?, ?, ?, ?)").run(order.id, qty, price, fee, ts);
    this.db.prepare("UPDATE portfolios SET cash = cash + ? WHERE id = ?").run(qty * price - fee, order.portfolio_id);

    const remainingQty = position.qty - qty;
    if (remainingQty > EPS) {
      this.db.prepare("UPDATE positions SET qty = ? WHERE id = ?").run(remainingQty, position.id);
      this.finalizeFillProgress(order, qty, ts);
      return;
    }

    // Position fully closed: journal the round trip. Exit price is the
    // qty-weighted average across this order's fills.
    this.finalizeFillProgress(order, qty, ts, /* forceFilled */ true);
    const fills = this.db.prepare("SELECT * FROM fills WHERE order_id = ?").all(order.id);
    const soldQty = fills.reduce((s, f) => s + f.qty, 0);
    const proceeds = fills.reduce((s, f) => s + f.qty * f.price, 0);
    const exitFees = fills.reduce((s, f) => s + f.fee, 0);
    const exitPrice = proceeds / soldQty;
    const pnl = proceeds - exitFees - soldQty * position.avg_entry_price - position.entry_fees;
    this.db
      .prepare("INSERT INTO trades (portfolio_id, symbol, qty, entry_price, exit_price, fees, pnl, reason, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(order.portfolio_id, order.symbol, soldQty, position.avg_entry_price, exitPrice, position.entry_fees + exitFees, pnl, order.reason ?? "exit", position.opened_at, ts);
    this.db.prepare("DELETE FROM positions WHERE id = ?").run(position.id);
  }

  finalizeFillProgress(order, qty, ts, forceFilled = false) {
    const filled = order.filled_qty + qty;
    const done = forceFilled || filled >= order.qty - EPS;
    this.db
      .prepare("UPDATE orders SET filled_qty = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(filled, done ? "FILLED" : "PARTIALLY_FILLED", ts, order.id);
  }
}
