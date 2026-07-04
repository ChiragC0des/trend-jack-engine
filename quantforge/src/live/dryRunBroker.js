/**
 * QUANTFORGE Phase 6: the dry-run broker — the DEFAULT live broker.
 *
 * ============================= BROKER INTERFACE =============================
 * Every live broker implements the same two methods:
 *
 *   getMode() -> 'dry_run' | 'testnet'
 *
 *   async placeOrder({ portfolioId, symbol, side, qty, price, clientOrderId,
 *                      reason, gate }) ->
 *     { id, clientOrderId, status, mode, gate, reason }
 *
 * placeOrder is only ever called by the LiveExecutor AFTER every gate has
 * been evaluated (`gate` names the deciding gate for the journal). Brokers
 * never re-route to each other and never fall through: this one records and
 * logs, the testnet one submits or refuses.
 * ============================================================================
 *
 * This broker places NOTHING anywhere. It journals the exact order it WOULD
 * have sent (all fields, including the deterministic client order id) to
 * `live_orders` with mode='dry_run' / status='DRY_RUN', logs it, and writes
 * a notifications row. No exchange, no funds, no network, no ccxt import —
 * and no writes to the paper orders/fills/positions tables either: dry-run
 * is an audit trail of intent, not a simulation (Phase 2 already simulates).
 */

import { recordLiveOrder } from "./liveOrders.js";

export class DryRunBroker {
  constructor(db, { log = console } = {}) {
    this.db = db;
    this.log = log;
  }

  getMode() {
    return "dry_run";
  }

  async placeOrder({ portfolioId, symbol, side, qty, price, clientOrderId, reason, gate = null }) {
    const row = recordLiveOrder(this.db, {
      portfolioId,
      clientOrderId,
      symbol,
      side,
      qty,
      price,
      notional: Number.isFinite(qty * price) ? qty * price : null,
      mode: "dry_run",
      status: "DRY_RUN",
      gate,
      reason,
    }, { log: this.log });
    this.log.info?.(
      `[live:DRY-RUN] WOULD place ${side} ${qty} ${symbol} @ ~${price} (clientOrderId ${row.client_order_id})` +
        (gate ? ` [mode decided by: ${gate}]` : "")
    );
    return { id: row.id, clientOrderId: row.client_order_id, status: "DRY_RUN", mode: "dry_run", gate, reason };
  }
}
