/**
 * QUANTFORGE dashboard server (Phase 5): read-only state assembly.
 *
 * The dashboard server is a READER of the shared SQLite file. Every number
 * the UI shows is already computed and persisted by the engine / worker /
 * confidence layer — this module only reads tables and shapes JSON. It does
 * NO metric computation of its own: equity comes from `snapshots` (the only
 * read model for equity curves), confidence + its breakdown from
 * `confidence_scores`, pnl from `trades`. The single non-DB read is the
 * strategy files' `symbols`/`timeframe` metadata (same lookup the confidence
 * layer uses), which the relationship graph needs.
 */

import { findStrategyByName } from "../../src/confidence/score.js";
import { latestConfidence } from "../../src/confidence/score.js";
import { getKillSwitch } from "../../src/confidence/killSwitch.js";
import { PROMOTION_MIN_SCORE } from "../../src/confidence/promotion.js";

const SNAPSHOT_LIMIT = 400;
const TRADE_LIMIT = 120;
const RECOMMENDATION_LIMIT = 30;
const NOTIFICATION_LIMIT = 30;

/** Cache strategy-file metadata; files change rarely and reads are per-poll. */
const strategyMetaCache = new Map();
function strategyMeta(strategyName) {
  if (!strategyMetaCache.has(strategyName)) {
    let meta = null;
    try {
      const s = findStrategyByName(strategyName);
      if (s) meta = { symbols: s.symbols, timeframe: s.timeframe, description: s.description ?? null };
    } catch {
      meta = null; // portfolios may legitimately outlive their strategy file
    }
    strategyMetaCache.set(strategyName, meta);
  }
  return strategyMetaCache.get(strategyName);
}

/** Assemble the full dashboard state payload (pure read). */
export function readState(db) {
  const portfolios = db.prepare("SELECT * FROM portfolios ORDER BY id").all().map((p) => {
    const confidence = latestConfidence(db, p.id) ?? null;
    // Last N snapshots in chronological order (the worker's stored equity
    // curve, plotted as-is by the UI).
    const snapshots = db
      .prepare(
        `SELECT ts, equity, cash, open_positions FROM (
           SELECT ts, equity, cash, open_positions, id FROM snapshots
           WHERE portfolio_id = ? ORDER BY ts DESC, id DESC LIMIT ?
         ) ORDER BY ts ASC, id ASC`
      )
      .all(p.id, SNAPSHOT_LIMIT);
    const latestSnapshot = snapshots.length ? snapshots[snapshots.length - 1] : null;
    const openPositions = db.prepare("SELECT COUNT(*) AS n FROM positions WHERE portfolio_id = ?").get(p.id).n;
    return {
      ...p,
      confidence,
      snapshots,
      latestSnapshot,
      openPositions,
      strategyMeta: strategyMeta(p.strategy_name),
    };
  });

  const trades = db
    .prepare(
      `SELECT t.*, p.strategy_name FROM trades t
       JOIN portfolios p ON p.id = t.portfolio_id
       ORDER BY t.id DESC LIMIT ?`
    )
    .all(TRADE_LIMIT);

  const recommendations = db
    .prepare("SELECT * FROM recommendations ORDER BY id DESC LIMIT ?")
    .all(RECOMMENDATION_LIMIT);

  const notifications = db
    .prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT ?")
    .all(NOTIFICATION_LIMIT);

  return {
    ts: Date.now(),
    promotionMinScore: PROMOTION_MIN_SCORE,
    killSwitch: getKillSwitch(db),
    portfolios,
    trades,
    recommendations,
    notifications,
  };
}

/** Trades newer than a known max id, oldest first — the live tape diff. */
export function tradesSince(db, sinceId, limit = 50) {
  return db
    .prepare(
      `SELECT t.*, p.strategy_name FROM trades t
       JOIN portfolios p ON p.id = t.portfolio_id
       WHERE t.id > ? ORDER BY t.id ASC LIMIT ?`
    )
    .all(sinceId, limit);
}

export function maxTradeId(db) {
  return db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM trades").get().id;
}
