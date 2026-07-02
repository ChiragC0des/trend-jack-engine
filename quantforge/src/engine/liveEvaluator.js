/**
 * QUANTFORGE engine layer: incremental strategy evaluation (Phase 2).
 *
 * The Phase 1 evaluator precomputes indicator series over a FIXED candle
 * array. All of its indicators are causal (value at i depends only on candles
 * 0..i — see the Phase 1 lookahead-safety notes), so re-running it on a
 * growing array and reading the last index yields exactly the same signals as
 * a true streaming implementation. This wrapper does precisely that: it owns
 * the growing candle buffer and rebuilds the Phase 1 evaluator on each push,
 * reusing its rule logic verbatim rather than duplicating it. O(n) work per
 * candle is fine at paper-trading tick rates; a rolling `maxCandles` window
 * bounds it for long-running live sessions.
 */

import { createEvaluator } from "../strategy/evaluator.js";

export function createLiveEvaluator(strategy, options = {}) {
  const { externalSignals = null, log = console, maxCandles = 5000 } = options;
  const candles = [];

  // The Phase 1 evaluator warns once per instance about unwired
  // external_signal rules; since we rebuild it every candle, dedupe here so
  // the warning still appears exactly once per strategy.
  const warned = new Set();
  const dedupLog = {
    ...log,
    warn: (msg, ...rest) => {
      if (warned.has(msg)) return;
      warned.add(msg);
      log.warn(msg, ...rest);
    },
  };

  return {
    /**
     * Ingest one closed candle and evaluate the rules on it.
     * Returns { entry, exit, warm } for the newly appended candle.
     */
    push(candle) {
      candles.push(candle);
      if (candles.length > maxCandles) candles.shift();
      const evaluator = createEvaluator(strategy, candles, { externalSignals, log: dedupLog });
      const i = candles.length - 1;
      if (i < evaluator.warmup) return { entry: false, exit: false, warm: false };
      return { entry: evaluator.entrySignal(i), exit: evaluator.exitSignal(i), warm: true };
    },
    size: () => candles.length,
  };
}
