/**
 * QUANTFORGE Phase 4: the STUB provider.
 *
 * Used whenever no real AI provider is configured (AI_PROVIDER unset/"stub",
 * or AI_API_KEY missing) and as the per-call fallback when a real provider
 * errors. It NEVER pretends to be a real model: every response is prefixed
 * with STUB_BANNER, and generated placeholder content is labelled as such.
 *
 * The stub is deterministic and fully offline so the entire Phase 4 surface
 * (translator, analyst, daily brief, recommendation ledger, memory writes)
 * is exercisable and demoable with zero network calls and zero API key.
 *
 * It routes on the TASK_* marker each Phase 4 module embeds in its prompt
 * (see the marker constants below) and produces content in the same SHAPE a
 * real model is instructed to produce — valid schema JSON for the
 * translator, a four-role debate + optional ```json proposal block for the
 * analyst, a short synthesis for the daily brief — so downstream parsing
 * and validation code takes the identical path for stub and real output.
 */

export const STUB_BANNER =
  "[STUB — no AI_API_KEY configured, this is not a model response]";

// Prompt markers: each Phase 4 module tags its prompt with one of these so
// the stub knows which placeholder shape to produce.
export const TASK_TRANSLATE = "QUANTFORGE-TASK: translate-to-strategy";
export const TASK_ANALYST = "QUANTFORGE-TASK: performance-analysis";
export const TASK_DAILY_BRIEF = "QUANTFORGE-TASK: daily-brief";

const num = (text, re, fallback) => {
  const m = text.match(re);
  return m ? Number(m[1]) : fallback;
};

