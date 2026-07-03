/**
 * QUANTFORGE Phase 4: the daily brief — the worker's fourth scheduled job.
 *
 * Surveys ALL portfolios (status, latest confidence + capped flag, recent
 * trades/pnl, open positions), recent safety notifications (auto-demotions,
 * kill-switch events) and the kill-switch state, injects memory, and asks
 * the provider for a short synthesized summary.
 *
 * Invariant #2: pure READ of the trading tables; writes ONE
 * `recommendations` row (type 'note') and one dated entry to
 * memory/portfolio-state.md. Nothing else.
 */

import { latestConfidence } from "../confidence/score.js";
import { isKillSwitchEngaged } from "../confidence/killSwitch.js";
import { createProvider, TASK_DAILY_BRIEF } from "./providers/index.js";
import { readMemory, appendMemory } from "./memory.js";
import { logRecommendation } from "./recommendations.js";

const DAY_MS = 86_400_000;

const SYSTEM = `You are QUANTFORGE's daily brief writer. Produce a SHORT plain-text morning
brief for the operator: one line of overall lab health, one line per
portfolio worth mentioning, and any safety events (demotions, kill switch).
No tables, no markdown headers, under 200 words.`;

/**
 * Generate + log the daily brief across all portfolios.
 * @returns {{ text, recommendationId }}
 */
export async function runDailyBrief(db, { provider, log = console, now = Date.now() } = {}) {
  provider ??= createProvider({ log });

  const portfolios = db.prepare("SELECT * FROM portfolios ORDER BY id").all();
  const lines = portfolios.map((p) => {
    const c = latestConfidence(db, p.id);
    const { n, pnl } = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(pnl), 0) AS pnl FROM trades WHERE portfolio_id = ? AND closed_at >= ?")
      .get(p.id, now - DAY_MS);
    const open = db.prepare("SELECT COUNT(*) AS n FROM positions WHERE portfolio_id = ?").get(p.id).n;
    const total = db.prepare("SELECT COUNT(*) AS n FROM trades WHERE portfolio_id = ?").get(p.id).n;
    return (
      `- ${p.strategy_name}: status ${p.status}, cash ${p.cash.toFixed(2)}, ` +
      `confidence ${c ? `${c.score}/100${c.capped ? " (capped)" : ""}` : "unscored"}, ` +
      `trades ${total} total / ${n} last 24h (pnl ${pnl.toFixed(2)}), open positions ${open}` +
      (p.demotion_reason ? `, last demotion: ${p.demotion_reason}` : "")
    );
  });
  const notifications = db
    .prepare("SELECT ts, type, message FROM notifications WHERE ts >= ? ORDER BY ts DESC LIMIT 10")
    .all(now - 7 * DAY_MS)
    .map((n) => `- [${n.type}] ${new Date(n.ts).toISOString().slice(0, 16)}: ${n.message}`);

  const prompt = `${TASK_DAILY_BRIEF}

Current operator memory:
${readMemory()}

PORTFOLIO DATA:
${lines.join("\n") || "- (no portfolios yet)"}

RECENT NOTIFICATIONS:
${notifications.join("\n") || "- none"}

Kill switch: ${isKillSwitchEngaged(db) ? "ENGAGED" : "disengaged"}

Write the daily brief now.`;

  const response = await provider.complete({ system: SYSTEM, prompt, maxTokens: 1500 });
  const date = new Date(now).toISOString().slice(0, 10);
  const recommendationId = logRecommendation(db, {
    type: "note",
    title: `Daily brief ${date} (${portfolios.length} portfolio${portfolios.length === 1 ? "" : "s"})`,
    body: response.text,
    provider: response.provider,
    model: response.model,
    now,
  });
  appendMemory("portfolio-state.md", `Daily brief (recommendation #${recommendationId}):\n\n${response.text.trim()}`, { now });
  log.info?.(`[ai/brief] daily brief logged as recommendation #${recommendationId}`);
  return { text: response.text, recommendationId };
}
