"use strict";
/**
 * Harness → provider wire maps for Grok Bot hop specialists.
 * Contract: harness-shim parity checklist §4.2 — applyHarnessControls(body, {modelId, provider, maxMode, parameters}) -> {body, route, applied, unknownIds}.
 *
 * Harness control plane (same ids as native RequestedModel.parameters):
 *   thinking: "true" | "false"
 *   effort:   "low" | "medium" | "high" | ...
 *   fast:     "true" | "false"
 *   context:  string (e.g. "1m") — often catalog-only; route may no-op
 *   maxMode:  boolean on RequestedModel / sessionOptions
 *
 * Only maps controls. Does not invent briefings or override an explicit caller value
 * already present on the OpenAI body.
 *
 * Fail-closed rule: if a control cannot be expressed on the provider/shim wire,
 * document an explicit noop in applied.wire — never silently pretend.
 */

function asParamsObject(parameters) {
  const out = Object.create(null);
  if (!Array.isArray(parameters)) return out;
  for (const p of parameters) {
    if (!p || typeof p !== "object") continue;
    const id = typeof p.id === "string" ? p.id : null;
    if (!id) continue;
    if (p.value == null) continue;
    out[id] = String(p.value);
  }
  return out;
}

function routeNameForModel(modelId, providerHint) {
  const m = String(modelId || "").toLowerCase();
  const p = String(providerHint || "").toLowerCase();
  if (p.includes("grok") || p.includes("superheavy") || m.startsWith("grok") || m.includes("superheavy")) {
    return "grok-superheavy";
  }
  if (p.includes("claude") || m.includes("claude") || m.includes("opus") || m.includes("fable")) {
    return "claude-plans";
  }
  if (p.includes("gemini") || p.includes("antigravity") || m.includes("gemini")) {
    return "antigravity-plan";
  }
  // Prefer explicit provider before model-id heuristics.
  // qwen-token-plan (Aliyun cloud) and sglang-local (Hermes Windows/AI-PC)
  // share the enable_thinking wire table but must keep distinct route labels
  // in harness-control-audit (same honesty bar as antigravity fail-closed).
  if (p.includes("qwen-token") || p === "qwen-token-plan") {
    return "qwen-token-plan";
  }
  if (p.includes("sglang") || m.includes("local-qwen") || m.startsWith("local-qwen")) {
    return "sglang-local";
  }
  if (p.includes("qwen") || m.includes("qwen")) {
    if (m.includes("local-") || m.includes("qwen38-27b")) return "sglang-local";
    return "qwen-token-plan";
  }
  if (p.includes("glm") || m.startsWith("glm")) return "glm-coding-plan";
  if (p.includes("xiaomi") || m.includes("mimo")) return "xiaomi";
  if (p.includes("nano") || m.includes("deepseek")) return "nano-gpt";
  return "unknown";
}

/**
 * @param {object} input
 * @param {string} [input.modelId]
 * @param {string} [input.provider]
 * @param {boolean} [input.maxMode]
 * @param {Array<{id:string,value:string}>|object} [input.parameters]
 * @param {object} [input.body] existing OpenAI body (mutated copy returned)
 * @returns {{ body: object, route: string, applied: object, unknownIds: string[] }}
 */
