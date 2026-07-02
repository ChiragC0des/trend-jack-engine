/**
 * QUANTFORGE engine process entry point (Phase 2).
 *
 * Run with: npm run engine    (or: node src/engine/index.js [strategy files...])
 *
 * Defaults to running BOTH example strategies against the live Binance
 * WebSocket feed. This process only trades; settlement sweeps and equity
 * snapshots belong to the worker process (npm run worker), which must be
 * started separately. Configuration via environment:
 *
 *   QF_DB_PATH        database file (default var/quantforge.db)
 *   QF_FEED           "binance" (default) or "fixture" (offline replay)
 *   QF_FIXTURE        fixture path for QF_FEED=fixture
 *   QF_REPLAY_MS      fixture replay interval, ms (default 100)
 *   QF_INITIAL_CASH   starting cash per new portfolio (default 10000)
 *   QF_FEE_BPS / QF_SLIPPAGE_BPS               fill costs (default 10 / 5)
 *   QF_MAX_FILL_NOTIONAL / QF_MAX_FILL_FRACTION  per-tick fill caps
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, DEFAULT_DB_PATH } from "../db/index.js";
import { loadStrategy } from "../strategy/loader.js";
import { BinanceFeed, FixtureReplayFeed } from "../data/feed/index.js";
import { Engine } from "./engine.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const num = (name, fallback) => (process.env[name] != null ? Number(process.env[name]) : fallback);

const strategyPaths = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => path.resolve(p))
  : [
      path.join(ROOT, "strategies", "ema-cross-basic.json"),
      path.join(ROOT, "strategies", "engulfing-breakout.json"),
    ];

const db = openDb(process.env.QF_DB_PATH ?? DEFAULT_DB_PATH);
const engine = new Engine(db, {
  initialCash: num("QF_INITIAL_CASH", 10_000),
  feeBps: num("QF_FEE_BPS", 10),
  slippageBps: num("QF_SLIPPAGE_BPS", 5),
  maxFillNotionalPerTick: num("QF_MAX_FILL_NOTIONAL", 2_500),
  maxFillFractionPerTick: num("QF_MAX_FILL_FRACTION", 1),
});

for (const strategyPath of strategyPaths) {
  engine.addStrategy(await loadStrategy(strategyPath));
}

const feed =
  process.env.QF_FEED === "fixture"
    ? new FixtureReplayFeed({
        fixturePath: process.env.QF_FIXTURE ?? path.join(ROOT, "fixtures", "BTC_USDT_1h_synthetic.json"),
        intervalMs: num("QF_REPLAY_MS", 100),
      })
    : new BinanceFeed();

feed.on("error", () => {
  // Non-fatal by contract (the feed logs and reconnects itself); listening
  // here keeps Node from treating it as an unhandled "error" event.
});

feed.on("end", async () => {
  console.log("[engine] feed ended — shutting down");
  await engine.stop();
  db.close();
  process.exit(0);
});

engine.attach(feed);
await engine.start();
console.log(`[engine] running ${strategyPaths.length} strategies (feed: ${feed.constructor.name})`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.log(`[engine] ${signal} received — shutting down`);
    await engine.stop();
    db.close();
    process.exit(0);
  });
}
