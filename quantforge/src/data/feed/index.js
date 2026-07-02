/**
 * QUANTFORGE data layer: live price feed interface (Phase 2).
 *
 * A feed is an EventEmitter that pushes CLOSED candles to the engine. All
 * implementations share one contract so a real broker feed can swap in later
 * without touching the engine:
 *
 *   feed.subscribe(symbol, timeframe)   register interest before start()
 *   await feed.start()                  begin emitting
 *   await feed.stop()                   stop emitting / disconnect
 *
 * Events:
 *   "candle"  { symbol, timeframe, candle }   candle is the normalized
 *             { timestamp, open, high, low, close, volume } shape from the
 *             Phase 1 data layer, and is only emitted once the candle has
 *             CLOSED (the engine never sees a still-forming bar).
 *   "end"     the feed has no more data (finite feeds like fixture replay).
 *   "error"   non-fatal feed problem; implementations must NOT throw or
 *             crash the process on connection failures.
 *
 * Implementations: BinanceFeed (real WebSocket), FixtureReplayFeed (offline).
 */

export { Feed } from "./feed.js";
export { FixtureReplayFeed } from "./fixtureReplayFeed.js";
export { BinanceFeed } from "./binanceFeed.js";
