/**
 * QUANTFORGE data layer (Phase 1).
 *
 * Provides OHLCV candles to the rest of the system as a normalized array of
 * { timestamp, open, high, low, close, volume } objects, sorted by time.
 *
 * Two sources:
 *   - loadFixture(path): local JSON file (array of candle objects or ccxt-style
 *     [ts, o, h, l, c, v] arrays). Used by tests/demo so nothing here needs network.
 *   - fetchCandles(...): historical candles from a crypto exchange via ccxt.
 *     ccxt is imported lazily so offline use never pays for (or fails on) it.
 *
 * No other layer talks to exchanges or the filesystem for market data.
 */

import { readFile } from "node:fs/promises";

/** Normalize a raw candle (object or ccxt array) into the canonical shape. */
export function normalizeCandle(raw) {
  if (Array.isArray(raw)) {
    const [timestamp, open, high, low, close, volume] = raw;
    return { timestamp, open, high, low, close, volume };
  }
  const { timestamp, open, high, low, close, volume } = raw;
  for (const [key, v] of Object.entries({ timestamp, open, high, low, close, volume })) {
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new Error(`Invalid candle: field "${key}" is not a number`);
    }
  }
  return { timestamp, open, high, low, close, volume };
}

export function normalizeCandles(rawCandles) {
  if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
    throw new Error("Candle data must be a non-empty array");
  }
  const candles = rawCandles.map(normalizeCandle);
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

/** Load candles from a local JSON fixture file. */
export async function loadFixture(path) {
  const text = await readFile(path, "utf8");
  return normalizeCandles(JSON.parse(text));
}

/**
 * Fetch historical candles from an exchange via ccxt.
 * Requires network access; not used by the offline demo.
 */
export async function fetchCandles({ exchange = "binance", symbol, timeframe = "1h", limit = 500, since } = {}) {
  if (!symbol) throw new Error("fetchCandles requires a symbol, e.g. \"BTC/USDT\"");
  const ccxt = (await import("ccxt")).default;
  if (!(exchange in ccxt)) throw new Error(`Unknown ccxt exchange id: ${exchange}`);
  const client = new ccxt[exchange]({ enableRateLimit: true });
  const raw = await client.fetchOHLCV(symbol, timeframe, since, limit);
  return normalizeCandles(raw);
}

/**
 * Unified entry point: prefer a local fixture when given, otherwise go to ccxt.
 */
export async function getCandles({ fixture, ...ccxtOptions } = {}) {
  if (fixture) return loadFixture(fixture);
  return fetchCandles(ccxtOptions);
}