function firstFencedJson(text) {
  const m = text.match(/```json\s*\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Deterministic placeholder strategy from a plain-English/Pine description. */
function stubTranslate(prompt) {
  // Parse ONLY the INPUT section — the prompt also carries memory files whose
  // text (symbols, thresholds) must not leak into the generated strategy.
  const input = (prompt.match(/INPUT[^\n]*:\n([\s\S]*?)\n\nRespond/) ?? [, prompt])[1];
  const buy = num(input, /(?:under|below|<)\s*(\d+(?:\.\d+)?)/i, 30);
  const sell = num(input, /(?:over|above|>)\s*(\d+(?:\.\d+)?)/i, 55);
  const stop = num(input, /(\d+(?:\.\d+)?)\s*%\s*stop/i, 3);
  const target = num(input, /(\d+(?:\.\d+)?)\s*%\s*target/i, 6);
  const symbol = (input.match(/\b([A-Z0-9]{2,10}\/[A-Z0-9]{2,10})\b/) ?? [, "BTC/USDT"])[1];
  const timeframe = (input.match(/\b(\d+(?:m|h|d|w))\b/) ?? [, "1h"])[1];

  const strategy = {
    name: "rsi-mean-reversion",
    description:
      "[stub-generated placeholder — not a model response] RSI mean-reversion derived " +
      "deterministically from the request text: long when RSI(14) drops under " +
      `${buy}, exit when it recovers above ${sell}.`,
    symbols: [symbol],
    timeframe,
    entry_rules: [
      {
        type: "indicator_comparison",
        note: `Oversold: RSI(14) under ${buy}.`,
        indicator: { name: "rsi", params: { period: 14 } },
        operator: "lt",
        compare_to: { value: buy },
      },
    ],
    exit_rules: [
      {
        type: "indicator_comparison",
        note: `Mean reverted: RSI(14) back over ${sell}.`,
        indicator: { name: "rsi", params: { period: 14 } },
        operator: "gt",
        compare_to: { value: sell },
      },
    ],
    risk: {
      stop_loss_pct: stop,
      take_profit_pct: target,
      max_position_pct: 20,
      max_daily_loss_pct: 5,
    },
  };
  return `${STUB_BANNER}\n${JSON.stringify(strategy, null, 2)}`;
}

/** Deterministic placeholder four-role debate + diagnosis (+ v2 proposal). */
function stubAnalyst(prompt) {
  const strategy = firstFencedJson(prompt);
  const name = strategy?.name ?? "unknown-strategy";
  const dataSection = (prompt.match(/DATA:\n([\s\S]*?)\n\n/) ?? [, ""])[1].trim();

  let proposalBlock = "";
  let proposalLine = "No rule change proposed.";
  if (strategy) {
    // Deterministic placeholder tweak: bring the take-profit target 25%
    // closer, on the (canned) thesis that exits rarely reach the target.
    const proposal = JSON.parse(JSON.stringify(strategy));
    proposal.name = `${name}.v2`;
    proposal.description =
      `[stub-generated placeholder — not a model response] v2 of "${name}": ` +
      "take-profit tightened 25% so winners are banked before momentum fades.";
    proposal.risk.take_profit_pct = Math.round(proposal.risk.take_profit_pct * 0.75 * 10) / 10;
    proposalBlock = "\n\nProposed revision (new version file, never a mutation of the running strategy):\n" +
      "```json\n" + JSON.stringify(proposal, null, 2) + "\n```";
    proposalLine = `Proposed ${proposal.name}: take_profit_pct ${strategy.risk.take_profit_pct} -> ${proposal.risk.take_profit_pct}.`;
  }

  return `${STUB_BANNER}

# Performance diagnosis: ${name}

Observed data (echoed from the journal provided in the prompt):
${dataSection || "(no data section found in prompt)"}

## Fundamental analyst
Placeholder fundamentals view: the strategy's economics rest on its payoff profile (avg win vs avg loss); with the small paper sample above, edge-after-fees is not yet evidenced.

## Sentiment analyst
Placeholder sentiment view: no sentiment feed is wired in Phase 4; treating market mood as neutral and flagging that entries take no crowd-positioning signal into account.

## News analyst
Placeholder news view: no news/catalyst feed is wired; the strategy is exposed to event gaps that its indicator rules cannot see, arguing for conservative position sizing.

## Technical analyst
Placeholder technical view: the rule set is trend/mean-reversion mechanics; the trade journal above suggests exits are the weak leg (stop/target placement), not entries.

## Bull vs bear debate
- BULL: the sample is tiny and the confidence cap is doing its job; nothing here disqualifies the strategy — keep paper trading toward the 50-trade floor.
- BEAR: the same tiny sample means every positive stat could be luck; the exit profile shows winners give back gains before hitting the wide target.
- RESOLUTION: stay in paper, tighten the exit, re-evaluate at the sample floor.

## Diagnosis
Placeholder synthesized diagnosis: insufficient sample to trust the edge; the actionable finding is exit management. ${proposalLine}${proposalBlock}

CONCLUSION: [stub] ${name}: sample too small to trust; ${proposalLine}`;
}

/** Deterministic placeholder daily brief. */
function stubDailyBrief(prompt) {
  const m = prompt.match(/PORTFOLIO DATA:\n([\s\S]*?)\n\n/);
  const lines = (m ? m[1] : "").split("\n").filter((l) => l.startsWith("- "));
  const notes = (prompt.match(/RECENT NOTIFICATIONS:\n([\s\S]*?)\n\n/) ?? [, "- none"])[1].trim();
  return `${STUB_BANNER}

Daily brief (placeholder synthesis of the data provided in the prompt):

Portfolios:
${lines.join("\n") || "- (no portfolios found in prompt)"}

Recent safety events:
${notes}

Placeholder takeaway: all figures above are echoed from the live database; no
portfolio is promotion-eligible while the sample-size cap is in force, and no
action is recommended beyond continued paper trading.`;
}

/** The stub provider object — same interface as the real adapters. */
export function createStubProvider() {
  return {
    provider: "stub",
    model: "stub",
    async complete({ prompt }) {
      let text;
      if (prompt.includes(TASK_TRANSLATE)) text = stubTranslate(prompt);
      else if (prompt.includes(TASK_ANALYST)) text = stubAnalyst(prompt);
      else if (prompt.includes(TASK_DAILY_BRIEF)) text = stubDailyBrief(prompt);
      else text = `${STUB_BANNER}\n(placeholder response — no task marker recognized in prompt)`;
      return { text, provider: "stub", model: "stub" };
    },
  };
}
