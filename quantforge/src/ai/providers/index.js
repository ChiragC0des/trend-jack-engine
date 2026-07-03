/**
 * QUANTFORGE Phase 4: model-agnostic AI provider adapter.
 *
 * ============================ INVARIANT #2 ============================
 * THE AI LAYER NEVER PLACES ORDERS. Execution is deterministic code only.
 * Nothing under src/ai/ imports the engine or the paper broker, calls
 * promote() (or anything that could bypass its typed-confirmation gate),
 * or writes to orders / fills / positions / portfolios — those tables are
 * READ-ONLY to this layer. AI code writes ONLY to:
 *   1. the `recommendations` table (a log of what the AI said),
 *   2. NEW strategy version files (never overwriting an existing one), and
 *   3. /quantforge/memory/*.md files.
 * ======================================================================
 *
 * One uniform interface over anthropic / openai / openrouter / stub:
 *   createProvider() -> { provider, model, complete({system, prompt, maxTokens}) }
 *   complete resolves to { text, provider, model }.
 *
 * Config comes from environment variables (documented in quantforge/.env.example):
 *   AI_PROVIDER  anthropic | openai | openrouter | stub (default: stub)
 *   AI_MODEL     model id (per-provider defaults below)
 *   AI_API_KEY   required for any real provider; missing key -> stub
 *   AI_BASE_URL  optional API origin override (mainly for openrouter/proxies)
 *
 * Real adapters use the runtime's built-in fetch — no HTTP client dependency.
 * A network/auth error from a real provider NEVER crashes the process: the
 * call logs a warning and falls back to the stub for that one call, so every
 * scheduled job and demo keeps working offline.
 */

import { createStubProvider, STUB_BANNER } from "./stub.js";

export { STUB_BANNER, TASK_TRANSLATE, TASK_ANALYST, TASK_DAILY_BRIEF } from "./stub.js";

const DEFAULTS = {
  anthropic: { model: "claude-opus-4-8", baseUrl: "https://api.anthropic.com" },
  openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com" },
  openrouter: { model: "anthropic/claude-sonnet-4.5", baseUrl: "https://openrouter.ai/api" },
};

/**
 * Resolve provider config from the environment. Pure + side-effect free so
 * the demo can print exactly what the adapter itself resolved.
 * @returns {{ provider, model, apiKey, baseUrl, usingStub, reason }}
 */
export function resolveProviderConfig(env = process.env) {
  const requested = (env.AI_PROVIDER ?? "stub").trim().toLowerCase();
  const apiKey = (env.AI_API_KEY ?? "").trim();

  if (requested === "stub" || requested === "") {
    return { provider: "stub", model: "stub", apiKey: "", baseUrl: "", usingStub: true, reason: "AI_PROVIDER is unset or 'stub'" };
  }
  if (!DEFAULTS[requested]) {
    return { provider: "stub", model: "stub", apiKey: "", baseUrl: "", usingStub: true, reason: `unknown AI_PROVIDER "${requested}"` };
  }
  if (!apiKey) {
    return { provider: "stub", model: "stub", apiKey: "", baseUrl: "", usingStub: true, reason: `AI_API_KEY is missing for provider "${requested}"` };
  }
  return {
    provider: requested,
    model: (env.AI_MODEL ?? "").trim() || DEFAULTS[requested].model,
    apiKey,
    baseUrl: (env.AI_BASE_URL ?? "").trim().replace(/\/$/, "") || DEFAULTS[requested].baseUrl,
    usingStub: false,
    reason: "",
  };
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`HTTP ${res.status} from ${url}: ${detail}`);
  }
  return res.json();
}

// --- Real adapters (each: ({system, prompt, maxTokens}) -> text) -----------

async function anthropicComplete(cfg, { system, prompt, maxTokens }) {
  const data = await postJson(
    `${cfg.baseUrl}/v1/messages`,
    { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    {
      model: cfg.model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }
  );
  return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function openaiChatComplete(cfg, { system, prompt, maxTokens }, maxTokensField) {
  const data = await postJson(
    `${cfg.baseUrl}/v1/chat/completions`,
    { authorization: `Bearer ${cfg.apiKey}` },
    {
      model: cfg.model,
      [maxTokensField]: maxTokens,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
    }
  );
  return data.choices?.[0]?.message?.content ?? "";
}

const ADAPTERS = {
  anthropic: (cfg, req) => anthropicComplete(cfg, req),
  openai: (cfg, req) => openaiChatComplete(cfg, req, "max_completion_tokens"),
  // OpenRouter is OpenAI-compatible; different origin + model naming, and the
  // older `max_tokens` field for broad model compatibility.
  openrouter: (cfg, req) => openaiChatComplete(cfg, req, "max_tokens"),
};

/**
 * Create a provider from env config. Real providers are wrapped so that ANY
 * failure (network, auth, malformed response) logs a warning and falls back
 * to the stub for that call — never a crash.
 */
export function createProvider({ env = process.env, log = console } = {}) {
  const cfg = resolveProviderConfig(env);
  const stub = createStubProvider();
  if (cfg.usingStub) {
    return { ...stub, config: cfg };
  }
  const adapter = ADAPTERS[cfg.provider];
  return {
    provider: cfg.provider,
    model: cfg.model,
    config: cfg,
    async complete({ system = "", prompt, maxTokens = 3000 }) {
      try {
        const text = await adapter(cfg, { system, prompt, maxTokens });
        if (!text) throw new Error("provider returned an empty completion");
        return { text, provider: cfg.provider, model: cfg.model };
      } catch (err) {
        log.warn?.(
          `[ai] ${cfg.provider} call failed (${err.message}) — falling back to the stub provider for this call`
        );
        return stub.complete({ system, prompt, maxTokens });
      }
    },
  };
}
