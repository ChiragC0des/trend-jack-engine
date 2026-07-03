/**
 * QUANTFORGE Phase 4 demo: the AI advisory layer, fully offline.
 *
 * Run with: npm run ai-demo
 *
 * With no AI_API_KEY configured this runs entirely on the deterministic stub
 * provider — zero network calls, zero keys — exercising the whole Phase 4
 * surface: provider resolution, translator (schema-validated new strategy
 * file), four-role performance analyst (with a .v2 version-file proposal),
 * daily brief, the recommendations ledger, and memory writes.
 *
 * The demo ends by VERIFYING INVARIANT #2: counts/contents of orders, fills,
 * positions, trades and every portfolio's status/cash are snapshotted before
 * the first AI call and asserted byte-identical after the last one, and the
 * two example strategy files are hash-compared to prove they were untouched.
 *
 * 1. Real Phase 2/3 replay seeds the DB (engine + broker + worker jobs) so
 *    the analyst reviews REAL paper trades for ema-cross-basic.
 * 2-5. Translator, analyst, daily brief, then the full recommendations table.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db/index.js";
import { loadStrategy } from "../strategy/loader.js";
import { FixtureReplayFeed } from "../data/feed/index.js";
import { Engine } from "../engine/engine.js";
import { Worker } from "../worker/worker.js";
import { assertValidStrategy } from "../strategy/validate.js";
import { resolveProviderConfig, createProvider } from "./providers/index.js";
import { translateToStrategy } from "./translate.js";
import { analyzeStrategy } from "./analyst.js";
import { runDailyBrief } from "./dailyBrief.js";
import { listRecommendations } from "./recommendations.js";
import { MEMORY_DIR } from "./memory.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = path.join(ROOT, "var", "ai-demo.db");
const FIXTURE = path.join(ROOT, "fixtures", "BTC_USDT_1h_synthetic.json");
const STRATEGIES_DIR = path.join(ROOT, "strategies");
const EXAMPLE_FILES = ["ema-cross-basic.json", "engulfing-breakout.json"].map((f) =>
  path.join(STRATEGIES_DIR, f)
);

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  OK: ${msg}`);
};

// Full snapshot of everything the AI layer is forbidden to touch.
function tradingState(db) {
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return JSON.stringify({
    orders: count("orders"),
    fills: count("fills"),
    positions: count("positions"),
    trades: count("trades"),
    portfolios: db
      .prepare("SELECT id, strategy_name, status, cash, promoted_at, live_capital_cap FROM portfolios ORDER BY id")
      .all(),
  });
}

// Re-runs write fresh artifacts; drop ONLY files this demo itself generates
// (never the two committed examples, guarded twice: by name list and prefix).
function removePriorDemoArtifacts() {
  for (const f of fs.readdirSync(STRATEGIES_DIR)) {
    const isDemoArtifact = /^(rsi-mean-reversion(-\d+)?|ema-cross-basic\.v2(-\d+)?)\.json$/.test(f);
    if (isDemoArtifact && !EXAMPLE_FILES.includes(path.join(STRATEGIES_DIR, f))) {
      fs.rmSync(path.join(STRATEGIES_DIR, f));
      console.log(`[demo] removed artifact from a previous run: strategies/${f}`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("=== [0] Setup: fresh DB + real Phase 2/3 paper replay ===\n");

removePriorDemoArtifacts();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });
const db = openDb(DB_PATH);

const worker = new Worker(db, {
  settlementIntervalMs: 400,
  snapshotIntervalMs: 600,
  confidenceIntervalMs: 2_500,
  dailyBriefIntervalMs: 3_600_000, // timer irrelevant here — the demo calls the job directly
  log: { info: () => {}, warn: (m) => console.warn(m) },
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
worker.settlementSweep();
worker.snapshotEquity();
worker.recalculateConfidence();
console.log("[demo] replayed 400 fixture candles for both example strategies; confidence scored\n");

// --- Invariant #2 baseline: taken BEFORE the first AI call ---
const stateBefore = tradingState(db);
const exampleHashesBefore = EXAMPLE_FILES.map(sha256);
const portfolioStateFile = path.join(MEMORY_DIR, "portfolio-state.md");
const portfolioStateBefore = fs.readFileSync(portfolioStateFile, "utf8");

// ---------------------------------------------------------------------------
console.log("=== [1] Resolved AI provider config ===\n");

const cfg = resolveProviderConfig(); // the adapter's own process.env read
console.log(`  provider: ${cfg.provider}`);
console.log(`  model:    ${cfg.model}`);
console.log(
  cfg.usingStub
    ? `  real key: NOT FOUND — falling back to the offline stub (${cfg.reason})`
    : `  real key: found for "${cfg.provider}" (calls may still fall back to the stub on error)`
);
const provider = createProvider();

// ---------------------------------------------------------------------------
console.log("\n=== [2] Translator: plain English -> schema-validated strategy JSON ===\n");

const description =
  "buy when RSI drops under 30 and sell when it goes back over 55, with a 3% stop and 6% target on ETH/USDT 1h";
console.log(`Input: "${description}"\n`);
const translated = await translateToStrategy(db, description, { provider });
console.log("Generated strategy JSON:\n");
console.log(JSON.stringify(translated.strategy, null, 2));
console.log("");
assertValidStrategy(translated.strategy, "demo re-check");
assert(true, "generated strategy validates against schema/strategy.schema.json");
assert(!EXAMPLE_FILES.includes(translated.filePath), `written file is NEW: ${path.relative(ROOT, translated.filePath)}`);
assert(fs.existsSync(translated.filePath), "new strategy file exists on disk");
assert(
  EXAMPLE_FILES.every((f, i) => sha256(f) === exampleHashesBefore[i]),
  "both example strategy files are byte-for-byte unchanged after translation"
);

// ---------------------------------------------------------------------------
console.log("\n=== [3] Performance analyst: four-role debate on the REAL ema-cross-basic portfolio ===\n");

const analysis = await analyzeStrategy(db, "ema-cross-basic", { provider });
console.log(analysis.text);
console.log("");
const analysisRow = db.prepare("SELECT * FROM recommendations WHERE id = ?").get(analysis.recommendationId);
assert(analysisRow?.type === "analysis", `analysis logged as recommendations row #${analysis.recommendationId} (type 'analysis')`);
if (analysis.proposalPath) {
  assert(fs.existsSync(analysis.proposalPath), `proposed rule change written as NEW version file: ${path.relative(ROOT, analysis.proposalPath)}`);
  assert(
    sha256(EXAMPLE_FILES[0]) === exampleHashesBefore[0],
    "original ema-cross-basic.json untouched by the proposal"
  );
} else {
  console.log("  (no rule change proposed this run)");
}

// ---------------------------------------------------------------------------
console.log("\n=== [4] Daily brief across ALL portfolios (the worker's 4th job, invoked directly) ===\n");

const brief = await runDailyBrief(db, { provider });
console.log(brief.text);
console.log("");
const briefRow = db.prepare("SELECT * FROM recommendations WHERE id = ?").get(brief.recommendationId);
assert(briefRow?.type === "note", `brief logged as recommendations row #${brief.recommendationId} (type 'note')`);
const portfolioStateAfter = fs.readFileSync(portfolioStateFile, "utf8");
const appended = portfolioStateAfter.slice(portfolioStateBefore.length);
assert(
  portfolioStateAfter.startsWith(portfolioStateBefore) && /^\n### \d{4}-\d{2}-\d{2}\n/.test(appended),
  "memory/portfolio-state.md gained a new dated entry"
);

// ---------------------------------------------------------------------------
console.log("\n=== [5] The recommendations ledger (separate from trades by design) ===\n");

const rows = listRecommendations(db).map((r) => [
  String(r.id), r.type, r.strategy_name ?? "-", r.title, new Date(r.created_at).toISOString().slice(0, 19),
]);
const header = ["id", "type", "strategy", "title", "created_at"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells) => "  " + cells.map((c, i) => c.padEnd(widths[i])).join("  ");
console.log(line(header));
console.log(line(widths.map((w) => "-".repeat(w))));
for (const r of rows) console.log(line(r));
console.log(`\n  trades table rows: ${db.prepare("SELECT COUNT(*) AS n FROM trades").get().n} (execution) vs recommendations rows: ${rows.length} (what the AI said)`);

// ---------------------------------------------------------------------------
console.log("\n=== [6] INVARIANT #2 VERIFICATION: the AI layer placed no orders and touched no portfolio ===\n");

const stateAfter = tradingState(db);
console.log(`  before AI: ${stateBefore}`);
console.log(`  after AI:  ${stateAfter}`);
assert(stateBefore === stateAfter, "orders/fills/positions/trades counts AND portfolio status/cash are IDENTICAL before and after all AI calls");
assert(
  EXAMPLE_FILES.every((f, i) => sha256(f) === exampleHashesBefore[i]),
  "ema-cross-basic.json and engulfing-breakout.json are byte-for-byte unchanged"
);

console.log("\n[demo] done — Phase 4 ran fully offline" + (cfg.usingStub ? " on the stub provider" : ""));
db.close();
