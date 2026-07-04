/**
 * Strategy Lab (Phase 5 add-on): plain-English/Pine -> validated strategy ->
 * fixture backtest, all in-process and offline (stub provider when no key).
 *
 * ADVISORY ONLY. This module NEVER writes to orders / fills / positions /
 * portfolios / live_orders, never calls promote(), and never touches any
 * live or paper trading path. Its single DB write is one `recommendations`
 * row (the same advisory ledger the rest of the AI layer uses). The
 * generated strategy is returned to the caller, not persisted to
 * /strategies — the Lab can be clicked repeatedly without littering files.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { translateStrategyText } from "../../src/ai/translate.js";
import { assertValidStrategy } from "../../src/strategy/validate.js";
import { loadFixture } from "../../src/data/candleLoader.js";
import { backtest } from "../../src/execution/backtester.js";
import { logRecommendation } from "../../src/ai/recommendations.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const LAB_FIXTURES = {
  2017: {
    path: path.join(ROOT, "fixtures", "BTC_USD_1h_2017_bitfinex.json"),
    label: "BTC/USD 1h 2017 (real Bitfinex year, 8760 candles)",
  },
  synthetic: {
    path: path.join(ROOT, "fixtures", "BTC_USDT_1h_synthetic.json"),
    label: "BTC/USDT 1h synthetic (400 candles)",
  },
};

/** Bad request shape (missing input / unknown fixture) -> HTTP 400. */
export class LabInputError extends Error {}
/** Translation or schema validation failed -> HTTP 422. */
export class LabTranslationError extends Error {}

// Fixtures are immutable committed files — parse each once per process.
const candleCache = new Map();
async function getFixtureCandles(key) {
  if (!candleCache.has(key)) candleCache.set(key, await loadFixture(LAB_FIXTURES[key].path));
  return candleCache.get(key);
}

/** Downsample the full equity curve to <= maxPoints for the browser chart. */
function downsampleEquityCurve(curve, maxPoints = 200) {
  if (curve.length <= maxPoints) return curve.map((p) => ({ t: p.timestamp, equity: p.equity }));
  const step = (curve.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    const p = curve[Math.round(i * step)];
    out.push({ t: p.timestamp, equity: p.equity });
  }
  return out;
}

/**
 * Run the full Lab flow. Throws LabInputError / LabTranslationError for the
 * caller to map onto HTTP statuses.
 */
export async function runStrategyLab(db, { description, pine, fixture = "2017" } = {}, { log = console } = {}) {
  const input = typeof description === "string" && description.trim() ? description.trim()
    : typeof pine === "string" && pine.trim() ? pine.trim()
    : null;
  if (!input) throw new LabInputError("one of description or pine (non-empty string) is required");
  const fx = LAB_FIXTURES[fixture];
  if (!fx) throw new LabInputError(`unknown fixture "${fixture}" — use "2017" or "synthetic"`);

  let translated;
  try {
    translated = await translateStrategyText(input, { log });
    // Defense in depth: re-assert independently of the translator's own gate.
    assertValidStrategy(translated.strategy, `lab strategy "${translated.strategy?.name}"`);
  } catch (err) {
    throw new LabTranslationError(err.message);
  }
  const { strategy, provider, model } = translated;

  const candles = await getFixtureCandles(fixture);
  const { trades, equityCurve, metrics } = backtest(strategy, candles, {
    log: { warn: () => {}, info: () => {} },
  });
  const buyHoldPct = ((candles[candles.length - 1].close - candles[0].open) / candles[0].open) * 100;

  logRecommendation(db, {
    strategyName: strategy.name,
    type: "operation",
    title: `Strategy Lab: synthesized + backtested "${strategy.name}"`,
    body:
      `Input:\n${input}\n\nFixture: ${fx.label}\n` +
      `Backtest: return ${metrics.totalReturnPct.toFixed(2)}% vs buy&hold ${buyHoldPct.toFixed(2)}%, ` +
      `${metrics.trades} trades, win rate ${metrics.winRatePct.toFixed(1)}%, ` +
      `sharpe ${metrics.sharpe.toFixed(2)}, max DD ${metrics.maxDrawdownPct.toFixed(1)}%\n\n` +
      `Generated (schema-validated, NOT persisted, NOT promoted):\n${JSON.stringify(strategy, null, 2)}`,
    provider,
    model,
  });

  return {
    ok: true,
    strategy,
    // profitFactor can be Infinity (no losing trades); JSON has no Infinity.
    metrics: { ...metrics, profitFactor: Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : null },
    buyHoldPct,
    fixtureLabel: fx.label,
    candles: candles.length,
    equityCurve: downsampleEquityCurve(equityCurve),
    tradeCount: trades.length,
  };
}
