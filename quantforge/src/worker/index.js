/**
 * QUANTFORGE worker process entry point (Phases 2-3).
 *
 * Run with: npm run worker    (or: node src/worker/index.js)
 *
 * This is a SEPARATE OS process from the engine — they share only the SQLite
 * database (WAL mode). Configuration via environment:
 *
 *   QF_DB_PATH        database file (default var/quantforge.db)
 *   QF_SETTLE_MS      settlement sweep interval, ms (default 2000)
 *   QF_SNAPSHOT_MS    equity snapshot interval, ms (default 300000 = 5 min)
 *   QF_CONFIDENCE_MS  confidence recalculation interval, ms (default 30000)
 *   QF_STALE_MS       max position age in MARKET time before force-close,
 *                     ms (default 604800000 = 7 days)
 *   QF_FEE_BPS / QF_SLIPPAGE_BPS   fill costs for settlement closes
 */

import { openDb, DEFAULT_DB_PATH } from "../db/index.js";
import { Worker } from "./worker.js";

const num = (name, fallback) => (process.env[name] != null ? Number(process.env[name]) : fallback);

const db = openDb(process.env.QF_DB_PATH ?? DEFAULT_DB_PATH);
const worker = new Worker(db, {
  settlementIntervalMs: num("QF_SETTLE_MS", 2_000),
  snapshotIntervalMs: num("QF_SNAPSHOT_MS", 300_000),
  confidenceIntervalMs: num("QF_CONFIDENCE_MS", 30_000),
  stalePositionMs: num("QF_STALE_MS", 7 * 24 * 3_600_000),
  feeBps: num("QF_FEE_BPS", 10),
  slippageBps: num("QF_SLIPPAGE_BPS", 5),
});

worker.start();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[worker] ${signal} received — shutting down`);
    worker.stop();
    db.close();
    process.exit(0);
  });
}
