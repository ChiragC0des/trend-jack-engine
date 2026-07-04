/**
 * QUANTFORGE Phase 6: the gated live executor — the safety core.
 *
 * Every intended live order passes through ALL gates below IN ORDER; the
 * first failing gate journals a REJECTED `live_orders` row (+ notification +
 * log naming that gate) and NOTHING is sent anywhere. A broker is invoked
 * only after every gate has been evaluated, and the TESTNET broker is
 * invoked only when the mode gates resolved to 'testnet'. Structurally:
 * this module never imports ccxt — the testnet broker must be INJECTED by
 * the caller (src/live/index.js does so only when testnet mode is explicitly
 * requested and credentials exist), so a process that never injects it
 * (e.g. the offline demo) has no code path to an exchange at all.
 *
 * Gate order:
 *  1. promotion       — portfolio must exist with status='live' (i.e. it
 *                       passed promote(): typed confirmation + score >= 75).
 *                       Paper portfolios never place ANY live order, not
 *                       even a dry-run one.
 *  2. confidence      — latest confidence re-checked AT ORDER TIME: must
 *                       still be >= 75 (PROMOTION_MIN_SCORE) and not capped.
 *  3. kill_switch     — global kill switch must be disengaged.
 *  4. dry_run_window  — mode gate, never rejects: real placement is
 *                       FORBIDDEN until QF_DRY_RUN_HOURS (default 48) of
 *                       wall-clock time have elapsed since the portfolio's
 *                       dry_run_started_at (backfilled from promoted_at on
 *                       first contact; re-promotion restarts the window).
 *                       Until then the executor is FORCED into dry-run.
 *  5. live_enablement — mode gate, never rejects: even after the window,
 *                       testnet placement requires the explicit opt-in
 *                       QF_LIVE_MODE='testnet'. ANY other value (including
 *                       unset — the default) means dry-run. There is
 *                       deliberately no 'mainnet'/'live-real' value: this
 *                       phase has no real-funds path, by design.
 *  6. circuit breakers — each rejects on breach (defaults are testnet-small):
 *       order_size      non-finite/<=0 qty or price; notional above
 *                       QF_MAX_ORDER_NOTIONAL (default 500) or above the
 *                       portfolio's live_capital_cap.
 *       per_trade_risk  (BUY only) estimated loss-at-stop — |price-stop|*qty
 *                       when a stop is given, else a conservative 5% of
 *                       notional — must not exceed QF_PER_TRADE_RISK_PCT
 *                       (default 1) percent of live capital (live_capital_cap,
 *                       falling back to portfolio cash).
 *       max_concurrent  (BUY only) open live exposure — distinct symbols
 *                       whose SUBMITTED/FILLED live_orders net to a positive
 *                       qty, plus DRY_RUN buys within the current window's
 *                       journal — must stay below QF_MAX_CONCURRENT
 *                       (default 3).
 *       daily_loss      (BUY only) today's realized loss (UTC, from the
 *                       shared trades journal — same source as auto-demotion)
 *                       must not have breached the strategy's
 *                       risk.max_daily_loss_pct (default 5) of day-start
 *                       equity. Auto-demotion will revoke live status on its
 *                       next run; this breaker refuses NEW entries NOW.
 *       idempotency     a live_orders row already holding this deterministic
 *                       client_order_id in a non-REJECTED status means this
 *                       intent was already placed/journaled — the retry is
 *                       refused, never double-sent.
 */

import { latestConfidence, findStrategyByName } from "../confidence/score.js";
import { PROMOTION_MIN_SCORE } from "../confidence/promotion.js";
import { isKillSwitchEngaged } from "../confidence/killSwitch.js";
import { makeClientOrderId, recordLiveOrder } from "./liveOrders.js";

export const DEFAULT_DRY_RUN_HOURS = 48;
export const DEFAULT_MAX_ORDER_NOTIONAL = 500;
export const DEFAULT_PER_TRADE_RISK_PCT = 1;
export const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_DAILY_LOSS_PCT = 5; // same fallback as promotion.js
const ASSUMED_STOP_DISTANCE_PCT = 5; // risk proxy when the intent carries no stop
const HOUR_MS = 3_600_000;
const EPS = 1e-9;

