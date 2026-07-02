/**
 * QUANTFORGE Phase 3 demo: confidence score + promotion gate + kill switch,
 * fully offline.
 *
 * Run with: npm run confidence-demo
 *
 * 1. Replays the real Phase 2 flow (engine + broker + worker jobs) for both
 *    example strategies against the committed fixture, then prints their
 *    honest confidence breakdowns — hard-capped at 60 (2-4 trades over a
 *    fresh portfolio is nowhere near the 50-trade / 14-day sample floor).
 * 2. Seeds a third, EXPLICITLY SYNTHETIC portfolio ("synthetic-matured-demo")
 *    with 60 closed trades over ~20 calendar days plus a seeded backtest
 *    stub, and scores it through the REAL scoring function — showing a
 *    legitimate, uncapped, promotion-eligible score.
 * 3. Demonstrates the promotion safety rail (wrong typed name rejected,
 *    exact name accepted), 4. auto-demotion on a 3-day losing streak,
 *    5. the global kill switch (force-flatten + BUY rejection), and
 * 6. a final status table for all three portfolios.
 *
 * The Worker runs IN-PROCESS here (same class, same jobs) because the demo
 * must invoke individual jobs at scripted moments; the real two-OS-process
 * WAL path is already exercised by `npm run engine-demo`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db/index.js";
import { loadStrategy } from "../strategy/loader.js";
import { FixtureReplayFeed } from "../data/feed/index.js";
import { Engine } from "../engine/engine.js";
import { PaperBroker } from "../engine/paperBroker.js";
import { Worker } from "../worker/worker.js";
import { latestConfidence } from "./score.js";
import { promote, PROMOTION_MIN_SCORE } from "./promotion.js";
import { setKillSwitch } from "./killSwitch.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = path.join(ROOT, "var", "confidence-demo.db");
const FIXTURE = path.join(ROOT, "fixtures", "BTC_USDT_1h_synthetic.json");

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

// Deterministic PRNG so the seeded trade tape is identical every run.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function printBreakdown(name, b) {
  console.log(`\n  ${name}`);
  console.log(`    win-rate-vs-breakeven : ${fmt(b.win_rate_score ?? b.winRateScore)} / 20`);
  console.log(`    profit factor         : ${fmt(b.profit_factor_score ?? b.profitFactorScore)} / 20`);
  console.log(`    sharpe (snapshots)    : ${fmt(b.sharpe_score ?? b.sharpeScore)} / 20`);
  console.log(`    max drawdown          : ${fmt(b.drawdown_score ?? b.drawdownScore)} / 15`);
  console.log(`    sample size           : ${fmt(b.sample_size_score ?? b.sampleSizeScore)} / 15`);
  console.log(`    backtest consistency  : ${fmt(b.consistency_score ?? b.consistencyScore)} / 10`);
  const capped = (b.capped === 1 || b.capped === true);
  const trades = b.trades_count ?? b.tradesCount;
  const days = b.days_elapsed ?? b.daysElapsed;
  console.log(`    TOTAL: ${b.score} / 100   capped: ${capped ? "YES (hard cap 60 — sample floor not met)" : "no"}   trades: ${trades}   days: ${fmt(days, 1)}`);
}

// Fresh DB every run so the demo is deterministic.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });
const db = openDb(DB_PATH);

// ---------------------------------------------------------------------------
console.log("=== [1] Real Phase 2 paper run for both example strategies ===\n");

const worker = new Worker(db, {
  settlementIntervalMs: 400,
  snapshotIntervalMs: 600,
  confidenceIntervalMs: 2_500,
  log: { info: () => {}, warn: (m) => console.warn(m) }, // quiet timers; the demo prints its own summaries
});
const engine = new Engine(db, { initialCash: 10_000, feeBps: 10, slippageBps: 5 });
for (const name of ["ema-cross-basic.json", "engulfing-breakout.json"]) {
  engine.addStrategy(await loadStrategy(path.join(ROOT, "strategies", name)));
}
const feed = new FixtureReplayFeed({ fixturePath: FIXTURE, intervalMs: 10 });
const feedDone = new Promise((resolve) => feed.on("end", resolve));
engine.attach(feed);
worker.start();
await engine.start();
await feedDone;
await engine.stop();
worker.stop();
worker.settlementSweep(); // final pass, same as an operator shutdown
worker.snapshotEquity();

worker.recalculateConfidence(); // the real Phase 3 worker job
console.log("\nConfidence breakdowns (real paper results — tiny samples, so the 60-point hard cap is in force):");
for (const p of db.prepare("SELECT * FROM portfolios ORDER BY id").all()) {
  printBreakdown(`${p.strategy_name} (portfolio #${p.id}, status ${p.status})`, latestConfidence(db, p.id));
}

// ---------------------------------------------------------------------------
console.log("\n=== [2] Seeding the SYNTHETIC matured portfolio ===\n");
console.log("*** NOTE: \"synthetic-matured-demo\" is SEEDED DEMO DATA — a hand-built trade tape,");
console.log("*** NOT a real backtest or live run. It exists only to show what a matured,");
console.log("*** promotion-eligible portfolio looks like when scored by the REAL scoring function.");

const now = Date.now();
const createdAt = now - 20 * DAY_MS; // 20 calendar days of paper history (floor is 14)
const info = db
  .prepare("INSERT INTO portfolios (strategy_name, cash, initial_cash, created_at) VALUES (?, ?, ?, ?)")
  .run("synthetic-matured-demo", 10_000, 10_000, createdAt);
const synthId = Number(info.lastInsertRowid);

// Backtest metrics STUB (source 'seeded_stub') — the consistency component
// compares paper vs these, exactly as it would vs real cached backtest metrics.
db.prepare(
  `INSERT INTO backtest_metrics (strategy_name, trades, win_rate_pct, avg_trade_return_pct, profit_factor, source, computed_at)
   VALUES ('synthetic-matured-demo', 60, 56.0, 1.4, 2.2, 'seeded_stub', ?)`
).run(now);

// 60 trades (35 wins / 25 losses, shuffled deterministically) spread across
// ~16 days, ending 4 days ago so the demotion step's losing days stay the
// most recent trading days. Payoffs: wins ~ +$110..140, losses ~ -$60..80 on
// ~$2500 notional — solid but believable (PF = 2.5, wr 58% vs breakeven 36%).
const rand = mulberry32(42);
const outcomes = [...Array(35).fill(true), ...Array(25).fill(false)];
for (let i = outcomes.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [outcomes[i], outcomes[j]] = [outcomes[j], outcomes[i]];
}
const insertTrade = db.prepare(
  `INSERT INTO trades (portfolio_id, symbol, qty, entry_price, exit_price, fees, pnl, reason, opened_at, closed_at)
   VALUES (?, 'BTC/USDT', ?, 30000, ?, 5, ?, ?, ?, ?)`
);
const insertSnapshot = db.prepare(
  "INSERT INTO snapshots (portfolio_id, ts, equity, cash, open_positions) VALUES (?, ?, ?, ?, 0)"
);
let equity = 10_000;
insertSnapshot.run(synthId, createdAt, equity, equity);
const span = 16 * DAY_MS;
outcomes.forEach((isWin, i) => {
  const pnl = isWin ? 110 + rand() * 30 : -(60 + rand() * 20);
  const closedAt = createdAt + Math.round(((i + 1) / outcomes.length) * span);
  const qty = 2_500 / 30_000;
  insertTrade.run(synthId, qty, 30000 + pnl / qty, pnl, isWin ? "take_profit" : "stop_loss", closedAt - 2 * HOUR_MS, closedAt);
  equity += pnl;
  insertSnapshot.run(synthId, closedAt, equity, equity);
});
db.prepare("UPDATE portfolios SET cash = ? WHERE id = ?").run(equity, synthId);
console.log(`\nSeeded 60 closed trades over 16 days (final equity $${fmt(equity)}) + backtest stub. Scoring through the real function...`);

worker.recalculateConfidence();
const synthRow = () => db.prepare("SELECT * FROM portfolios WHERE id = ?").get(synthId);
let synthScore = latestConfidence(db, synthId);
printBreakdown("synthetic-matured-demo", synthScore);
console.log(
  `\n  => ${synthScore.score >= PROMOTION_MIN_SCORE && !synthScore.capped ? "ELIGIBLE" : "NOT ELIGIBLE"} for promotion (score ${synthScore.score} ${synthScore.score >= PROMOTION_MIN_SCORE ? ">=" : "<"} ${PROMOTION_MIN_SCORE}, capped: ${synthScore.capped ? "yes" : "no"})`
);

// ---------------------------------------------------------------------------
console.log("\n=== [3] Promotion gate ===\n");

console.log('Attempting promotion with WRONG typed confirmation "synthetic-matured-demO"...');
try {
  promote(db, "synthetic-matured-demo", "synthetic-matured-demO");
  console.error("  !! BUG: promotion should have been rejected");
} catch (err) {
  console.log(`  rejected as expected -> ${err.message}`);
}
console.log(`  status after rejection: ${synthRow().status}`);

console.log('\nAttempting promotion with EXACT typed confirmation "synthetic-matured-demo"...');
const promoted = promote(db, "synthetic-matured-demo", "synthetic-matured-demo");
console.log(`  status: ${promoted.status}   promoted_at: ${new Date(promoted.promoted_at).toISOString()}   live_capital_cap: $${promoted.live_capital_cap}`);

// ---------------------------------------------------------------------------
console.log("\n=== [4] Auto-demotion: 3-day losing streak ===\n");

// Inject net-negative realized pnl on each of the last 3 UTC calendar days
// (two small losing trades per day — realistic cadence, and small enough not
// to trip the daily-loss rule instead, so the STREAK trigger is what fires).
const todayStart = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
for (let d = 2; d >= 0; d--) {
  const dayStart = todayStart - d * DAY_MS;
  for (const [hour, pnl] of [[2, -28], [5, -17]]) {
    // Today's trades are clamped into (todayStart, now] so the streak spans
    // exactly the last 3 UTC days no matter what time the demo runs.
    const closedAt = Math.max(dayStart + hour * 1_000, Math.min(dayStart + hour * HOUR_MS, now - hour * 10_000));
    insertTrade.run(synthId, 2_500 / 30_000, 30000 + pnl / (2_500 / 30_000), pnl, "stop_loss", closedAt - HOUR_MS, closedAt);
  }
}
console.log("Injected 6 losing trades across the last 3 UTC days; running the worker's confidence/demotion job...\n");
worker.recalculateConfidence(); // demotion check is folded into this job

const afterDemotion = synthRow();
console.log(`\n  status: ${afterDemotion.status}   demoted_at: ${new Date(afterDemotion.demoted_at).toISOString()}`);
console.log(`  demotion_reason: ${afterDemotion.demotion_reason}`);
const demotionNote = db
  .prepare("SELECT * FROM notifications WHERE portfolio_id = ? AND type = 'demotion' ORDER BY id DESC LIMIT 1")
  .get(synthId);
console.log(`  notification #${demotionNote.id} [${demotionNote.type}] ${new Date(demotionNote.ts).toISOString()}: ${demotionNote.message}`);

// ---------------------------------------------------------------------------
console.log("\n=== [5] Global kill switch ===\n");

// Give the synthetic portfolio an open position so there is something to flatten.
db.prepare(
  "INSERT INTO positions (portfolio_id, symbol, qty, avg_entry_price, entry_fees, opened_at) VALUES (?, 'BTC/USDT', 0.02, 30000, 0.6, ?)"
).run(synthId, now - HOUR_MS);
console.log("Seeded one open position (0.02 BTC/USDT) for synthetic-matured-demo.\n");

setKillSwitch(db, true, "demo: simulated emergency stop");
worker.settlementSweep(); // with the switch engaged, the sweep force-flattens everything

const killTrade = db
  .prepare("SELECT * FROM trades WHERE portfolio_id = ? AND reason = 'kill_switch' ORDER BY id DESC LIMIT 1")
  .get(synthId);
console.log(`\n  flattened -> trade #${killTrade.id}: ${killTrade.symbol} qty ${killTrade.qty} exit ${fmt(killTrade.exit_price)} pnl ${fmt(killTrade.pnl)} [${killTrade.reason}]`);
const killNote = db
  .prepare("SELECT * FROM notifications WHERE type = 'kill_switch' AND portfolio_id = ? ORDER BY id DESC LIMIT 1")
  .get(synthId);
console.log(`  notification #${killNote.id} [${killNote.type}]: ${killNote.message}`);
console.log(`  open positions remaining (all portfolios): ${db.prepare("SELECT COUNT(*) AS n FROM positions").get().n}`);

const broker = new PaperBroker(db, { log: { warn: () => {}, info: () => {} } });
const lastClose = db.prepare("SELECT close FROM market_state WHERE symbol = 'BTC/USDT'").get().close;
const rejected = broker.placeOrder({
  portfolioId: synthId, symbol: "BTC/USDT", side: "BUY", qty: 0.001,
  reason: "demo entry while kill switch engaged", ts: Date.now(), refPrice: lastClose,
});
console.log(`\n  BUY order while engaged -> status ${rejected.status} (${rejected.reason})`);

setKillSwitch(db, false);
const accepted = broker.placeOrder({
  portfolioId: synthId, symbol: "BTC/USDT", side: "BUY", qty: 0.001,
  reason: "demo entry after disengage", ts: Date.now(), refPrice: lastClose,
});
console.log(`  BUY order after disengage -> status ${accepted.status} (accepted, resting)`);
broker.cancelOrder(accepted.id, "demo cleanup");

// ---------------------------------------------------------------------------
console.log("\n=== [6] Final summary ===\n");

worker.recalculateConfidence(); // fresh scores including everything above
const header = ["strategy", "status", "confidence", "capped", "trades", "days"];
const rows = db.prepare("SELECT * FROM portfolios ORDER BY id").all().map((p) => {
  const c = latestConfidence(db, p.id);
  return [p.strategy_name, p.status, String(c.score), c.capped ? "YES" : "no", String(c.trades_count), fmt(c.days_elapsed, 1)];
});
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells) => "  " + cells.map((c, i) => c.padEnd(widths[i])).join("  ");
console.log(line(header));
console.log(line(widths.map((w) => "-".repeat(w))));
for (const r of rows) console.log(line(r));

console.log("\n[demo] done");
db.close();
await sleep(0);
