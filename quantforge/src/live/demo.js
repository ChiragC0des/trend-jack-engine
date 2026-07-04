/**
 * QUANTFORGE Phase 6 demo: the gated live executor, fully offline.
 *
 * Run with: npm run live-demo
 *
 * Proves every gate of src/live/executor.js with the DRY-RUN broker only:
 * this file never imports ccxt or the testnet broker, never injects a
 * testnet broker into the executor, and — belt and braces — poisons
 * globalThis.fetch so ANY attempted network call would fail loudly. The
 * demo therefore runs to completion in a sandbox with no exchange access,
 * and by construction cannot place a real order anywhere.
 *
 * Seeding reuses the Phase 3 confidence-demo technique: a synthetic matured
 * portfolio (60 trades / 20 days + backtest stub) that legitimately scores
 * >= 75 uncapped and is promoted through the REAL promote() gate (typed
 * confirmation and all).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db/index.js";
import { recordConfidence } from "../confidence/score.js";
import { promote } from "../confidence/promotion.js";
import { setKillSwitch } from "../confidence/killSwitch.js";
import { DryRunBroker } from "./dryRunBroker.js";
import { LiveExecutor } from "./executor.js";

// No network, provably: any fetch() from here on throws. Nothing in the
// dry-run path calls it — this canary exists so an accidental regression
// fails loudly instead of silently reaching out.
globalThis.fetch = async () => {
  throw new Error("NETWORK BLOCKED: the Phase 6 offline demo must never make a network call");
};

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = path.join(ROOT, "var", "live-demo.db");

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });
const db = openDb(DB_PATH);

// ---------------------------------------------------------------------------
console.log("=== [0] Seed + genuinely promote a live portfolio (Phase 3 technique) ===\n");

const now = Date.now();
const createdAt = now - 20 * DAY_MS;
const synthId = Number(
  db.prepare("INSERT INTO portfolios (strategy_name, cash, initial_cash, created_at) VALUES (?, 10000, 10000, ?)")
    .run("synthetic-matured-demo", createdAt).lastInsertRowid
);
db.prepare(
  `INSERT INTO backtest_metrics (strategy_name, trades, win_rate_pct, avg_trade_return_pct, profit_factor, source, computed_at)
   VALUES ('synthetic-matured-demo', 60, 56.0, 1.4, 2.2, 'seeded_stub', ?)`
).run(now);

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
outcomes.forEach((isWin, i) => {
  const pnl = isWin ? 110 + rand() * 30 : -(60 + rand() * 20);
  const closedAt = createdAt + Math.round(((i + 1) / outcomes.length) * (16 * DAY_MS));
  const qty = 2_500 / 30_000;
  insertTrade.run(synthId, qty, 30000 + pnl / qty, pnl, isWin ? "take_profit" : "stop_loss", closedAt - 2 * HOUR_MS, closedAt);
  equity += pnl;
  insertSnapshot.run(synthId, closedAt, equity, equity);
});
db.prepare("UPDATE portfolios SET cash = ? WHERE id = ?").run(equity, synthId);

const score = recordConfidence(db, db.prepare("SELECT * FROM portfolios WHERE id = ?").get(synthId));
console.log(`Seeded 60 trades / 20 days -> confidence ${score.score} (capped: ${score.capped ? "yes" : "no"})`);
const promoted = promote(db, "synthetic-matured-demo", "synthetic-matured-demo");
console.log(`Promoted via the REAL promote() gate -> status '${promoted.status}', live_capital_cap $${promoted.live_capital_cap}\n`);

// A never-promoted paper portfolio, for the promotion-gate proof.
const paperId = Number(
  db.prepare("INSERT INTO portfolios (strategy_name, cash, initial_cash, created_at) VALUES ('paper-only-demo', 10000, 10000, ?)")
    .run(now).lastInsertRowid
);

// Two executors, both DRY-RUN-ONLY processes: neither has a testnet broker
// injected, so a real placement is structurally impossible in this demo.
// env objects are explicit so the shell can't influence the outcome.
const dryRunBroker = new DryRunBroker(db);
const executor = new LiveExecutor(db, { dryRunBroker, env: {} }); // QF_LIVE_MODE unset -> default dry_run
const executorTestnetEnv = new LiveExecutor(db, { dryRunBroker, env: { QF_LIVE_MODE: "testnet" } });

const paperCounts = () => ({
  orders: db.prepare("SELECT COUNT(*) AS n FROM orders").get().n,
  fills: db.prepare("SELECT COUNT(*) AS n FROM fills").get().n,
  positions: db.prepare("SELECT COUNT(*) AS n FROM positions").get().n,
});
const before = paperCounts();

// ---------------------------------------------------------------------------
console.log("=== [1] Default mode: pure DRY-RUN — journal only, no exchange, no funds ===\n");

let res = await executor.execute({
  portfolioId: synthId, symbol: "BTC/USDT", side: "BUY", qty: 0.005, price: 30_000, stopPrice: 29_850,
  reason: "demo: intended entry under default (unset QF_LIVE_MODE)",
});
console.log(`  result: status ${res.status}, mode ${res.mode}, clientOrderId ${res.clientOrderId}`);
const after = paperCounts();
console.log(
  `  paper tables untouched (this is NOT the paper engine): orders ${before.orders}->${after.orders}, ` +
    `fills ${before.fills}->${after.fills}, positions ${before.positions}->${after.positions}\n`
);

// ---------------------------------------------------------------------------
console.log("=== [2] Gate: dry-run window NOT elapsed — QF_LIVE_MODE=testnet is IGNORED ===\n");
console.log("Portfolio was promoted seconds ago; the mandatory 48h window forces dry-run:\n");

res = await executorTestnetEnv.execute({
  portfolioId: synthId, symbol: "BTC/USDT", side: "BUY", qty: 0.004, price: 30_000, stopPrice: 29_850,
  reason: "demo: testnet requested inside the 48h window",
});
console.log(`  result: status ${res.status}, mode ${res.mode} (FORCED), deciding gate '${res.gate}' — no testnet call attempted\n`);

// ---------------------------------------------------------------------------
console.log("=== [3] Gate: window elapsed + QF_LIVE_MODE=testnet, but NO testnet keys ===\n");

// Backdate the whole live stint 49h so the window is genuinely elapsed.
db.prepare("UPDATE portfolios SET promoted_at = ?, dry_run_started_at = ? WHERE id = ?")
  .run(now - 49 * HOUR_MS, now - 49 * HOUR_MS, synthId);
console.log("Backdated dry_run_started_at by 49h. The fully-unlocked path still fails safe:\n");

res = await executorTestnetEnv.execute({
  portfolioId: synthId, symbol: "BTC/USDT", side: "BUY", qty: 0.0045, price: 30_000, stopPrice: 29_850,
  reason: "demo: unlocked testnet path without credentials",
});
console.log(`  result: status ${res.status}, mode ${res.mode}, gate '${res.gate}'`);
console.log(`  reason: ${res.reason}`);
console.log("  (no crash, no network call — ccxt was never even imported by this process)\n");

// ---------------------------------------------------------------------------
console.log("=== [4] Gate: kill switch ===\n");

setKillSwitch(db, true, "demo: simulated emergency stop");
res = await executor.execute({
  portfolioId: synthId, symbol: "BTC/USDT", side: "BUY", qty: 0.0055, price: 30_000, stopPrice: 29_850,
  reason: "demo: entry while kill switch engaged",
});
console.log(`  result: status ${res.status}, gate '${res.gate}' — ${res.reason}`);
setKillSwitch(db, false);
console.log();

// ---------------------------------------------------------------------------
console.log("=== [5] Gate: paper (un-promoted) portfolio can NEVER place a live order ===\n");

res = await executor.execute({
  portfolioId: paperId, symbol: "BTC/USDT", side: "BUY", qty: 0.005, price: 30_000, stopPrice: 29_850,
  reason: "demo: paper portfolio attempting a live order",
});
console.log(`  result: status ${res.status}, gate '${res.gate}' — ${res.reason}\n`);

// ---------------------------------------------------------------------------
console.log("=== [6] Gate: confidence re-checked at ORDER time, not just at promotion ===\n");

db.prepare(
  `INSERT INTO confidence_scores (portfolio_id, ts, score, capped, win_rate_score, profit_factor_score,
     sharpe_score, drawdown_score, sample_size_score, consistency_score, trades_count, days_elapsed)
   VALUES (?, ?, 62, 0, 10, 10, 10, 10, 12, 10, 60, 20)`
).run(synthId, Date.now() + 1_000);
res = await executor.execute({
  portfolioId: synthId, symbol: "BTC/USDT", side: "BUY", qty: 0.0035, price: 30_000, stopPrice: 29_850,
  reason: "demo: entry after confidence decayed below the bar",
});
console.log(`  latest confidence dropped to 62 -> status ${res.status}, gate '${res.gate}' — ${res.reason}`);
db.prepare(
  `INSERT INTO confidence_scores (portfolio_id, ts, score, capped, win_rate_score, profit_factor_score,
     sharpe_score, drawdown_score, sample_size_score, consistency_score, trades_count, days_elapsed)
   VALUES (?, ?, 82, 0, 15, 15, 15, 12, 15, 10, 60, 20)`
).run(synthId, Date.now() + 2_000);
console.log("  (restored a passing score for the remaining steps)\n");

// ---------------------------------------------------------------------------
console.log("=== [7] Circuit breaker: order-size sanity ===\n");

res = await executor.execute({
  portfolioId: synthId, symbol: "BTC/USDT", side: "BUY", qty: 0.05, price: 30_000, stopPrice: 29_850,
  reason: "demo: oversize order",
});
console.log(`  BUY 0.05 @ 30000 (notional $1500) -> status ${res.status}, gate '${res.gate}' — ${res.reason}\n`);

// ---------------------------------------------------------------------------
console.log("=== [8] Circuit breaker: per-trade risk ===\n");

res = await executor.execute({
  portfolioId: synthId, symbol: "BTC/USDT", side: "BUY", qty: 0.008, price: 30_000, // no stop -> assumed 5% adverse move
  reason: "demo: stop-less entry whose assumed risk exceeds 1% of live capital",
});
console.log(`  BUY 0.008 @ 30000 with NO stop -> status ${res.status}, gate '${res.gate}' — ${res.reason}\n`);

// ---------------------------------------------------------------------------
console.log("=== [9] Circuit breaker: daily-loss ===\n");

const bigLoss = db
  .prepare(
    `INSERT INTO trades (portfolio_id, symbol, qty, entry_price, exit_price, fees, pnl, reason, opened_at, closed_at)
     VALUES (?, 'BTC/USDT', 0.08, 30000, 21250, 5, -700, 'stop_loss', ?, ?)`
  )
  .run(synthId, now - HOUR_MS, now);
res = await executor.execute({
  portfolioId: synthId, symbol: "BTC/USDT", side: "BUY", qty: 0.003, price: 30_000, stopPrice: 29_900,
  reason: "demo: entry after breaching today's loss limit",
});
console.log(`  injected -$700 realized today -> status ${res.status}, gate '${res.gate}'`);
console.log(`  reason: ${res.reason}`);
db.prepare("DELETE FROM trades WHERE id = ?").run(bigLoss.lastInsertRowid); // restore for the next steps
console.log();

// ---------------------------------------------------------------------------
console.log("=== [10] Gate: idempotent client order ids — a retry can never double-send ===\n");

// Explicit clientOrderId here so the demo cannot straddle a minute-bucket
// boundary between the two submissions; a real retry inside one bucket
// re-derives the identical id (see liveOrders.js).
const intent = {
  portfolioId: synthId, symbol: "BTC/USDT", side: "BUY", qty: 0.0065, price: 30_000, stopPrice: 29_850,
  reason: "demo: identical intent submitted twice", clientOrderId: `qf-${synthId}-BTCUSDT-b-demoretry1`,
};
const first = await executor.execute(intent);
console.log(`  first submission : status ${first.status}, clientOrderId ${first.clientOrderId}`);
const second = await executor.execute(intent);
console.log(`  second submission: status ${second.status}, gate '${second.gate}'`);
console.log(`  reason: ${second.reason}\n`);

// ---------------------------------------------------------------------------
console.log("=== [11] Circuit breaker: max concurrent live exposures ===\n");

// Inject two already-live exposures (as a real testnet deployment would have
// after fills); with the BTC dry-run intents above, that makes 3 symbols.
for (const [sym, coid] of [["ETH/USDT", "qf-demo-inject-eth"], ["SOL/USDT", "qf-demo-inject-sol"]]) {
  db.prepare(
    `INSERT INTO live_orders (portfolio_id, client_order_id, symbol, side, qty, price, notional, mode, status, gate, reason, created_at)
     VALUES (?, ?, ?, 'BUY', 1, 100, 100, 'testnet', 'SUBMITTED', 'all_gates', 'demo: injected open exposure', ?)`
  ).run(synthId, coid, sym, now);
}
res = await executor.execute({
  portfolioId: synthId, symbol: "LTC/USDT", side: "BUY", qty: 0.5, price: 100, stopPrice: 99,
  reason: "demo: fourth concurrent exposure",
});
console.log(`  with 3 open exposures (BTC dry-run + injected ETH, SOL) -> status ${res.status}, gate '${res.gate}' — ${res.reason}\n`);

// ---------------------------------------------------------------------------
console.log("=== [12] Summary: the live_orders journal ===\n");

const rows = db.prepare("SELECT id, symbol, side, qty, mode, status, gate, reason FROM live_orders ORDER BY id").all();
const header = ["id", "symbol", "side", "qty", "mode", "status", "gate", "reason"];
const cells = rows.map((r) => [
  String(r.id), r.symbol, r.side, String(r.qty), r.mode, r.status, r.gate ?? "", (r.reason ?? "").slice(0, 58),
]);
const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
const line = (c) => "  " + c.map((x, i) => x.padEnd(widths[i])).join("  ");
console.log(line(header));
console.log(line(widths.map((w) => "-".repeat(w))));
for (const c of cells) console.log(line(c));

const placed = rows.filter((r) => r.status !== "REJECTED" && r.reason !== "demo: injected open exposure");
const unsafe = placed.filter((r) => r.mode !== "dry_run" || r.status !== "DRY_RUN");
const final = paperCounts();
console.log(`\n  non-rejected rows (excluding the two injected fixtures): ${placed.length}, all dry-run: ${unsafe.length === 0 ? "YES" : "NO — BUG"}`);
console.log(`  paper tables still untouched: orders ${final.orders}, fills ${final.fills}, positions ${final.positions}`);
if (unsafe.length > 0) {
  console.error("  !! BUG: something other than a dry-run record was placed");
  process.exitCode = 1;
}

console.log(
  "\nNo real order was placed; no network call was made; testnet path is reachable only with keys + elapsed window + QF_LIVE_MODE=testnet + all gates green."
);
console.log("\n[demo] done");
db.close();
