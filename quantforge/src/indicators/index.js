/**
 * QUANTFORGE indicator/factor layer (Phase 1).
 *
 * Thin wrapper around the `technicalindicators` npm package. Two jobs:
 *
 *   1. computeIndicatorSeries(spec, candles): compute an indicator over the
 *      whole candle array and return it ALIGNED to the candles — output[i]
 *      is the indicator value on candle i, or null while the indicator is
 *      still warming up. All supported indicators are causal (value at i
 *      depends only on candles 0..i), so precomputing the full series and
 *      reading index i is exactly equivalent to computing on the prefix —
 *      that property is what lets the backtester guarantee no lookahead.
 *
 *   2. detectPattern(patternName, candles, index): candlestick pattern
 *      recognition on the window ENDING at `index`, delegated entirely to
 *      the pattern functions exported by `technicalindicators` (we do not
 *      hand-roll pattern detection).
 *
 * No strategy or execution logic lives here.
 */

import ti from "technicalindicators";

/** Max candles handed to a pattern function; covers the largest (3-candle + confirmation) patterns. */
const PATTERN_WINDOW = 10;

function sourceSeries(candles, source = "close") {
  if (!["open", "high", "low", "close", "volume"].includes(source)) {
    throw new Error(`Unknown price source: ${source}`);
  }
  return candles.map((c) => c[source]);
}

/** Left-pad an indicator result so result[i] lines up with candles[i]. */
function align(result, length) {
  const pad = new Array(length - result.length).fill(null);
  return pad.concat(result);
}

/**
 * Compute an aligned indicator series for a spec of the shape used in
 * strategy files: { name, params?, field? }.
 * Returns an array of numbers/null with the same length as `candles`.
 */
export function computeIndicatorSeries(spec, candles) {
  const { name, params = {}, field } = spec;
  const n = candles.length;
  const values = sourceSeries(candles, params.source ?? "close");

  switch (name) {
    case "volume":
      return candles.map((c) => c.volume);

    case "rsi":
      return align(ti.RSI.calculate({ period: params.period ?? 14, values }), n);

    case "sma":
      return align(ti.SMA.calculate({ period: params.period ?? 20, values }), n);

    case "ema":
      return align(ti.EMA.calculate({ period: params.period ?? 20, values }), n);

    case "macd": {
      const out = ti.MACD.calculate({
        values,
        fastPeriod: params.fast_period ?? 12,
        slowPeriod: params.slow_period ?? 26,
        signalPeriod: params.signal_period ?? 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      });
      const key = { macd: "MACD", signal: "signal", histogram: "histogram" }[field ?? "macd"];
      if (!key) throw new Error(`Unknown macd field: ${field}`);
      return align(out.map((p) => (p[key] === undefined ? null : p[key])), n);
    }

    case "bollinger": {
      const out = ti.BollingerBands.calculate({
        period: params.period ?? 20,
        stdDev: params.std_dev ?? 2,
        values,
      });
      const key = field ?? "middle";
      if (!["upper", "middle", "lower"].includes(key)) {
        throw new Error(`Unknown bollinger field: ${field}`);
      }
      return align(out.map((p) => p[key]), n);
    }

    case "atr":
      return align(
        ti.ATR.calculate({
          period: params.period ?? 14,
          high: candles.map((c) => c.high),
          low: candles.map((c) => c.low),
          close: candles.map((c) => c.close),
        }),
        n
      );

    default:
      throw new Error(`Unsupported indicator: ${name}`);
  }
}

/** Stable cache key for an indicator spec, so evaluators compute each series once. */
export function indicatorKey(spec) {
  return JSON.stringify({ name: spec.name, params: spec.params ?? {}, field: spec.field ?? null });
}

/**
 * True if the named candlestick pattern completes on candles[index].
 * The pattern function receives only candles up to and including `index`
 * (a small trailing window) — never future candles.
 */
export function detectPattern(patternName, candles, index) {
  const fn = ti[patternName];
  if (typeof fn !== "function") {
    throw new Error(`Unknown candlestick pattern: ${patternName} (not exported by technicalindicators)`);
  }
  const start = Math.max(0, index - PATTERN_WINDOW + 1);
  const window = candles.slice(start, index + 1);
  return Boolean(
    fn({
      open: window.map((c) => c.open),
      high: window.map((c) => c.high),
      low: window.map((c) => c.low),
      close: window.map((c) => c.close),
    })
  );
}
