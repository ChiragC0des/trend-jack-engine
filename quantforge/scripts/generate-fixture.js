/**
 * Generates the synthetic OHLCV fixture used by the offline demo/tests.
 * Deterministic (seeded PRNG) so the fixture — and demo metrics — are
 * reproducible. Regenerate with: npm run generate-fixture
 *
 * 400 hourly candles alternating trending and ranging regimes so that both
 * example strategies produce a meaningful number of trades.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "BTC_USDT_1h_synthetic.json");

// Mulberry32 seeded PRNG — deterministic across runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(42);
const gauss = () => {
  // Box-Muller
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const N = 400;
const START_TS = Date.UTC(2025, 0, 1); // 2025-01-01T00:00Z
const HOUR = 3_600_000;

// Regime schedule: drift per candle (as fraction) and volatility.
const regimes = [
  { len: 60, drift: 0.0025, vol: 0.006 },  // strong uptrend
  { len: 50, drift: -0.0005, vol: 0.009 }, // choppy pullback
  { len: 70, drift: 0.002, vol: 0.007 },   // uptrend
  { len: 60, drift: -0.003, vol: 0.012 },  // sharp downtrend
  { len: 60, drift: 0.0002, vol: 0.005 },  // quiet range
  { len: 100, drift: 0.0022, vol: 0.008 }, // recovery uptrend
];

const candles = [];
let price = 30_000;
let i = 0;
for (const { len, drift, vol } of regimes) {
  for (let k = 0; k < len && i < N; k++, i++) {
    // Small open gaps vs the previous close so gap-sensitive candlestick
    // patterns (e.g. engulfing, which needs the second candle to open beyond
    // the first candle's close) can occur in the synthetic series.
    const open = price * (1 + 0.002 * gauss());
    const ret = drift + vol * gauss();
    const close = open * (1 + ret);
    const wick = Math.abs(vol * gauss()) * open;
    const high = Math.max(open, close) + wick * 0.6;
    const low = Math.min(open, close) - wick * 0.6;
    const volume = Math.round(80 + 60 * rand() + 400 * Math.abs(ret) * 100);
    candles.push({
      timestamp: START_TS + i * HOUR,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume,
    });
    price = close;
  }
}

await writeFile(OUT, JSON.stringify(candles, null, 1) + "\n");
console.log(`Wrote ${candles.length} candles to ${OUT}`);
