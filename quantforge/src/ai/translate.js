/**
 * QUANTFORGE Phase 4: Pine Script / plain-English -> strategy JSON translator.
 *
 * Prompts the configured provider (stub when no key — see providers/index.js)
 * with the REAL strategy schema plus current memory, then hard-gates the
 * result through assertValidStrategy before accepting it. Invalid model
 * output is retried once with the validation errors fed back; a second
 * failure is a loud error, never a silent coercion.
 *
 * Invariant #2: output goes to a NEW strategy file (writeNewStrategyFile —
 * can never overwrite an existing file) plus one `recommendations` row
 * (type 'operation': it produced a new artifact, not just an analysis).
 * No engine, broker, or portfolio table is touched.
 */

import { strategySchema, validateStrategy } from "../strategy/validate.js";
import { createProvider, TASK_TRANSLATE } from "./providers/index.js";
import { readMemory } from "./memory.js";
import { writeNewStrategyFile } from "./strategyFiles.js";
import { logRecommendation } from "./recommendations.js";

const SYSTEM = `You are QUANTFORGE's strategy translator. You convert raw Pine Script or a
plain-English trading idea into ONE strategy definition JSON object that
validates against the JSON Schema below.

Condition types available (entry_rules / exit_rules are arrays of these,
ANDed together):
- indicator_comparison: an indicator (rsi, sma, ema, macd, bollinger, atr,
  volume) vs a constant {"value": n}, a candle {"price": field}, or another
  {"indicator": ...}; operators gt/gte/lt/lte/eq/crosses_above/crosses_below.
- candlestick_pattern: a pattern name from the schema's enum.
- price_level: breaks_above / breaks_below a rolling highest_high/lowest_low
  (with "lookback") or a fixed "value".
- external_signal: reserved; do not emit it unless the input demands it.

The full schema (authoritative):
${JSON.stringify(strategySchema)}`;

function extractJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("no parseable JSON object found in the model response");
}

function buildPrompt(input, memory) {
  return `${TASK_TRANSLATE}

Current operator memory (respect these preferences, especially the risk notes):
${memory}

INPUT (Pine Script or plain-English strategy description):
${input}

Respond with ONLY the JSON object for the strategy — no prose, no markdown.`;
}

/**
 * Translate `input` into a validated strategy, write it to a NEW file, and
 * log the operation. Throws when the model output cannot be made valid.
 * @returns {{ strategy, filePath, raw, recommendationId }}
 */
export async function translateToStrategy(db, input, { provider, log = console, now = Date.now() } = {}) {
  provider ??= createProvider({ log });
  const memory = readMemory();

  let response = await provider.complete({ system: SYSTEM, prompt: buildPrompt(input, memory) });
  let strategy;
  for (let attempt = 1; ; attempt++) {
    let errors;
    try {
      const parsed = extractJsonObject(response.text);
      const check = validateStrategy(parsed);
      if (check.valid) {
        strategy = parsed;
        break;
      }
      errors = check.errors.join("; ");
    } catch (err) {
      errors = err.message;
    }
    if (attempt >= 2) {
      log.error?.(`[ai/translate] model output failed schema validation after retry: ${errors}`);
      throw new Error(`translator rejected model output (schema-invalid after retry): ${errors}`);
    }
    log.warn?.(`[ai/translate] model output invalid (${errors}) — retrying once with error feedback`);
    response = await provider.complete({
      system: SYSTEM,
      prompt:
        buildPrompt(input, memory) +
        `\n\nYour previous response failed schema validation with these errors:\n${errors}\nFix them and respond with ONLY the corrected JSON object.`,
    });
  }

  const filePath = writeNewStrategyFile(strategy);
  const recommendationId = logRecommendation(db, {
    strategyName: strategy.name,
    type: "operation",
    title: `Translated input into new strategy file: ${strategy.name}`,
    body: `Input:\n${input}\n\nGenerated (schema-validated) strategy written to ${filePath}:\n\n${JSON.stringify(strategy, null, 2)}`,
    provider: response.provider,
    model: response.model,
    now,
  });
  log.info?.(`[ai/translate] wrote new strategy file ${filePath} (recommendation #${recommendationId})`);
  return { strategy, filePath, raw: response.text, recommendationId };
}
