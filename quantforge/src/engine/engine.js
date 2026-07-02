/**
 * QUANTFORGE engine (Phase 2): live/paper trading loop.
 *
 * Runs one or more strategies concurrently against a price feed. Each
 * strategy trades an ISOLATED virtual portfolio (own cash, positions,
 * orders, journal — keyed by portfolio_id in SQLite); strategies never see
 * or touch each other's state.
 *
 * Per tick (closed candle), in order:
 *   1. persist the candle to market_state (this is how the separate worker
 *      process prices positions and checks stops — the engine and worker
 *      only communicate through the database),
 *   2. let the broker fill resting orders at this candle's open (so a signal
 *      on the close of candle i fills at the open of candle i+1 — same
 *      no-lookahead convention as the Phase 1 backtester),
 *   3. evaluate strategy rules on the candle close and place orders.
 *
 * The engine deliberately does NOT check stop/target hits or write equity
 * snapshots — settlement sweeps and snapshots are periodic jobs owned by the
 * worker process (src/worker/), never run inside the engine.
 */

import { PaperBroker } from "./paperBroker.js";
import { createLiveEvaluator } from "./liveEvaluator.js";

const EPS = 1e-9;

function utcDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export class Engine {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {object} config { feeBps, slippageBps, maxFillFractionPerTick,
   *                          maxFillNotionalPerTick, initialCash, log }
   */
  constructor(db, config = {}) {
    this.db = db;
    this.config = config;
    this.log = config.log ?? console;
    this.initialCash = config.initialCash ?? 10_000;
    this.broker = new PaperBroker(db, config);
    this.runners = []; // one per strategy: { strategy, portfolio, evaluator }
    this.feed = null;
  }

  /** Register a validated strategy; creates its portfolio if needed. */
  addStrategy(strategy) {
    const portfolio = this.broker.ensurePortfolio(strategy.name, this.initialCash);
    this.runners.push({
      strategy,
      portfolio,
      evaluator: createLiveEvaluator(strategy, { log: this.log }),
    });
    this.log.info?.(
      `[engine] strategy "${strategy.name}" -> portfolio #${portfolio.id} (cash ${portfolio.cash.toFixed(2)})`
    );
    return portfolio;
  }

  /** Wire the engine to a feed and subscribe to every strategy's markets. */
  attach(feed) {
    this.feed = feed;
    for (const { strategy } of this.runners) {
      for (const symbol of strategy.symbols) feed.subscribe(symbol, strategy.timeframe);
    }
    feed.on("candle", ({ symbol, timeframe, candle }) => this.onCandle(symbol, timeframe, candle));
    return this;
  }

  async start() {
    if (!this.feed) throw new Error("Engine.start(): call attach(feed) first");
    if (this.runners.length === 0) throw new Error("Engine.start(): no strategies added");
    await this.feed.start();
  }

  async stop({ cancelOpenOrders = true } = {}) {
    await this.feed?.stop();
    if (cancelOpenOrders) {
      for (const { portfolio, strategy } of this.runners) {
        const n = this.broker.cancelOpenOrders(portfolio.id, null, "engine shutdown");
        if (n > 0) this.log.info?.(`[engine] cancelled ${n} open order(s) for "${strategy.name}" on shutdown`);
      }
    }
  }

  onCandle(symbol, timeframe, candle) {
    this.db
      .prepare(
        `INSERT INTO market_state (symbol, timeframe, ts, open, high, low, close, volume, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (symbol, timeframe) DO UPDATE SET
           ts = excluded.ts, open = excluded.open, high = excluded.high, low = excluded.low,
           close = excluded.close, volume = excluded.volume, updated_at = excluded.updated_at`
      )
      .run(symbol, timeframe, candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume, Date.now());

    this.broker.processTick(symbol, candle);

    for (const runner of this.runners) {
      if (!runner.strategy.symbols.includes(symbol) || runner.strategy.timeframe !== timeframe) continue;
      this.evaluateRunner(runner, symbol, candle);
    }
  }

  evaluateRunner(runner, symbol, candle) {
    const { strategy, portfolio } = runner;
    const { entry, exit, warm } = runner.evaluator.push(candle);
    if (!warm) return;

    const position = this.broker.getPosition(portfolio.id, symbol);
    const open = this.broker.openOrders(portfolio.id, symbol);
    const hasOpenBuy = open.some((o) => o.side === "BUY");
    const hasOpenSell = open.some((o) => o.side === "SELL");

    if (position && position.qty > EPS) {
      if (exit && !hasOpenSell) {
        // Exiting supersedes entering: drop any unfilled remainder of the
        // entry order so we do not buy back into a position we are leaving.
        if (hasOpenBuy) this.broker.cancelOpenOrders(portfolio.id, symbol, "superseded by exit signal");
        const order = this.broker.placeOrder({
          portfolioId: portfolio.id,
          symbol,
          side: "SELL",
          qty: position.qty,
          reason: "exit_rules",
          ts: candle.timestamp,
          refPrice: candle.close,
        });
        this.log.info?.(`[engine] ${strategy.name}: exit signal -> SELL order #${order.id} qty ${position.qty.toFixed(6)}`);
      }
      return;
    }

    if (entry && !hasOpenBuy && !hasOpenSell && !this.dailyLossLimitHit(portfolio.id, strategy, candle)) {
      const fresh = this.broker.getPortfolio(portfolio.id);
      const budget = Math.min(fresh.cash * (strategy.risk.max_position_pct / 100), fresh.cash);
      const qty = budget / (candle.close * (1 + (this.broker.slippageBps + this.broker.feeBps) / 10_000));
      const order = this.broker.placeOrder({
        portfolioId: portfolio.id,
        symbol,
        side: "BUY",
        qty,
        reason: "entry_rules",
        ts: candle.timestamp,
        refPrice: candle.close,
        stopLossPct: strategy.risk.stop_loss_pct,
        takeProfitPct: strategy.risk.take_profit_pct,
      });
      if (order.status !== "REJECTED") {
        this.log.info?.(`[engine] ${strategy.name}: entry signal -> BUY order #${order.id} qty ${qty.toFixed(6)} @ ~${candle.close.toFixed(2)}`);
      }
    }
  }

  /**
   * risk.max_daily_loss_pct: block NEW entries once realized losses within
   * the current UTC market day exceed the limit (as a percent of equity at
   * the start of the day, approximated by current cash + the day's losses).
   */
  dailyLossLimitHit(portfolioId, strategy, candle) {
    const day = utcDay(candle.timestamp);
    const dayStart = Date.parse(`${day}T00:00:00Z`);
    const { pnl } = this.db
      .prepare("SELECT COALESCE(SUM(pnl), 0) AS pnl FROM trades WHERE portfolio_id = ? AND closed_at >= ?")
      .get(portfolioId, dayStart);
    if (pnl >= 0) return false;
    const cash = this.broker.getPortfolio(portfolioId).cash;
    const dayStartEquity = cash - pnl;
    const hit = dayStartEquity > 0 && (-pnl / dayStartEquity) * 100 >= strategy.risk.max_daily_loss_pct;
    if (hit) this.log.warn(`[engine] ${strategy.name}: daily loss limit hit — entries blocked for ${day}`);
    return hit;
  }
}
