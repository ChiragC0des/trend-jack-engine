/**
 * QUANTFORGE Phase 5 demo runner: the full three-process stack, offline.
 *
 * Run with: npm run dashboard-demo    (stop with Ctrl-C — SIGINT/SIGTERM
 * cascades to the worker and dashboard child processes)
 *
 * Exactly the src/engine/demo.js pattern, extended with the dashboard:
 *   1. fresh var/dashboard-demo.db,
 *   2. Worker spawned as a real child process (settlement / snapshots /
 *      confidence on short demo intervals),
 *   3. Dashboard server spawned as a real child process (the third process;
 *      serves dashboard/web/dist + the WS feed on QF_DASHBOARD_PORT),
 *   4. Engine in THIS process replaying the committed fixture for both
 *      example strategies — and, unlike the one-shot demos, LOOPING the
 *      replay so there is continuously updating data to look at. (Replaying
 *      the same market time again is fine for a demo: positions/trades keep
 *      accumulating; only the stale-position age check goes quiet.)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/db/index.js";
import { loadStrategy } from "../../src/strategy/loader.js";
import { FixtureReplayFeed } from "../../src/data/feed/index.js";
import { Engine } from "../../src/engine/engine.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = path.join(ROOT, "var", "dashboard-demo.db");
const FIXTURE = path.join(ROOT, "fixtures", "BTC_USDT_1h_synthetic.json");
const PORT = process.env.QF_DASHBOARD_PORT ?? "4100";
const REPLAY_MS = process.env.QF_REPLAY_MS != null ? Number(process.env.QF_REPLAY_MS) : 250;

// Fresh DB every run so the demo is deterministic.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });
const db = openDb(DB_PATH);

const children = [];
function spawnChild(name, script, extraEnv = {}) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, QF_DB_PATH: DB_PATH, ...extraEnv },
    stdio: "inherit",
  });
  child.on("exit", (code) => console.log(`[dashboard-demo] ${name} exited (code ${code})`));
  children.push(child);
  return child;
}

// --- Worker: real separate OS process, short demo intervals ---
spawnChild("worker", path.join(ROOT, "src", "worker", "index.js"), {
  QF_SETTLE_MS: "500",
  QF_SNAPSHOT_MS: "1500",
  QF_CONFIDENCE_MS: "3000",
});

// --- Dashboard server: the third process ---
spawnChild("dashboard", path.join(ROOT, "dashboard", "server", "index.js"), {
  QF_DASHBOARD_PORT: PORT,
});

// --- Engine (this process): both example strategies, looping fixture replay ---
const engine = new Engine(db, {
  initialCash: 10_000,
  feeBps: 10,
  slippageBps: 5,
  maxFillNotionalPerTick: 1_000,
});
for (const name of ["ema-cross-basic.json", "engulfing-breakout.json"]) {
  engine.addStrategy(await loadStrategy(path.join(ROOT, "strategies", name)));
}

let stopping = false;
async function runReplayLoop() {
  for (let pass = 1; !stopping; pass++) {
    const feed = new FixtureReplayFeed({ fixturePath: FIXTURE, intervalMs: REPLAY_MS });
    const done = new Promise((resolve) => feed.on("end", resolve));
    engine.attach(feed);
    if (pass === 1) await engine.start();
    else await feed.start();
    console.log(`[dashboard-demo] replay pass ${pass} started (${REPLAY_MS}ms/candle, ~${Math.round((400 * REPLAY_MS) / 1000)}s per pass)`);
    await done;
  }
}

console.log(`[dashboard-demo] db: ${DB_PATH}`);
console.log(`[dashboard-demo] open http://localhost:${PORT} — Ctrl-C to stop everything`);
runReplayLoop().catch((err) => {
  console.error("[dashboard-demo] replay loop failed:", err);
  shutdown("error");
});

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[dashboard-demo] ${signal} — stopping engine and children`);
  engine.stop().catch(() => {});
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(signal));
