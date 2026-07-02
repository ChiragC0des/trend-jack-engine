/**
 * QUANTFORGE strategy layer: rule evaluation (Phase 1).
 *
 * Compiles a validated strategy into an evaluator that answers, per candle
 * index, "are all entry rules true?" / "are all exit rules true?".
 *
 * Lookahead safety: every indicator series used by the rules is precomputed
 * by the indicator layer as a causal, candle-aligned array (value at i
 * depends only on candles 0..i), pattern checks only see a window ending at
 * i, and price-level lookbacks only use bars strictly before i. Evaluating
 * index i therefore never touches information from candles after i.
 *
 * `external_signal` conditions are ADVISORY-ONLY in Phase 1: no signal
 * provider exists yet (the trend-jack bridge is future-phase work), so they
 * evaluate as neutral (satisfied) and emit a one-time warning. A future
 * phase injects a provider via options.externalSignals.
 */

import { computeIndicatorSeries, indicatorKey, detectPattern } from "../indicators/index.js";

const CMP = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
};

/** Collect every indicator spec referenced by a strategy's rules. */
function collectIndicatorSpecs(strategy) {
  const specs = new Map();
  const add = (spec) => {
    if (spec) specs.set(indicatorKey(spec), spec);
  };
  for (const rule of [...strategy.entry_rules, ...strategy.exit_rules]) {
    if (rule.type === "indicator_comparison") {
      add(rule.indicator);
      add(rule.compare_to.indicator);
    }
  }
  return specs;
}

/**
 * Build an evaluator for one strategy over one candle array.
 * Returns { entrySignal(i), exitSignal(i), warmup } where warmup is the first
 * index at which every referenced indicator has a value.
 */
export function createEvaluator(strategy, candles, options = {}) {
  const { externalSignals = null, log = console } = options;

  // Precompute all indicator series once (causal — see header comment).
  const series = new Map();
  for (const [key, spec] of collectIndicatorSpecs(strategy)) {
    series.set(key, computeIndicatorSeries(spec, candles));
  }

  let warmup = 0;
  for (const s of series.values()) {
    const first = s.findIndex((v) => v !== null && v !== undefined);
    warmup = Math.max(warmup, first === -1 ? candles.length : first);
  }

  const warnedSignals = new Set();

  function seriesValue(spec, i) {
    return series.get(indicatorKey(spec))[i];
  }

  function targetValue(compareTo, i) {
    if ("value" in compareTo) return compareTo.value;
    if ("price" in compareTo) return candles[i][compareTo.price];
    return seriesValue(compareTo.indicator, i);
  }

  function evalIndicatorComparison(cond, i) {
    const left = seriesValue(cond.indicator, i);
    const right = targetValue(cond.compare_to, i);
    if (left == null || right == null) return false;

    if (cond.operator === "crosses_above" || cond.operator === "crosses_below") {
      if (i === 0) return false;
      const prevLeft = seriesValue(cond.indicator, i - 1);
      const prevRight = targetValue(cond.compare_to, i - 1);
      if (prevLeft == null || prevRight == null) return false;
      return cond.operator === "crosses_above"
        ? prevLeft <= prevRight && left > right
        : prevLeft >= prevRight && left < right;
    }
    return CMP[cond.operator](left, right);
  }

  function evalPriceLevel(cond, i) {
    let level;
    if (cond.level === "value") {
      level = cond.value;
    } else {
      // Rolling level over `lookback` bars strictly BEFORE the current one.
      const start = i - cond.lookback;
      if (start < 0) return false;
      const window = candles.slice(start, i);
      level =
        cond.level === "highest_high"
          ? Math.max(...window.map((c) => c.high))
          : Math.min(...window.map((c) => c.low));
    }
    const close = candles[i].close;
    const prevClose = i > 0 ? candles[i - 1].close : null;
    if (cond.direction === "breaks_above") {
      return close > level && (prevClose === null || prevClose <= level);
    }
    return close < level && (prevClose === null || prevClose >= level);
  }

  function evalExternalSignal(cond, i) {
    if (externalSignals && typeof externalSignals.getScore === "function") {
      const score = externalSignals.getScore({
        source: cond.source,
        keyword: cond.keyword,
        symbol: cond.symbol,
        timestamp: candles[i].timestamp,
      });
      return typeof score === "number" && score >= cond.min_score;
    }
    // Phase 1: advisory only — no provider wired, treat as neutral.
    const key = `${cond.source}:${cond.keyword ?? cond.symbol}`;
    if (!warnedSignals.has(key)) {
      warnedSignals.add(key);
      log.warn(
        `[quantforge] external_signal "${key}" has no provider in Phase 1 — treated as neutral (always satisfied).`
      );
    }
    return true;
  }

  function evalCondition(cond, i) {
    switch (cond.type) {
      case "indicator_comparison":
        return evalIndicatorComparison(cond, i);
      case "candlestick_pattern":
        return detectPattern(cond.pattern, candles, i);
      case "price_level":
        return evalPriceLevel(cond, i);
      case "external_signal":
        return evalExternalSignal(cond, i);
      default:
        throw new Error(`Unknown condition type: ${cond.type}`);
    }
  }

  const all = (rules, i) => rules.length > 0 && rules.every((c) => evalCondition(c, i));

  return {
    warmup,
    entrySignal: (i) => all(strategy.entry_rules, i),
    exitSignal: (i) => strategy.exit_rules.length > 0 && all(strategy.exit_rules, i),
  };
}