export class LiveExecutor {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {object} config
   *   dryRunBroker    REQUIRED — the default sink for everything.
   *   testnetBroker   optional — omit it and testnet placement is
   *                   structurally impossible in this process.
   *   env             env source (default process.env; injectable for tests).
   */
  constructor(db, { dryRunBroker, testnetBroker = null, env = process.env, log = console, now = () => Date.now() } = {}) {
    if (!dryRunBroker) throw new Error("LiveExecutor requires a dryRunBroker");
    this.db = db;
    this.dryRunBroker = dryRunBroker;
    this.testnetBroker = testnetBroker;
    this.env = env;
    this.log = log;
    this.now = now;
    const num = (name, fallback) => {
      const v = Number(env[name]);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    this.dryRunHours = num("QF_DRY_RUN_HOURS", DEFAULT_DRY_RUN_HOURS);
    this.maxOrderNotional = num("QF_MAX_ORDER_NOTIONAL", DEFAULT_MAX_ORDER_NOTIONAL);
    this.perTradeRiskPct = num("QF_PER_TRADE_RISK_PCT", DEFAULT_PER_TRADE_RISK_PCT);
    this.maxConcurrent = num("QF_MAX_CONCURRENT", DEFAULT_MAX_CONCURRENT);
  }

  /** Configured mode: 'testnet' ONLY on the exact opt-in value, else dry-run. */
  configuredMode() {
    return this.env.QF_LIVE_MODE === "testnet" ? "testnet" : "dry_run";
  }

  /**
   * Backfill/refresh the portfolio's dry-run window start. NULL (fresh
   * promotion or pre-Phase-6 row) or stale (re-promoted after a demotion)
   * values become promoted_at, so the window always measures time in the
   * CURRENT live stint.
   */
  ensureDryRunWindow(portfolio) {
    const start = portfolio.promoted_at ?? this.now();
    if (portfolio.dry_run_started_at == null || (portfolio.promoted_at != null && portfolio.promoted_at > portfolio.dry_run_started_at)) {
      this.db.prepare("UPDATE portfolios SET dry_run_started_at = ? WHERE id = ?").run(start, portfolio.id);
      return start;
    }
    return portfolio.dry_run_started_at;
  }

  /**
   * Run one intended order through the gate stack and route it to a broker
   * (or refuse it). Always resolves — never throws for a refused order.
   * @param {object} intent { portfolioId, symbol, side, qty, price,
   *                          stopPrice?, reason?, clientOrderId? }
   */
  async execute({ portfolioId, symbol, side, qty, price, stopPrice = null, reason = null, clientOrderId = null }) {
    const now = this.now();
    const id = clientOrderId ?? makeClientOrderId({ portfolioId, symbol, side, qty, ts: now });
    const notional = qty * price;
    let mode = "dry_run"; // pessimistic until the mode gates say otherwise

    const refuse = (gate, why) => {
      const row = recordLiveOrder(this.db, {
        portfolioId, clientOrderId: id, symbol, side, qty,
        price: Number.isFinite(price) ? price : null,
        notional: Number.isFinite(notional) ? notional : null,
        mode, status: "REJECTED", gate, reason: why,
      }, { log: this.log, now });
      this.log.warn?.(`[live:executor] REFUSED ${side} ${qty} ${symbol} for portfolio #${portfolioId} — gate '${gate}': ${why}`);
      return { id: row.id, clientOrderId: row.client_order_id, status: "REJECTED", mode, gate, reason: why };
    };

    // --- gate 1: promotion ---------------------------------------------
    const portfolio = this.db.prepare("SELECT * FROM portfolios WHERE id = ?").get(portfolioId);
    if (!portfolio) return refuse("promotion", `no portfolio #${portfolioId} exists`);
    if (portfolio.status !== "live") {
      return refuse("promotion", `portfolio "${portfolio.strategy_name}" has status '${portfolio.status}' — only promoted live portfolios may reach the live executor`);
    }

    // --- gate 2: confidence still valid, re-checked at order time -------
    const confidence = latestConfidence(this.db, portfolio.id);
    if (!confidence) return refuse("confidence", "no confidence score on record");
    if (confidence.score < PROMOTION_MIN_SCORE || confidence.capped === 1) {
      return refuse("confidence", `latest confidence ${confidence.score}${confidence.capped === 1 ? " (capped)" : ""} no longer meets the live bar (>= ${PROMOTION_MIN_SCORE}, uncapped)`);
    }

    // --- gate 3: kill switch --------------------------------------------
    if (isKillSwitchEngaged(this.db)) {
      return refuse("kill_switch", "global kill switch is engaged — no live orders of any kind");
    }

    // --- gates 4 + 5: mode resolution (force dry-run, never reject) ------
    const windowStart = this.ensureDryRunWindow(portfolio);
    const elapsedMs = now - windowStart;
    const windowMs = this.dryRunHours * HOUR_MS;
    const windowElapsed = elapsedMs >= windowMs;
    let modeGate;
    if (this.configuredMode() !== "testnet") {
      modeGate = "live_enablement"; // default: no explicit QF_LIVE_MODE=testnet opt-in
    } else if (!windowElapsed) {
      modeGate = "dry_run_window";
      this.log.warn?.(
        `[live:executor] QF_LIVE_MODE=testnet requested but the mandatory dry-run window has not elapsed ` +
          `(${(elapsedMs / HOUR_MS).toFixed(1)}h of ${this.dryRunHours}h) — FORCED to dry-run`
      );
    } else {
      mode = "testnet";
      modeGate = "all_gates";
    }

    // --- gate 6: circuit breakers ----------------------------------------
    if (!Number.isFinite(qty) || qty <= 0) return refuse("order_size", `invalid qty: ${qty}`);
    if (!Number.isFinite(price) || price <= 0) return refuse("order_size", `invalid price: ${price}`);
    if (notional > this.maxOrderNotional) {
      return refuse("order_size", `notional ${notional.toFixed(2)} exceeds QF_MAX_ORDER_NOTIONAL ${this.maxOrderNotional}`);
    }
    if (portfolio.live_capital_cap != null && notional > portfolio.live_capital_cap) {
      return refuse("order_size", `notional ${notional.toFixed(2)} exceeds live_capital_cap ${portfolio.live_capital_cap}`);
    }

    if (side === "BUY") {
      const liveCapital = portfolio.live_capital_cap ?? portfolio.cash;
      const risk = stopPrice != null && Number.isFinite(stopPrice)
        ? Math.abs(price - stopPrice) * qty
        : notional * (ASSUMED_STOP_DISTANCE_PCT / 100);
      const maxRisk = liveCapital * (this.perTradeRiskPct / 100);
      if (risk > maxRisk + EPS) {
        return refuse("per_trade_risk", `estimated risk ${risk.toFixed(2)} exceeds ${this.perTradeRiskPct}% of live capital ${liveCapital} (max ${maxRisk.toFixed(2)})`);
      }

      const open = this.openLiveExposure(portfolio.id);
      if (open >= this.maxConcurrent) {
        return refuse("max_concurrent", `${open} open live exposures >= QF_MAX_CONCURRENT ${this.maxConcurrent}`);
      }

      const daily = this.dailyLossBreached(portfolio, now);
      if (daily) return refuse("daily_loss", daily);
    }

    // idempotency last: only an intent that would otherwise be PLACED is
    // checked for "already placed" (earlier rejections journal under ~rN).
    const existing = this.db
      .prepare("SELECT * FROM live_orders WHERE client_order_id = ? AND status != 'REJECTED'")
      .get(id);
    if (existing) {
      return refuse("idempotency", `duplicate of live_order #${existing.id} (${existing.status}, ${existing.mode}) — retry suppressed, never double-sent`);
    }

    // --- all gates evaluated: route --------------------------------------
    if (mode === "testnet" && !this.testnetBroker) {
      // Window elapsed + explicit opt-in, but this process has no testnet
      // broker (credentials missing / never injected). Fail safe, loudly.
      return refuse("testnet_guard", "testnet mode fully unlocked but no testnet broker is available (QF_BINANCE_TESTNET_KEY/SECRET missing or broker not injected) — refusing rather than falling through");
    }
    const broker = mode === "testnet" ? this.testnetBroker : this.dryRunBroker;
    return broker.placeOrder({ portfolioId, symbol, side, qty, price, clientOrderId: id, reason, gate: modeGate });
  }

  /**
   * Open live exposure = distinct symbols whose non-rejected live BUYs are
   * not fully offset by live SELLs. DRY_RUN rows count too — the journal is
   * the only live state Phase 6 has, and counting intents errs on the side
   * of refusing.
   */
  openLiveExposure(portfolioId) {
    const rows = this.db
      .prepare(
        `SELECT symbol, SUM(CASE WHEN side = 'BUY' THEN qty ELSE -qty END) AS net
         FROM live_orders
         WHERE portfolio_id = ? AND status IN ('DRY_RUN','SUBMITTED','FILLED')
         GROUP BY symbol`
      )
      .all(portfolioId);
    return rows.filter((r) => r.net > EPS).length;
  }

  /** Same daily-loss definition as promotion.js's auto-demotion trigger. */
  dailyLossBreached(portfolio, now) {
    const dayStart = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
    const { pnl } = this.db
      .prepare("SELECT COALESCE(SUM(pnl), 0) AS pnl FROM trades WHERE portfolio_id = ? AND closed_at >= ?")
      .get(portfolio.id, dayStart);
    if (pnl >= 0) return null;
    const snapshot = this.db
      .prepare("SELECT equity FROM snapshots WHERE portfolio_id = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1")
      .get(portfolio.id, dayStart);
    const dayStartEquity = snapshot?.equity ?? portfolio.initial_cash;
    const strategy = findStrategyByName(portfolio.strategy_name);
    const maxDailyLossPct = strategy?.risk?.max_daily_loss_pct ?? DEFAULT_MAX_DAILY_LOSS_PCT;
    if (dayStartEquity > 0 && (-pnl / dayStartEquity) * 100 >= maxDailyLossPct) {
      return `daily loss breached: ${(-pnl).toFixed(2)} lost today (>= ${maxDailyLossPct}% of day-start equity ${dayStartEquity.toFixed(2)}) — no new live entries today`;
    }
    return null;
  }
}
