/**
 * QUANTFORGE Phase 2 demo: paper trading engine + worker, fully offline.
 *
 * Run with: npm run engine-demo
 *
 * Drives BOTH example strategies concurrently — each with its own isolated
 * virtual portfolio — against the FixtureReplayFeed (the committed 400-candle
 * synthetic fixture replayed at high speed). No network access needed.
 *
 * The worker is NOT run inline: exactly as in real deployment, this script
 * spawns src/worker/index.js as its own OS process (node:child_process) so
 * the demo exercises the real two-process WAL-concurrency path — engine and
 * worker communicate only through the SQLite file. The only demo-specific
 * bits are a throwaway DB, accelerated replay, and short worker intervals.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db/index.js";
import { loadStrategy } from "../strategy/loader.js";
import { FixtureReplayFeed } from "../data/feed/index.js";
import { Engine } from "./engine.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = path.join(ROOT, "var", "demo.db");
const FIXTURE = path.join(ROOT, "fixtures", "BTC_USDT_1h_synthetic.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (x, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : String(x));

// Fresh DB every run so the demo is deterministic.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });

const db = openDb(DB_PATH);

// --- Worker: a real separate OS process, short intervals for the demo ---
const worker = spawn(process.execPath, [path.join(ROOT, "src", "worker", "index.js")], {
  env: {
    ...process.env,
    QF_DB_PATH: DB_PATH,
    QF_SETTLE_MS: "400",
    QF_SNAPSHOT_MS: "1200",
  },
  stdio: "inherit", // worker log lines are already prefixed [worker]
});
const workerExited = new Promise((resolve) => worker.on("exit", resolve));

// --- Engine: both example strategies against the accelerated fixture replay ---
const engine = new Engine(db, {
  initialCash: 10_000,
  feeBps: 10,
  slippageBps: 5,
  // Low per-tick notional cap so entry orders visibly PARTIALLY_FILL across
  // several ticks before reaching FILLED.
  maxFillNotionalPerTick: 1_000,
});
for (const name of ["ema-cross-basic.json", "engulfing-breakout.json"]) {
  engine.addStrategy(await loadStrategy(path.join(ROOT, "strategies", name)));
}

const feed = new FixtureReplayFeed({ fixturePath: FIXTURE, intervalMs: 15 });
const feedDone = new Promise((resolve) => feed.on("end", resolve));

engine.attach(feed);
await engine.start();
console.log("[demo] engine started; replaying 400 fixture candles...\n");

await feedDone;
console.log("\n[demo] feed exhausted — stopping engine (cancelling any resting orders)");
await engine.stop();

// Give the worker time for a final settlement sweep + equity snapshot, then
// shut it down like an operator would.
await sleep(1_800);
worker.kill("SIGTERM");
await workerExited;

// --- Summary (all figures read straight from the shared DB) ---
console.log("\n=== QUANTFORGE Phase 2 demo results ===");
for (const portfolio of db.prepare("SELECT * FROM portfolios ORDER BY id").all()) {
  const snapshot = db
    .prepare("SELECT * FROM snapshots WHERE portfolio_id = ? ORDER BY ts DESC, id DESC LIMIT 1")
    .get(portfolio.id);
  const trades = db.prepare("SELECT * FROM trades WHERE portfolio_id = ? ORDER BY closed_at").all(portfolio.id);
  const orderCounts = db
    .prepare("SELECT status, COUNT(*) AS n FROM orders WHERE portfolio_id = ? GROUP BY status ORDER BY status")
    .all(portfolio.id);
  const fillCount = db
    .prepare("SELECT COUNT(*) AS n FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.portfolio_id = ?")
    .get(portfolio.id).n;
  const openPositions = db.prepare("SELECT COUNT(*) AS n FROM positions WHERE portfolio_id = ?").get(portfolio.id).n;
  const snapshotCount = db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE portfolio_id = ?").get(portfolio.id).n;

  console.log(`\n--- ${portfolio.strategy_name} (portfolio #${portfolio.id}) ---`);
  console.log(`Final equity (last worker snapshot): $${fmt(snapshot?.equity)}  (cash $${fmt(portfolio.cash)}, ${openPositions} open position(s))`);
  console.log(`Return: ${fmt(((snapshot?.equity ?? portfolio.cash) / portfolio.initial_cash - 1) * 100)}%   Trades: ${trades.length}   Fills: ${fillCount}   Worker snapshots: ${snapshotCount}`);
  console.log(`Orders by status: ${orderCounts.map((r) => `${r.status}=${r.n}`).join("  ") || "none"}`);
  for (const t of trades) {
    console.log(
      `  ${new Date(t.opened_at).toISOString().slice(0, 16)} -> ${new Date(t.closed_at).toISOString().slice(0, 16)}  entry ${fmt(t.entry_price)}  exit ${fmt(t.exit_price)}  pnl ${fmt(t.pnl)}  [${t.reason}]`
    );
  }
}

const workerTradeCount = db
  .prepare("SELECT COUNT(*) AS n FROM trades WHERE reason IN ('stop_loss','take_profit','stale_position')")
  .get().n;
const totalSnapshots = db.prepare("SELECT COUNT(*) AS n FROM snapshots").get().n;
console.log(`\n[demo] worker (separate process) settled ${workerTradeCount} position(s) and wrote ${totalSnapshots} equity snapshots`);
console.log("[demo] done");
db.close();
