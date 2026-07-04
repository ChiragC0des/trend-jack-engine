/**
 * QUANTFORGE Phase 6: the Binance TESTNET broker — the ONLY real adapter.
 *
 * Implements the broker interface documented in dryRunBroker.js.
 *
 * TESTNET ONLY, by construction:
 *   - the exchange handle is created solely via setSandboxMode(true);
 *   - after that call, every resolved ccxt endpoint URL is VERIFIED to point
 *     at the Binance testnet — if even one URL is not a testnet URL (or
 *     looks like the production host), the handle is discarded and this
 *     broker refuses to place, permanently;
 *   - there is deliberately NO mainnet code path, no flag, no env value that
 *     selects real Binance. Real funds are out of scope for Phase 6.
 *
 * Fail-safe rules:
 *   - missing QF_BINANCE_TESTNET_KEY / QF_BINANCE_TESTNET_SECRET -> every
 *     placeOrder returns REJECTED (journaled, notified) — never a
 *     fallthrough to anything else, never an uncaught throw;
 *   - any ccxt/network/auth error is caught, logged, and journaled as
 *     REJECTED. This process never dies because an exchange call failed.
 *
 * This module is the ONLY file in the live layer that imports ccxt (the only
 * other ccxt use anywhere is Phase 1's optional historical-candle fetch), and it is
 * never imported by the offline demo (src/live/demo.js) or by the executor —
 * src/live/index.js dynamic-imports it only when testnet mode is explicitly
 * requested AND credentials exist, so nothing else ever loads exchange code.
 */

import ccxt from "ccxt";
import { recordLiveOrder } from "./liveOrders.js";

const PRODUCTION_HOST = "api.binance.com";

function collectUrls(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectUrls(v, out);
  return out;
}

export class BinanceTestnetBroker {
  constructor(db, { apiKey = process.env.QF_BINANCE_TESTNET_KEY, secret = process.env.QF_BINANCE_TESTNET_SECRET, log = console } = {}) {
    this.db = db;
    this.log = log;
    this.exchange = null;
    this.refusal = null; // permanent refusal reason when a construction guard fails

    if (!apiKey || !secret) {
      this.refusal = "testnet credentials missing (QF_BINANCE_TESTNET_KEY / QF_BINANCE_TESTNET_SECRET)";
      return;
    }
    try {
      const exchange = new ccxt.binance({ apiKey, secret, options: { defaultType: "spot" } });
      exchange.setSandboxMode(true);
      const urls = collectUrls(exchange.urls.api);
      const sandboxConfirmed =
        urls.length > 0 && urls.every((u) => u.includes("testnet") && !u.includes(PRODUCTION_HOST));
      if (!sandboxConfirmed) {
        this.refusal = "sandbox mode could not be confirmed (a resolved API URL does not point at the Binance testnet)";
        return;
      }
      this.exchange = exchange;
    } catch (err) {
      this.refusal = `failed to initialize ccxt sandbox mode: ${err.message}`;
    }
  }

  getMode() {
    return "testnet";
  }

  async placeOrder({ portfolioId, symbol, side, qty, price, clientOrderId, reason, gate = null }) {
    const base = {
      portfolioId,
      clientOrderId,
      symbol,
      side,
      qty,
      price,
      notional: Number.isFinite(qty * price) ? qty * price : null,
      mode: "testnet",
    };
    const refuse = (gateName, why) => {
      const row = recordLiveOrder(this.db, { ...base, status: "REJECTED", gate: gateName, reason: why }, { log: this.log });
      this.log.warn?.(`[live:testnet] REFUSED ${side} ${qty} ${symbol}: ${why}`);
      return { id: row.id, clientOrderId: row.client_order_id, status: "REJECTED", mode: "testnet", gate: gateName, reason: why };
    };

    if (!this.exchange) return refuse("testnet_guard", this.refusal);

    try {
      const result = await this.exchange.createOrder(symbol, "market", side.toLowerCase(), qty, undefined, {
        newClientOrderId: clientOrderId,
      });
      const status = result?.status === "closed" ? "FILLED" : "SUBMITTED";
      const row = recordLiveOrder(this.db, { ...base, status, gate, reason }, { log: this.log });
      this.log.info?.(
        `[live:testnet] ${status} ${side} ${qty} ${symbol} @ ~${price} (clientOrderId ${row.client_order_id}, exchange id ${result?.id ?? "?"})`
      );
      return { id: row.id, clientOrderId: row.client_order_id, status, mode: "testnet", gate, reason, exchangeOrderId: result?.id ?? null };
    } catch (err) {
      // Network / auth / exchange errors NEVER propagate: journal + refuse.
      return refuse("testnet_error", `testnet call failed safely: ${err.message}`);
    }
  }
}
