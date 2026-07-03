/**
 * QUANTFORGE Phase 4: the performance analyst (TradingAgents-inspired).
 *
 * Multi-agent structure, not a flat "how did it do?" call: one structured
 * prompt instructs the model to role-play FOUR distinctly-framed analysts —
 * fundamental (payoff economics), sentiment (crowd positioning), news
 * (event/catalyst exposure), technical (rule mechanics & exits) — then run
 * an explicit bull-vs-bear debate, then synthesize a single diagnosis.
 * One provider call carries all roles (API-call economy); the role framings
 * live in the prompt so they are genuinely distinct, not decorative labels.
 *
 * Invariant #2: reads trades/snapshots/confidence, writes ONE
 * `recommendations` row (type 'analysis'), optionally ONE NEW versioned
 * strategy file (never mutating the running strategy), and one line to
 * memory/diagnoses.md. It never touches the engine, broker, or portfolio
 * tables, and never promotes anything.
 */

import { latestConfidence, findStrategyByName } from "../confidence/score.js";
import { createProvider, TASK_ANALYST } from "./providers/index.js";
import { readMemory, appendMemory } from "./memory.js";
import { writeNewStrategyFile } from "./strategyFiles.js";
import { logRecommendation } from "./recommendations.js";

const SYSTEM = `You are QUANTFORGE's strategy performance review panel. You produce a single
markdown document with EXACTLY these sections, in order:

## Fundamental analyst — judge the strategy's ECONOMICS: average win vs
   average loss, fees drag, whether the payoff profile can sustain an edge.
## Sentiment analyst — judge CROWD/POSITIONING exposure: does the rule set
   buy strength or fear, and what does that imply about who is on the other side.
## News analyst — judge EVENT RISK: what catalysts/gaps the indicator rules
   are blind to and what that implies for sizing and stops.
## Technical analyst — judge the RULE MECHANICS: entry/exit logic, stop and
   target placement, against the actual trade journal provided.
## Bull vs bear debate — a genuine argument: the strongest case FOR trusting
   this track record, the strongest case AGAINST, and a resolution.
## Diagnosis — one synthesized verdict with the single most actionable finding.

If (and only if) the diagnosis implies a concrete RULE CHANGE, include ONE
fenced \`\`\`json block containing the FULL revised strategy object (schema
identical to the original provided below), with its "name" suffixed ".v2".
Never instruct anyone to edit the existing strategy file — a revision is
always a new version file.

End with one line starting exactly "CONCLUSION: " summarizing the diagnosis.`;

function fencedJsonBlocks(text) {
  return [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/**
 * Run the four-role debate for one strategy's REAL paper record.
 * @returns {{ text, recommendationId, proposalPath }} proposalPath null when
 *          no valid rule change was proposed.
 */
export async function analyzeStrategy(db, strategyName, { provider, log = console, now = Date.now() } = {}) {
  provider ??= createProvider({ log });
  const portfolio = db.prepare("SELECT * FROM portfolios WHERE strategy_name = ?").get(strategyName);
  if (!portfolio) throw new Error(`no portfolio exists for strategy "${strategyName}"`);

  const trades = db
    .prepare("SELECT symbol, qty, entry_price, exit_price, fees, pnl, reason, closed_at FROM trades WHERE portfolio_id = ? ORDER BY closed_at DESC LIMIT 30")
    .all(portfolio.id);
  const confidence = latestConfidence(db, portfolio.id);
  const strategy = findStrategyByName(strategyName);

  const wins = trades.filter((t) => t.pnl > 0).length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const data = [
    `strategy: ${strategyName} (portfolio #${portfolio.id}, status ${portfolio.status})`,
    `cash: ${portfolio.cash.toFixed(2)} (initial ${portfolio.initial_cash.toFixed(2)})`,
    `closed trades (last 30 shown): ${trades.length}, wins ${wins}, net pnl ${pnl.toFixed(2)}`,
    confidence
      ? `latest confidence: ${confidence.score}/100${confidence.capped ? " (CAPPED at 60 — sample floor not met)" : ""} — win-rate ${confidence.win_rate_score.toFixed(1)}/20, profit-factor ${confidence.profit_factor_score.toFixed(1)}/20, sharpe ${confidence.sharpe_score.toFixed(1)}/20, drawdown ${confidence.drawdown_score.toFixed(1)}/15, sample ${confidence.sample_size_score.toFixed(1)}/15, consistency ${confidence.consistency_score.toFixed(1)}/10 (trades ${confidence.trades_count}, days ${confidence.days_elapsed.toFixed(1)})`
      : "latest confidence: (never scored)",
  ].join("\n");
  const journal = trades
    .map((t) => `  ${new Date(t.closed_at).toISOString().slice(0, 16)} ${t.symbol} qty ${t.qty.toFixed(6)} entry ${t.entry_price.toFixed(2)} exit ${t.exit_price.toFixed(2)} pnl ${t.pnl.toFixed(2)} [${t.reason}]`)
    .join("\n");

  const prompt = `${TASK_ANALYST}

Current operator memory (respect these preferences):
${readMemory()}

DATA:
${data}

Trade journal (most recent first):
${journal || "  (no closed trades)"}

Current strategy definition:
${strategy ? "```json\n" + JSON.stringify(strategy, null, 2) + "\n```" : "(no strategy file on disk)"}

Produce the review panel document now.`;

  const response = await provider.complete({ system: SYSTEM, prompt, maxTokens: 4000 });

  // A proposed rule change MUST become a NEW version file — validated through
  // the same write path as the translator, never a mutation of the original.
  let proposalPath = null;
  for (const block of fencedJsonBlocks(response.text)) {
    let proposal;
    try {
      proposal = JSON.parse(block);
    } catch {
      continue;
    }
    try {
      proposalPath = writeNewStrategyFile(proposal, { baseName: `${strategyName}.v2` });
      log.info?.(`[ai/analyst] proposed rule change written as new version file ${proposalPath}`);
      break;
    } catch (err) {
      log.warn?.(`[ai/analyst] proposed revision rejected (schema-invalid): ${err.message}`);
    }
  }

  const recommendationId = logRecommendation(db, {
    portfolioId: portfolio.id,
    strategyName,
    type: "analysis",
    title: `Performance diagnosis: ${strategyName}` + (proposalPath ? " (rule change proposed as new version file)" : ""),
    body: response.text,
    provider: response.provider,
    model: response.model,
    now,
  });

  const conclusion = response.text.split("\n").find((l) => l.startsWith("CONCLUSION: "));
  appendMemory(
    "diagnoses.md",
    (conclusion ?? `Analyst reviewed ${strategyName}; see recommendation #${recommendationId}.`) +
      (proposalPath ? `\nProposed revision written to ${proposalPath} (original file untouched).` : ""),
    { now }
  );

  log.info?.(`[ai/analyst] diagnosis for "${strategyName}" logged as recommendation #${recommendationId}`);
  return { text: response.text, recommendationId, proposalPath };
}
