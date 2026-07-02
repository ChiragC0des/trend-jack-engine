/**
 * QUANTFORGE confidence layer (Phase 3): the confidence score.
 *
 * A weighted composite in [0, 100] answering "how much should we trust this
 * strategy's PAPER track record?". Recomputed periodically by the worker's
 * confidence job (never by the engine, never at read time) and persisted to
 * `confidence_scores` with its full per-component breakdown. Only the latest
 * row per portfolio is current; older rows are history.
 *
 * ================================ FORMULA ================================
 *
 * score = win_rate_score        (max 20)
 *       + profit_factor_score   (max 20)
 *       + sharpe_score          (max 20)
 *       + drawdown_score        (max 15)
 *       + sample_size_score     (max 15)
 *       + consistency_score     (max 10)
 * then HARD-CAPPED at 60 unless trades >= 50 AND calendar days >= 14.
 *
 * 1. Paper win rate vs breakeven-after-fees — 20%.
 *    Fees are already inside each trade's pnl, so the breakeven win rate
 *    implied by the strategy's OWN payoff profile is
 *        breakeven_wr = avg_loss / (avg_win + avg_loss)
 *    (avg_win = mean pnl of winning trades, avg_loss = |mean pnl of losing
 *    trades|). A strategy winning exactly breakeven_wr of the time nets zero.
 *    Score: 0 at wr <= breakeven, full 20 at wr >= breakeven + 30 percentage
 *    points, linear between. +30pp was chosen because a strategy sustainably
 *    beating its own breakeven by 30pp is an unambiguous edge; anything more
 *    would let near-coin-flip payoffs max out too easily.
 *    Guards: no trades -> 0. No losing trades -> breakeven_wr = 0 (any win
 *    is pure profit, so the observed wr scores directly against +30pp). No
 *    winning trades -> breakeven_wr = 1, score 0.
 *
 * 2. Profit factor — 20%.
 *    gross_profit / gross_loss. 0 at PF <= 1 (breakeven or worse), full 20
 *    at PF >= 3, linear between. Ceiling 3 because PF of 3 ("makes $3 per $1
 *    lost") is already exceptional for a real strategy — rewarding beyond it
 *    only favors tiny lucky samples. No losing trades (infinite PF) = full
 *    marks: with the sample-size cap in place a small perfect sample cannot
 *    reach promotion anyway.
 *
 * 3. Sharpe — 20%.
 *    Annualized Sharpe over the PAPER equity curve, i.e. snapshot-to-snapshot
 *    returns from the `snapshots` table — same annualization approach as the
 *    Phase 1 backtester (PERIODS_PER_YEAR keyed by the strategy's timeframe;
 *    each snapshot is treated as one strategy-timeframe period; defaults to
 *    "1h" when the strategy file is unavailable). 0 at Sharpe <= 0, full 20
 *    at Sharpe >= 2, linear between. Sharpe 2 is the conventional
 *    "excellent" threshold; demanding more mostly rewards short samples.
 *
 * 4. Max drawdown penalty — 15%.
 *    Max peak-to-trough drawdown of the same snapshot equity curve. Full 15
 *    at drawdown <= 5% (noise-level for a paper account), 0 at >= 25% (a
 *    quarter of the account gone is disqualifying), linear between.
 *
 * 5. Sample-size factor — 15%, plus the HARD CAP.
 *    sub-score = 15 * min(trades / 50, 1) * min(days / 14, 1)
 *    where days = wall-clock calendar time from portfolios.created_at to
 *    Date.now() (NOT candle/market time). Separately from this smooth
 *    sub-score, the FINAL composite is hard-capped at 60 until BOTH floors
 *    are met (>= 50 closed trades AND >= 14 days) — the promotion gate needs
 *    >= 75, so an immature portfolio can never be promoted no matter how
 *    good its short run looks. The capped state is stored as an explicit
 *    `capped` flag, not just an implicit number.
 *
 * 6. Backtest <-> paper consistency — 10%.
 *    Compares the paper portfolio's realized win rate and average per-trade
 *    return against the SAME strategy's Phase 1 backtest metrics (cached in
 *    `backtest_metrics`, computed from the same strategy file against the
 *    committed fixture). Only UNDERperformance is penalized — paper doing
 *    better than backtest is fine. Distance metric: two 5-point halves,
 *      - win-rate half: full 5 if paper wr >= backtest wr, sliding linearly
 *        to 0 when paper wr is 20 percentage points below backtest;
 *      - avg-trade-return half: full 5 if paper avg return >= backtest avg
 *        return, sliding linearly to 0 when paper is 2 percentage points
 *        (per trade) below backtest.
 *    20pp of win rate / 2pp of per-trade return below backtest means the
 *    live behavior does not resemble what was validated — zero credit.
 *    If NO backtest metrics exist for the strategy, this component scores 0
 *    (documented choice: consistency is a claim that must be EVIDENCED; an
 *    unverifiable claim earns nothing rather than free marks).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { assertValidStrategy } from "../strategy/validate.js";
import { normalizeCandles } from "../data/candleLoader.js";
import { backtest } from "../execution/backtester.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STRATEGIES_DIR = path.join(ROOT, "strategies");
const DEFAULT_FIXTURE = path.join(ROOT, "fixtures", "BTC_USDT_1h_synthetic.json");

// Same table as the Phase 1 backtester — one Sharpe convention everywhere.
const PERIODS_PER_YEAR = {
  "1m": 525600, "5m": 105120, "15m": 35040, "30m": 17520,
  "1h": 8760, "2h": 4380, "4h": 2190, "6h": 1460, "12h": 730,
  "1d": 365, "1w": 52,
};

const DAY_MS = 86_400_000;

export const SAMPLE_FLOOR_TRADES = 50;
export const SAMPLE_FLOOR_DAYS = 14;
export const HARD_CAP_SCORE = 60;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Synchronous strategy-file lookup by name (worker jobs are synchronous).
 * Returns the validated strategy object, or null when no file exists —
 * portfolios can legitimately outlive their strategy file (or, like the
 * demo's seeded portfolio, never have had one).
 */