function applyHarnessControls(input) {
  const body = Object.assign({}, (input && input.body) || {});
  const params = Array.isArray(input && input.parameters)
    ? asParamsObject(input.parameters)
    : Object.assign(Object.create(null), (input && input.parameters) || {});
  const unknownIds = [];
  const known = new Set(["thinking", "effort", "fast", "context"]);
  for (const id of Object.keys(params)) {
    if (!known.has(id)) unknownIds.push(id);
  }

  const route = routeNameForModel(input && input.modelId, input && input.provider);
  const maxMode = !!(input && input.maxMode);
  const applied = {
    route,
    maxMode,
    thinking: params.thinking ?? null,
    effort: params.effort ?? null,
    fast: params.fast ?? null,
    context: params.context ?? null
  };

  if (route === "grok-superheavy") {
    // Wire table (Windows Grok shim OpenAI-compat → xAI):
    //   maxMode          → reasoning_effort="high" when effort omitted
    //   effort           → reasoning_effort (explicit wins)
    //   thinking=false   → reasoning_effort="low" (when unset)
    //   fast=true + thinking=false → reasoning_effort="low"
    //   fast alone       → noop (no discrete fast wire; pair with thinking/effort)
    //   context          → noop (no OpenAI wire field on this shim)
    // Prefer explicit harness params. maxMode≈high effort when effort omitted.
    let effort = params.effort;
    if (effort == null) {
      if (params.fast === "true" && params.thinking === "false") effort = "low";
      else if (maxMode) effort = "high";
      else if (params.thinking === "false") effort = "low";
      else effort = null; // leave provider default
    }
    if (effort != null && body.reasoning_effort == null) {
      body.reasoning_effort = effort;
      applied.wire = {
        reasoning_effort: effort,
        context: { status: "noop", reason: "no-openAi-context-wire" },
        fast: params.fast == null
          ? { status: "unset" }
          : (params.fast === "true" && params.thinking === "false"
            ? { status: "mapped-via-effort-low" }
            : { status: "noop", reason: "fast-alone-no-discrete-wire" })
      };
    } else {
      applied.wire = body.reasoning_effort != null
        ? {
            reasoning_effort: body.reasoning_effort,
            note: "preserved-existing",
            context: { status: "noop", reason: "no-openAi-context-wire" }
          }
        : {
            reasoning_effort: null,
            note: "provider-default",
            context: { status: "noop", reason: "no-openAi-context-wire" }
          };
    }
    // thinking=false with no effort already mapped → still ask for low if unset
    if (params.thinking === "false" && body.reasoning_effort == null) {
      body.reasoning_effort = "low";
      applied.wire = {
        reasoning_effort: "low",
        context: { status: "noop", reason: "no-openAi-context-wire" }
      };
    }
    return { body, route, applied, unknownIds };
  }

  if (route === "claude-plans") {
    // Wire table (Windows Claude Hermes shim :18776 via multi-hop):
    //   effort           → reasoning_effort when explicit (do not invent)
    //   thinking         → SHIM-OWNED: adaptive + summarized display pinned in
    //                      Windows shim / thinkingPin. Never inject type=enabled
    //                      or budget_tokens here (400 on Opus 5 / Fable 5).
    //   maxMode          → noop (no discrete Claude wire; effort is the lever)
    //   fast             → noop (no Claude fast wire on OpenAI-compat body)
    //   context          → noop on hop body (1m is catalog/native selection)
    // Pass effort through as reasoning_effort only when explicit; never fight shim adaptive.
    const wire = {
      note: "claude-shim-owns-thinking",
      thinking: { status: "shim-owned", reason: "adaptive+summarized pinned in Windows shim" },
      maxMode: { status: "noop", reason: "no-discrete-wire; use effort" },
      fast: { status: "noop", reason: "no-claude-fast-wire" },
      context: { status: "noop", reason: "no-hop-context-wire" }
    };
    if (params.effort != null && body.reasoning_effort == null) {
      body.reasoning_effort = params.effort;
      wire.reasoning_effort = params.effort;
    } else if (body.reasoning_effort != null) {
      wire.reasoning_effort = { value: body.reasoning_effort, note: "preserved-existing" };
    } else {
      wire.reasoning_effort = { value: null, note: "shim-API-default-high" };
    }
    applied.wire = wire;
    return { body, route, applied, unknownIds };
  }

  if (route === "antigravity-plan") {
    // Wire table (Windows Antigravity OpenAI-compat shim :18778):
    // Inspected openai_to_antigravity_req in antigravity-shim-server.py —
    // ONLY these OpenAI fields become Gemini generationConfig:
    //   max_tokens → maxOutputTokens
    //   temperature → temperature
    //   top_p → topP
    // Box antigravity-hop.cjs forwards the chat/completions body verbatim;
    // health() documents thinking:{type:adaptive,display:summarized} as a
    // decorative pin, not a live wire control.
    // Fail-closed: do NOT set reasoning_effort / thinkingConfig / rewrite
    // modelId to *-high. Identity-map only (gemini-3.7-flash|…-high).
    applied.wire = {
      note: "antigravity-shim-no-harness-wire",
      accepted_by_shim: ["max_tokens", "temperature", "top_p"],
      maxMode: { status: "noop", reason: "shim-has-no-maxMode-field" },
      thinking: { status: "noop", reason: "shim-does-not-forward-thinkingConfig" },
      effort: { status: "noop", reason: "shim-ignores-reasoning_effort" },
      fast: { status: "noop", reason: "shim-has-no-fast-profile" },
      context: { status: "noop", reason: "no-wire-context-control" },
      modelId: { status: "identity-map-only", reason: "never-alias-3.7-to-3.6-or-rewrite-slug" }
    };
    // Explicit: leave body.reasoning_effort untouched / unset for this route.
    return { body, route, applied, unknownIds };
  }

  if (route === "sglang-local" || route === "qwen-token-plan") {
    const enableThinking = params.thinking === "true" || (params.thinking == null && maxMode);
    if (body.chat_template_kwargs == null) body.chat_template_kwargs = {};
    if (body.chat_template_kwargs.enable_thinking == null) {
      body.chat_template_kwargs.enable_thinking = enableThinking && params.thinking !== "false";
    }
    if (params.effort != null && body.reasoning_effort == null) {
      body.reasoning_effort = params.effort;
    }
    applied.wire = {
      enable_thinking: body.chat_template_kwargs.enable_thinking,
      reasoning_effort: body.reasoning_effort ?? null,
      fast: { status: "noop", reason: "no-discrete-qwen-fast-wire" },
      context: { status: "noop", reason: "context-window-is-runtime-advertised" }
    };
    return { body, route, applied, unknownIds };
  }

  if (route === "glm-coding-plan") {
    // Z.ai wire facts LIVE-VERIFIED 2026-08-27 (7-probe capture, glm-5.3-flash,
    // open.bigmodel.cn/api/coding/paas/v4 — see opengrok docs):
    //   - bare requests THINK BY DEFAULT (~high) — silence is not cheap
    //   - reasoning_effort accepts literal low|medium|high|max (max is real)
    //   - thinking:{type:"disabled"} is a TRUE off-switch → fast maps to it
    if (params.fast === "true" && body.thinking == null) {
      body.thinking = { type: "disabled" };
    }
    if (params.effort != null && body.reasoning_effort == null) {
      const tok = { low:"low", medium:"medium", high:"high", max:"max",
                    xhigh:"max", maximal:"max" }[String(params.effort)];
      if (tok != null) {
        body.reasoning_effort = tok;
        if (body.thinking == null) body.thinking = { type: "enabled" };
      }
      // unknown effort token: leave provider default, do not guess
    }
    applied.wire = {
      note: "glm-hop-dialect+verified-wire",
      reasoning_effort: body.reasoning_effort ?? null,
      thinking: body.thinking ?? { status: "default-on" },
      maxMode: { status: "partial", reason: "via-effort-fold-xhigh-to-max" },
      fast: { status: "thinking-disabled-offswitch", reason: "live-verified-2026-08-27" },
      context: { status: "noop", reason: "no-hop-context-wire" }
    };
    return { body, route, applied, unknownIds };
  }

  if (route === "nano-gpt") {
    // Wire table (nano-gpt OpenAI-compat → DeepSeek via nano-gpt.com):
    //   thinking          → MODEL SLUG owns it: use deepseek/...-0813:thinking
    //                       vs deepseek/...-0813 (non-thinking). Do not invent
    //                       a separate thinking body field (provider-specific).
    //   effort            → reasoning_effort when explicit
    //   maxMode           → partial via effort=high when effort omitted
    //   fast / context    → noop on this OpenAI-compat body
    // Fail-closed: never rewrite modelId here (host binding chooses slug).
    const wire = {
      note: "nano-gpt-deepseek-slug-owns-thinking",
      thinking: {
        status: "model-slug",
        reason: "use deepseek/deepseek-v4-pro-0813:thinking vs non-thinking twin"
      },
      maxMode: { status: "partial", reason: "via-effort-when-set-or-maxMode-default-high" },
      fast: { status: "noop", reason: "no-nano-gpt-fast-wire" },
      context: { status: "noop", reason: "no-hop-context-wire" },
      modelId: { status: "identity-map-only", reason: "host-binding-selects-slug" }
    };
    let effort = params.effort;
    if (effort == null && maxMode) effort = "high";
    if (effort != null && body.reasoning_effort == null) {
      body.reasoning_effort = effort;
      wire.reasoning_effort = effort;
    } else if (body.reasoning_effort != null) {
      wire.reasoning_effort = { value: body.reasoning_effort, note: "preserved-existing" };
    } else {
      wire.reasoning_effort = { value: null, note: "provider-default" };
    }
    applied.wire = wire;
    return { body, route, applied, unknownIds };
  }

  // unknown / nano / xiaomi: pass through effort only; document gap
  if (params.effort != null && body.reasoning_effort == null) {
    body.reasoning_effort = params.effort;
  }
  applied.wire = {
    note: "passthrough-or-unmapped-route",
    reasoning_effort: body.reasoning_effort ?? null,
    thinking: { status: "unmapped", reason: "route-has-no-dedicated-table" },
    maxMode: { status: "unmapped", reason: "route-has-no-dedicated-table" },
    fast: { status: "unmapped", reason: "route-has-no-dedicated-table" },
    context: { status: "unmapped", reason: "route-has-no-dedicated-table" }
  };
  return { body, route, applied, unknownIds };
}

module.exports = {
  applyHarnessControls,
  routeNameForModel,
  asParamsObject,
  KNOWN_PARAM_IDS: ["thinking", "effort", "fast", "context"]
};
