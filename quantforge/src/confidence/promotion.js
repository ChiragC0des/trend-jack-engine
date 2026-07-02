/**
 * QUANTFORGE Phase 3: promotion gate + auto-demotion.
 *
 * Promotion flips portfolios.status from 'paper' to 'live' — nothing more.
 * It does NOT route orders to a real exchange (that is Phase 6); it marks
 * the strategy as having earned live status and enforces the safety rules
 * that come with it (capital cap, auto-demotion, kill switch).
 *
 * Invariant #1: no strategy reaches live without explicit confirmation —
 * promote() demands the caller type the strategy name back EXACTLY
 * (case-sensitive, untrimmed) alongside a latest confidence score >= 75.
 *
 * Auto-demotion runs from the worker (folded into the confidence
 * recalculation job — demotion inputs are the same trade/snapshot reads the
 * scorer already does, so a fourth timer would buy nothing). A live
 * portfolio is demoted back to PAPER (demotion is an event, not a resting
 * status — the strategy keeps paper trading and can re-earn promotion) when
 * EITHER:
 *
 *  (a) daily-loss breach: realized pnl over the CURRENT UTC calendar day
 *      (wall-clock, trades.closed_at >= today 00:00Z) is a loss exceeding
 *      the strategy's risk.max_daily_loss_pct of the day's starting equity.
 *      Day-start equity = the last snapshot written before 00:00Z today,
 *      falling back to initial_cash for portfolios with no prior snapshot.
 *      This mirrors the engine's dailyLossLimitHit — but that check only
 *      BLOCKS new entries; this one revokes live status. When the strategy
 *      file is missing, a conservative default of 5% applies (documented
 *      here rather than skipping the check: a live portfolio must never be
 *      exempt from the loss rule just because its file went away).
 *
 *  (b) 3-day losing streak, defined precisely as: take the last 3 distinct
 *      UTC calendar days (by trades.closed_at) that had AT LEAST ONE closed
 *      trade; if there are 3 such days and each day's NET realized pnl is
 *      negative, the streak fires. Days with no trades are skipped rather
 *      than counted as breaks — "3 losing days in a row" refers to trading
 *      days, and an idle weekend should not reset the streak.
 *
 * On demotion: status -> 'paper', promoted_at and live_capital_cap are
 * CLEARED (the historical record lives in demoted_at, demotion_reason and
 * the notifications row — a later re-promotion writes fresh values), and a
 * `notifications` row of type 'demotion' is written.
 */

import { latestConfidence, findStrategyByName } from "./score.js";

export const PROMOTION_MIN_SCORE = 75;
export const DEFAULT_LIVE_CAPITAL_CAP = 250;
const DEFAULT_MAX_DAILY_LOSS_PCT = 5;

function utcDayStart(ts) {
  return Date.parse(new Date(ts).toISOString().slice(0, 10) + "T00:00:00Z");
}

/**
 * Promote a strategy's portfolio to live. Throws with a precise reason on
 * any failed gate; every attempt (success or rejection) is logged.
 * @param {string} typedConfirmation must equal strategyName EXACTLY
 */
export function promote(db, strategyName, typedConfirmation, { liveCapitalCap = DEFAULT_LIVE_CAPITAL_CAP, log = console, now = Date.now() } = {}) {
  const reject = (why) => {
    log.warn?.(`[promotion] REJECTED promotion of "${strategyName}": ${why}`);
    throw new Error(`Promotion rejected for "${strategyName}": ${why}`);
  };

  const portfolio = db.prepare("SELECT * FROM portfolios WHERE strategy_name = ?").get(strategyName);
  if (!portfolio) reject("no portfolio exists for this strategy");
  if (portfolio.status === "live") reject("already live");

  const confidence = latestConfidence(db, portfolio.id);
  if (!confidence) reject("no confidence score has been computed yet");
  if (confidence.score < PROMOTION_MIN_SCORE) {
    reject(
      `latest confidence score ${confidence.score} < ${PROMOTION_MIN_SCORE}` +
        (confidence.capped ? " (sample-size hard cap in force)" : "")
    );
  }
  // Exact match only — no trimming, no case folding. The typed name is the
  // explicit human confirmation required by Invariant #1.
  if (typedConfirmation !== strategyName) {
    reject(`typed confirmation ${JSON.stringify(typedConfirmation)} does not exactly match the strategy name`);
  }

  db.prepare("UPDATE portfolios SET status = 'live', promoted_at = ?, live_capital_cap = ? WHERE id = ?").run(
    now,
    liveCapitalCap,
    portfolio.id
  );
  log.info?.(
    `[promotion] PROMOTED portfolio #${portfolio.id} ("${strategyName}") to live — confidence ${confidence.score}, capital cap $${liveCapitalCap}`
  );
  return db.prepare("SELECT * FROM portfolios WHERE id = ?").get(portfolio.id);
}

