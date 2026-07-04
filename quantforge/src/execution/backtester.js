/**
 * QUANTFORGE execution layer (Phase 1): backtester ONLY.
 *
 * Order-fill simulation for paper/live trading is a later phase; this module
 * strictly replays historical candles against a strategy.
 *
 * Model (kept deliberately simple for Phase 1):
 *   - Long-only, one position at a time, sized at risk.max_position_pct of
 *     current equity.
 *   - No lookahead: rules for candle i see only data up to and including i
 *     (guaranteed by the strategy evaluator), and a signal generated on the
 *     CLOSE of candle i fills at the OPEN of candle i+1.
 *   - Stop-loss / take-profit are checked intrabar against each candle's
 *     low/high while a position is open; when both could fire in the same
 *     candle the stop is assumed to fire first (conservative).
 *   - Fees and slippage are configurable in basis points and applied to
 *     every simulated fill: buys fill at price*(1+slippage), sells at
 *     price*(1-slippage), and fee = notional * feeBps on both sides.
 *   - risk.max_daily_loss_pct: once realized losses within a UTC day exceed
 *     this percent of the equity at the day's start, no new entries are
 *     opened until the next day.
 *
 * Output: full trade list, equity curve, and summary metrics (total return,
 * win rate, Sharpe, Sortino, max drawdown, profit factor).
 */

import { createEvaluator } from "../strategy/evaluator.js";
import { computeIndicatorSeries } from "../indicators/index.js";

const PERIODS_PER_YEAR = {
  "1m": 525600, "5m": 105120, "15m": 35040, "30m": 17520,
  "1h": 8760, "2h": 4380, "4h": 2190, "6h": 1460, "12h": 730,
  "1d": 365, "1w": 52,
};

