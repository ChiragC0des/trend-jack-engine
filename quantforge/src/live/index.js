/**
 * QUANTFORGE Phase 6: live-execution runner entry point.
 *
 * Run with: npm run live    (or: node src/live/index.js)
 *
 * A SEPARATE OS process (like the engine / worker / dashboard) sharing the
 * WAL SQLite database. It mirrors the paper engine's orders for PROMOTED
 * portfolios through the gated LiveExecutor: the paper engine stays the
 * single signal source (its strategies keep evaluating on real feed data),
 * and this runner shadows each new paper order on a status='live' portfolio
 * as an intended live order — scaled down so a full paper position maps to
 * at most the portfolio's live_capital_cap. Every intent then faces the six
 * gates in src/live/executor.js; see that header for the exact order.
 *
 * DEFAULT BEHAVIOR IS A PURE DRY-RUN: with no configuration this process
 * journals "WOULD place ..." rows and touches no exchange and no funds.
 * The testnet broker (the only real adapter — Binance TESTNET via ccxt,
 * never mainnet) is dynamic-imported ONLY when QF_LIVE_MODE=testnet AND both
 * credentials are present, so in every other configuration no exchange code
 * is even loaded.
 *
 * Configuration via environment:
 *   QF_DB_PATH                 database file (default var/quantforge.db)
 *   QF_LIVE_MODE               'dry_run' (default) | 'testnet'. Any other
 *                              value falls back to dry_run. There is
 *                              deliberately NO mainnet value.
 *   QF_DRY_RUN_HOURS           mandatory dry-run window after promotion
 *                              before testnet placement is allowed (48)
 *   QF_BINANCE_TESTNET_KEY     Binance SPOT TESTNET API key
 *   QF_BINANCE_TESTNET_SECRET  Binance SPOT TESTNET API secret
 *   QF_MAX_ORDER_NOTIONAL      per-order notional ceiling (500)
 *   QF_PER_TRADE_RISK_PCT      max estimated risk per trade, % of live
 *                              capital (1)
 *   QF_MAX_CONCURRENT          max open live exposures per portfolio (3)
 *   QF_LIVE_POLL_MS            paper-order poll interval, ms (5000)
 */

import { openDb, DEFAULT_DB_PATH } from "../db/index.js";
import { DryRunBroker } from "./dryRunBroker.js";
import { LiveExecutor } from "./executor.js";

const db = openDb(process.env.QF_DB_PATH ?? DEFAULT_DB_PATH);
const pollMs = Number(process.env.QF_LIVE_POLL_MS) > 0 ? Number(process.env.QF_LIVE_POLL_MS) : 5_000;

let testnetBroker = null;
if (process.env.QF_LIVE_MODE === "testnet" && process.env.QF_BINANCE_TESTNET_KEY && process.env.QF_BINANCE_TESTNET_SECRET) {
  const { BinanceTestnetBroker } = await import("./binanceTestnetBroker.js");
  testnetBroker = new BinanceTestnetBroker(db);
  if (testnetBroker.refusal) console.warn(`[live] testnet broker constructed but refusing: ${testnetBroker.refusal}`);
}

const executor = new LiveExecutor(db, { dryRunBroker: new DryRunBroker(db), testnetBroker });
console.log(
  `[live] runner started — configured mode: ${executor.configuredMode()}` +
    (executor.configuredMode() === "dry_run"
      ? " (default; journal-only, no exchange, no funds — set QF_LIVE_MODE=testnet plus testnet keys to arm the TESTNET adapter after the dry-run window)"
      : testnetBroker
        ? " (Binance TESTNET armed — still subject to all six gates per order)"
        : " (requested, but credentials missing — every order will fail safe to REJECTED)")
);

// Start AFTER the current newest paper order: restarts never replay history
// (and the deterministic client ids would suppress any overlap anyway).
let lastOrderId = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM orders").get().id;

async function pollOnce() {
  const rows = db
    .prepare(
      `SELECT o.*, p.live_capital_cap, p.cash AS paper_cash
       FROM orders o JOIN portfolios p ON p.id = o.portfolio_id
       WHERE o.id > ? AND p.status = 'live'
       ORDER BY o.id`
    )
    .all(lastOrderId);
  lastOrderId = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM orders").get().id;

  for (const order of rows) {
    const price = db
      .prepare("SELECT close FROM market_state WHERE symbol = ? ORDER BY updated_at DESC LIMIT 1")
      .get(order.symbol)?.close;
    if (!price) continue; // no reference price yet — never guess
    // Scale the paper qty so the whole paper account maps onto the live cap.
    const scale = order.live_capital_cap != null && order.paper_cash > 0
      ? Math.min(order.live_capital_cap / (order.paper_cash + order.qty * price), 1)
      : 1;
    await executor.execute({
      portfolioId: order.portfolio_id,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty * scale,
      price,
      stopPrice: order.stop_loss_pct != null ? price * (1 - order.stop_loss_pct / 100) : null,
      reason: `mirror of paper order #${order.id} (${order.reason ?? "signal"})`,
    });
  }
}

let running = true;
const timer = setInterval(() => {
  if (!running) return;
  pollOnce().catch((err) => console.error(`[live] poll failed safely: ${err.message}`));
}, pollMs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[live] ${signal} received — shutting down`);
    running = false;
    clearInterval(timer);
    db.close();
    process.exit(0);
  });
}