/** Net realized pnl for the current UTC day and the day's starting equity. */
function todayLoss(db, portfolio, now) {
  const dayStart = utcDayStart(now);
  const { pnl } = db
    .prepare("SELECT COALESCE(SUM(pnl), 0) AS pnl FROM trades WHERE portfolio_id = ? AND closed_at >= ?")
    .get(portfolio.id, dayStart);
  const snapshot = db
    .prepare("SELECT equity FROM snapshots WHERE portfolio_id = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1")
    .get(portfolio.id, dayStart);
  return { pnl, dayStartEquity: snapshot?.equity ?? portfolio.initial_cash };
}

/** True when the last 3 trading days (UTC, days with >=1 closed trade) were all net-negative. */
function threeDayLosingStreak(db, portfolioId) {
  const days = db
    .prepare(
      `SELECT date(closed_at / 1000, 'unixepoch') AS day, SUM(pnl) AS pnl
       FROM trades WHERE portfolio_id = ?
       GROUP BY day ORDER BY day DESC LIMIT 3`
    )
    .all(portfolioId);
  return days.length === 3 && days.every((d) => d.pnl < 0);
}

/**
 * Check every live portfolio against the demotion triggers, demoting any
 * that breach. Returns the list of demotions performed. Called by the
 * worker's confidence job.
 */
export function checkAutoDemotions(db, { log = console, now = Date.now() } = {}) {
  const demotions = [];
  const live = db.prepare("SELECT * FROM portfolios WHERE status = 'live'").all();
  for (const portfolio of live) {
    let reason = null;

    const strategy = findStrategyByName(portfolio.strategy_name);
    const maxDailyLossPct = strategy?.risk?.max_daily_loss_pct ?? DEFAULT_MAX_DAILY_LOSS_PCT;
    const { pnl, dayStartEquity } = todayLoss(db, portfolio, now);
    if (pnl < 0 && dayStartEquity > 0 && (-pnl / dayStartEquity) * 100 >= maxDailyLossPct) {
      reason = `max daily loss breached: ${(-pnl).toFixed(2)} lost today (>= ${maxDailyLossPct}% of day-start equity ${dayStartEquity.toFixed(2)})`;
    } else if (threeDayLosingStreak(db, portfolio.id)) {
      reason = "3-day losing streak: last 3 trading days (UTC) each net-negative";
    }
    if (!reason) continue;

    db.prepare(
      "UPDATE portfolios SET status = 'paper', promoted_at = NULL, live_capital_cap = NULL, demoted_at = ?, demotion_reason = ? WHERE id = ?"
    ).run(now, reason, portfolio.id);
    db.prepare("INSERT INTO notifications (portfolio_id, ts, type, message) VALUES (?, ?, 'demotion', ?)").run(
      portfolio.id,
      now,
      `auto-demoted "${portfolio.strategy_name}" to paper — ${reason}`
    );
    log.warn?.(`[worker] AUTO-DEMOTED portfolio #${portfolio.id} (${portfolio.strategy_name}) — reason: ${reason}`);
    demotions.push({ portfolio, reason });
  }
  return demotions;
}