export function findStrategyByName(strategyName, strategiesDir = STRATEGIES_DIR) {
  for (const ext of [".json", ".yaml", ".yml"]) {
    const file = path.join(strategiesDir, strategyName + ext);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const parsed = ext === ".json" ? JSON.parse(text) : YAML.parse(text);
    return assertValidStrategy(parsed, path.basename(file));
  }
  return null;
}

/**
 * Return cached Phase 1 backtest metrics for a strategy, computing and
 * caching them (real `backtest()` against the committed fixture) on first
 * use. Returns null when the strategy has no file and nothing was seeded —
 * the consistency component then scores 0 (see formula doc above).
 */
export function ensureBacktestMetrics(db, strategyName, { fixturePath = DEFAULT_FIXTURE, log = console } = {}) {
  const cached = db.prepare("SELECT * FROM backtest_metrics WHERE strategy_name = ?").get(strategyName);
  if (cached) return cached;

  const strategy = findStrategyByName(strategyName);
  if (!strategy) return null;

  const candles = normalizeCandles(JSON.parse(fs.readFileSync(fixturePath, "utf8")));
  const result = backtest(strategy, candles, { log: { warn: () => {}, info: () => {} } });
  const avgTradeReturnPct = result.trades.length
    ? result.trades.reduce((s, t) => s + t.returnPct, 0) / result.trades.length
    : 0;
  const row = {
    strategy_name: strategyName,
    trades: result.metrics.trades,
    win_rate_pct: result.metrics.winRatePct,
    avg_trade_return_pct: avgTradeReturnPct,
    // Infinite PF (no losses) is not representable in SQLite REAL; store a
    // large sentinel — only win rate + avg return are used for consistency.
    profit_factor: Number.isFinite(result.metrics.profitFactor) ? result.metrics.profitFactor : 999,
    source: "backtest",
    computed_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO backtest_metrics (strategy_name, trades, win_rate_pct, avg_trade_return_pct, profit_factor, source, computed_at)
     VALUES (@strategy_name, @trades, @win_rate_pct, @avg_trade_return_pct, @profit_factor, @source, @computed_at)`
  ).run(row);
  log.info?.(`[confidence] cached backtest metrics for "${strategyName}" (${row.trades} trades, wr ${row.win_rate_pct.toFixed(1)}%)`);
  return row;
}

/**
 * Compute the full confidence breakdown for one portfolio row. Pure read —
 * persisting is the caller's job (see recordConfidence / the worker job).
 * @returns {{ score, capped, winRateScore, profitFactorScore, sharpeScore,
 *             drawdownScore, sampleSizeScore, consistencyScore,
 *             tradesCount, daysElapsed }}
 */
export function computeConfidence(db, portfolio, { now = Date.now(), log = console } = {}) {
  const trades = db
    .prepare("SELECT pnl, qty, entry_price, fees FROM trades WHERE portfolio_id = ? ORDER BY closed_at")
    .all(portfolio.id);
  const snapshots = db
    .prepare("SELECT ts, equity FROM snapshots WHERE portfolio_id = ? ORDER BY ts, id")
    .all(portfolio.id);

  // --- 1. Win rate vs breakeven (20) ---
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = trades.length ? wins.length / trades.length : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  let winRateScore = 0;
  if (trades.length > 0 && avgWin + avgLoss > 0) {
    const breakevenWr = avgLoss / (avgWin + avgLoss); // 0 when no losses, 1 when no wins
    winRateScore = 20 * clamp01((winRate - breakevenWr) / 0.30);
  }

  // --- 2. Profit factor (20) ---
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const profitFactorScore = profitFactor === Infinity ? 20 : 20 * clamp01((profitFactor - 1) / 2);

  // --- 3. Sharpe over snapshot-to-snapshot returns (20) ---
  const strategy = findStrategyByName(portfolio.strategy_name);
  const periodsPerYear = PERIODS_PER_YEAR[strategy?.timeframe] ?? 8760;
  const returns = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1].equity;
    returns.push(prev > 0 ? snapshots[i].equity / prev - 1 : 0);
  }
  let sharpe = 0;
  if (returns.length >= 2) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const sd = Math.sqrt(variance);
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0;
  }
  const sharpeScore = 20 * clamp01(sharpe / 2);

  // --- 4. Max drawdown penalty (15) ---
  let peak = -Infinity;
  let maxDrawdownPct = 0;
  for (const s of snapshots) {
    peak = Math.max(peak, s.equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - s.equity) / peak) * 100);
  }
  const drawdownScore = 15 * clamp01((25 - maxDrawdownPct) / (25 - 5));

  // --- 5. Sample size (15) + hard-cap state ---
  const daysElapsed = Math.max(0, (now - portfolio.created_at) / DAY_MS);
  const sampleSizeScore =
    15 * Math.min(trades.length / SAMPLE_FLOOR_TRADES, 1) * Math.min(daysElapsed / SAMPLE_FLOOR_DAYS, 1);
  const capped = trades.length < SAMPLE_FLOOR_TRADES || daysElapsed < SAMPLE_FLOOR_DAYS;

  // --- 6. Backtest <-> paper consistency (10) ---
  let consistencyScore = 0;
  const bt = ensureBacktestMetrics(db, portfolio.strategy_name, { log });
  if (bt && trades.length > 0) {
    const paperWrPct = winRate * 100;
    // Per-trade return on capital deployed (entry notional + fees) — the
    // same base the backtester's returnPct uses.
    const paperAvgReturnPct =
      trades.reduce((s, t) => s + (t.pnl / (t.qty * t.entry_price + t.fees)) * 100, 0) / trades.length;
    const wrHalf = 5 * clamp01(1 - Math.max(0, bt.win_rate_pct - paperWrPct) / 20);
    const retHalf = 5 * clamp01(1 - Math.max(0, bt.avg_trade_return_pct - paperAvgReturnPct) / 2);
    consistencyScore = wrHalf + retHalf;
  }
  // (no backtest metrics or no paper trades -> 0, per the formula doc)

  const raw =
    winRateScore + profitFactorScore + sharpeScore + drawdownScore + sampleSizeScore + consistencyScore;
  const score = Math.round(capped ? Math.min(raw, HARD_CAP_SCORE) : raw);

  return {
    score,
    capped,
    winRateScore,
    profitFactorScore,
    sharpeScore,
    drawdownScore,
    sampleSizeScore,
    consistencyScore,
    tradesCount: trades.length,
    daysElapsed,
  };
}

/** Compute AND persist a confidence row for one portfolio; returns the breakdown. */
export function recordConfidence(db, portfolio, options = {}) {
  const b = computeConfidence(db, portfolio, options);
  db.prepare(
    `INSERT INTO confidence_scores
       (portfolio_id, ts, score, capped, win_rate_score, profit_factor_score, sharpe_score,
        drawdown_score, sample_size_score, consistency_score, trades_count, days_elapsed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    portfolio.id,
    options.now ?? Date.now(),
    b.score,
    b.capped ? 1 : 0,
    b.winRateScore,
    b.profitFactorScore,
    b.sharpeScore,
    b.drawdownScore,
    b.sampleSizeScore,
    b.consistencyScore,
    b.tradesCount,
    b.daysElapsed
  );
  return b;
}

/** Latest persisted confidence row for a portfolio (null if never scored). */
export function latestConfidence(db, portfolioId) {
  return db
    .prepare("SELECT * FROM confidence_scores WHERE portfolio_id = ? ORDER BY ts DESC, id DESC LIMIT 1")
    .get(portfolioId);
}