function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function stddev(xs, mean) {
  if (xs.length < 2) return 0;
  const v = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/**
 * Run a backtest.
 * @param {object} strategy  validated strategy object
 * @param {Array}  candles   normalized candles from the data layer
 * @param {object} options   { feeBps, slippageBps, initialCapital, externalSignals, log }
 * @returns {{ trades: Array, metrics: object, equityCurve: Array }}
 */
export function backtest(strategy, candles, options = {}) {
  const {
    feeBps = 10,
    slippageBps = 5,
    initialCapital = 10_000,
    externalSignals = null,
    log = console,
  } = options;

  if (candles.length < 3) throw new Error("Backtest needs at least 3 candles");

  const fee = feeBps / 10_000;
  const slip = slippageBps / 10_000;
  const { risk } = strategy;

  const evaluator = createEvaluator(strategy, candles, { externalSignals, log });

  // Optional volatility-scaled exits: when risk.stop_atr_mult /
  // take_profit_atr_mult are set, stop/target distances at entry are that
  // multiple of ATR instead of a fixed percent. The ATR used for a fill at
  // candle i's open is atr[i-1] — the last fully-closed candle — so the
  // distance is knowable when the order was queued (no lookahead). While ATR
  // is warming up (null), the pct fields act as the documented fallback.
  const atrSeries =
    risk.stop_atr_mult != null || risk.take_profit_atr_mult != null
      ? computeIndicatorSeries({ name: "atr", params: { period: risk.atr_period ?? 14 } }, candles)
      : null;

  let cash = initialCapital;
  let position = null; // { qty, entryPrice, entryFee, entryIndex, stopPrice, targetPrice }
  let pendingEntry = false;
  let pendingExit = null; // reason string
  const trades = [];
  const equityCurve = [];

  let currentDay = utcDay(candles[0].timestamp);
  let dayStartEquity = initialCapital;
  let dayRealizedPnl = 0;

  const equityAt = (price) => cash + (position ? position.qty * price : 0);

  function closePosition(rawPrice, index, reason) {
    const fillPrice = rawPrice * (1 - slip);
    const proceeds = position.qty * fillPrice;
    const exitFee = proceeds * fee;
    cash += proceeds - exitFee;
    const cost = position.qty * position.entryPrice;
    const pnl = proceeds - exitFee - cost - position.entryFee;
    trades.push({
      entryTime: candles[position.entryIndex].timestamp,
      exitTime: candles[index].timestamp,
      entryIndex: position.entryIndex,
      exitIndex: index,
      entryPrice: position.entryPrice,
      exitPrice: fillPrice,
      qty: position.qty,
      fees: position.entryFee + exitFee,
      pnl,
      returnPct: (pnl / (cost + position.entryFee)) * 100,
      reason,
    });
    dayRealizedPnl += pnl;
    position = null;
  }

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // --- Day roll for the daily loss limit ---
    const day = utcDay(candle.timestamp);
    if (day !== currentDay) {
      currentDay = day;
      dayStartEquity = equityAt(candles[i - 1]?.close ?? candle.open);
      dayRealizedPnl = 0;
    }

    // --- Fill orders queued on the previous candle's close, at this open ---
    if (pendingExit && position) {
      closePosition(candle.open, i, pendingExit);
    }
    pendingExit = null;

    if (pendingEntry && !position) {
      const fillPrice = candle.open * (1 + slip);
      const budget = equityAt(candle.open) * (risk.max_position_pct / 100);
      const spend = Math.min(budget, cash);
      const qty = spend / (fillPrice * (1 + fee));
      if (qty > 0) {
        const entryFee = qty * fillPrice * fee;
        cash -= qty * fillPrice + entryFee;
        const atr = atrSeries?.[i - 1] ?? null;
        const stopDist =
          risk.stop_atr_mult != null && atr != null
            ? risk.stop_atr_mult * atr
            : fillPrice * (risk.stop_loss_pct / 100);
        const targetDist =
          risk.take_profit_atr_mult != null && atr != null
            ? risk.take_profit_atr_mult * atr
            : fillPrice * (risk.take_profit_pct / 100);
        position = {
          qty,
          entryPrice: fillPrice,
          entryFee,
          entryIndex: i,
          stopPrice: fillPrice - stopDist,
          targetPrice: fillPrice + targetDist,
        };
      }
    }
    pendingEntry = false;

    // --- Intrabar stop-loss / take-profit (stop checked first: conservative) ---
    if (position && i > position.entryIndex) {
      if (candle.low <= position.stopPrice) {
        closePosition(position.stopPrice, i, "stop_loss");
      } else if (candle.high >= position.targetPrice) {
        closePosition(position.targetPrice, i, "take_profit");
      }
    }

    // --- Evaluate rules on this candle's close; fills happen next candle ---
    if (i >= evaluator.warmup && i < candles.length - 1) {
      if (position) {
        if (evaluator.exitSignal(i)) pendingExit = "exit_rules";
      } else {
        const dailyLossPct = dayStartEquity > 0 ? (-dayRealizedPnl / dayStartEquity) * 100 : 0;
        if (dailyLossPct < risk.max_daily_loss_pct && evaluator.entrySignal(i)) {
          pendingEntry = true;
        }
      }
    }

    equityCurve.push({ timestamp: candle.timestamp, equity: equityAt(candle.close) });
  }

  // Force-close anything still open at the last candle's close.
  if (position) {
    closePosition(candles[candles.length - 1].close, candles.length - 1, "end_of_data");
    equityCurve[equityCurve.length - 1].equity = cash;
  }

  return {
    trades,
    equityCurve,
    metrics: computeMetrics({ trades, equityCurve, initialCapital, timeframe: strategy.timeframe }),
  };
}

/** Summary statistics from a trade list + equity curve. */
export function computeMetrics({ trades, equityCurve, initialCapital, timeframe }) {
  const finalEquity = equityCurve[equityCurve.length - 1].equity;
  const totalReturnPct = ((finalEquity - initialCapital) / initialCapital) * 100;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRatePct = trades.length ? (wins.length / trades.length) * 100 : 0;

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Per-candle equity returns, annualized by timeframe.
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    returns.push(prev > 0 ? equityCurve[i].equity / prev - 1 : 0);
  }
  const periodsPerYear = PERIODS_PER_YEAR[timeframe] ?? 8760;
  const mean = returns.length ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const sd = stddev(returns, mean);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0;

  const downside = returns.filter((r) => r < 0);
  const downsideDev = downside.length
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
    : 0;
  const sortino = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(periodsPerYear) : sharpe;

  let peak = -Infinity;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - point.equity) / peak) * 100);
  }

  return {
    trades: trades.length,
    finalEquity,
    totalReturnPct,
    winRatePct,
    sharpe,
    sortino,
    maxDrawdownPct,
    profitFactor,
  };
}
