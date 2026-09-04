"use strict";
/*
 * opengrok Contract A — direct body maps (client-side lanes + the box hop).
 * See docs/HOST-INTEGRATION.md for the consumer contract.
 *
 * Provider maps: Grok Bot harness control plane -> upstream wire fields.
 * Consumed by box/openai-hop-session.cjs (see docs/HOST-INTEGRATION.md).
 *
 * Grok (xAI) is IMPLEMENTED. All routes are live-verified (wire captures per CONTRIBUTING.md). No
 * fabricated generic passthroughs: a control that cannot be expressed on a
 * provider wire is an explicit noop, never guessed.
 *
 * Authoritative upstream facts:
 *  - xAI grok-4.6 / grok-4.5: reasoning_effort in {low, medium, high (default), xhigh},
 *    reasoning is always-on (no "none"). Source: docs.x.ai (verified 2026-08-22).
 */

var GROK_MODEL_RE = /^grok[-.]/i;

// Normalize harness 'effort' values to an xAI reasoning_effort token.
var EFFORT_TO_XAI = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
  xhigh: "xhigh",
  minimal: "low",
};

function isGrokRoute(modelId, baseUrl) {
  if (GROK_MODEL_RE.test(String(modelId || ""))) return true;
  // The box hop resolves grok slugs to the Windows shim; the shim is api.x.ai.
  return /127\.0\.0\.1:18779/.test(String(baseUrl || ""));
}

function param(parameters, id) {
  if (!Array.isArray(parameters)) return undefined;
  for (var i = 0; i < parameters.length; i++) {
    var p = parameters[i];
    if (p && p.id === id) return p.value;
  }
  return undefined;
}

/*
 * Grok map (harness -> xAI chat/completions, pass-through via the :18779 shim):
 *   maxMode:true                    -> reasoning_effort:"xhigh"
 *   parameters[effort]=low/med/high -> reasoning_effort:"<same>"
 *   parameters[effort]=max          -> reasoning_effort:"xhigh"
 *   parameters[fast]=true           -> reasoning_effort:"low"  (overrides effort)
 *   parameters[thinking]            -> no-op (always-on; never emit "none")
 *   parameters[context]"1m"         -> no wire field (client display hint)
 */
function applyGrok(body, maxMode, parameters) {
  var effort = param(parameters, "effort");
  var fast = param(parameters, "fast");
  if (maxMode === true) {
    body.reasoning_effort = "xhigh";
    return;
  }
  if (fast === true) {
    body.reasoning_effort = "low";
    return;
  }
  if (effort != null && Object.prototype.hasOwnProperty.call(EFFORT_TO_XAI, String(effort))) {
    body.reasoning_effort = EFFORT_TO_XAI[String(effort)];
    return;
  }
  // thinking:true/false and absent effort -> omit reasoning_effort -> xAI default (high).
}

/*
 * Entry point. ctx: { modelId, baseUrl, maxMode, parameters, requestKind, localQwen }.
 * Only mutates body for routes the map understands; returns the route label applied
 * ("grok", "claude-passthrough", "gemini-slug", "deepseek-thinking", "none") so the
 * caller can audit it.
 *
 * ---- Extended 2026-08-26 (Hermes session; every rule below cites session-verified
 * evidence, see ~/grok-native-integration-map.md §2.2/§4-A) ---------------------
 *
 * CLAUDE (oauth plans via :18776): the shim ALREADY pins thinking to
 *   {type:"adaptive",display:"summarized"} and defangs tool-name signatures both
 *   directions. Any harness-side thinking/effort emission would only fight the
 *   shim. Verified map = strict pass-through, emit nothing.
 *
 * GEMINI (:18778 antigravity): thought-signature cache/reattach is handled INSIDE
 *   the shim; there is no verified in-body reasoning field. What IS verified:
 *   distinct tiered slugs exist for the gemini-3.6-flash family only
 *   (gemini-3.6-flash-low/-medium/-high, from the live provider catalog).
 *   Map = effort -> slug suffix for that family, clamped to "high"; every other
 *   gemini id left untouched (no invented tiers).
 *
 * DEEPSEEK v4 (nano-gpt/wirebench): RL-trained on the DeepSeek Harness wire
 *   shape, which always carries TOP-LEVEL thinking:{type:"enabled"},
 *   reasoning_effort:"high", max_tokens:256000 (openai-sdk callers put these in
 *   extra_body -> same JSON root on the wire). Generic requests missing them read
 *   as degraded ("harness-less"). Verified slugs carry a ":thinking" suffix;
 *   thinking-mode is opt-in per slug outside that. Map:
 *     - modelId endsWith ":thinking"            -> always enable thinking
 *       (or any deepseek id when harness thinking === true)
 *     - thinking enabled                        -> ensure reasoning_effort
 *                                                  defaults "high", and set
 *                                                  max_tokens 256000 ONLY if
 *                                                  caller omitted it.
 *
 * UNSPECIALIZED (no session-verified wire dump -> never fabricate): xiaomi mimo,
 *   plain chat_completions lanes where the stock request already carries intent,
 *   hermes-agent (:18790 hop target; api_server speaks standard OpenAI wire).
 */
function applyProviderReasoningControls(body, ctx) {
  ctx = ctx || {};
  var modelId = String(ctx.modelId || "");
  var baseUrl = String(ctx.baseUrl || "");
  if (isGrokRoute(modelId, baseUrl)) {
    applyGrok(body, ctx.maxMode === true, ctx.parameters);
    return "grok";
  }
  if (isClaudeRoute(modelId, baseUrl)) {
    // Pass-through BY DESIGN: :18776 owns thinking/tool-defang wire state.
    return "claude-passthrough";
  }
  if (isGeminiRoute(modelId, baseUrl)) {
    var gApplied = applyGemini(body, ctx.parameters);
    return gApplied ? "gemini-slug" : "gemini-passthrough";
  }
  if (isDeepSeekRoute(modelId, baseUrl)) {
    var dApplied = applyDeepSeek(body, modelId, ctx.parameters);
    return dApplied ? "deepseek-thinking" : "deepseek-passthrough";
  }
  if (isGlmRoute(modelId, baseUrl)) {
    var gLabel = applyGlm(body, ctx.parameters);
    return gLabel || "glm-passthrough";
  }
  if (isQwenRoute(modelId, baseUrl)) {
    return applyQwen(body, ctx.maxMode === true, ctx.parameters);
  }
  return "none";
}

/*
 * GLM (Zhipu bigmodel.cn CODING endpoint) — VERIFIED LIVE 2026-08-27,
 * 7-probe capture vs glm-5.3-flash (machine-local capture dir, not in repo).
 * Verified: top-level thinking:{type:enabled|disabled} + reasoning_effort in
 * {low,medium,high,max} all accepted; BARE requests think by default (~high);
 * thinking:disabled is a TRUE off-switch; "max" is a valid GLM token.
 * Philosophy: minimal intervention — fill caller intent only, never paint
 * fields onto silent requests (bare GLM is already native-shaped).
 */
function applyGlm(body, parameters) {
  var fast = param(parameters, "fast");
  if (fast === true || String(fast).toLowerCase() === "true") {
    body.thinking = { type: "disabled" };
    return "glm-fast-off";
  }
  var effort = param(parameters, "effort");
  var GLM_EFFORT = { low: "low", medium: "medium", high: "high",
                     max: "max", xhigh: "max", maximal: "max" };
  var token = effort != null ? GLM_EFFORT[String(effort)] : undefined;
  if (token) {
    if (!body.thinking) body.thinking = { type: "enabled" };
    if (body.reasoning_effort == null) body.reasoning_effort = token;
    return "glm-effort";
  }
  var t = param(parameters, "thinking");
  if (t === false || String(t).toLowerCase() === "false") {
    body.thinking = { type: "disabled" };
    return "glm-thinking-off";
  }
  return null; // silent request stays untouched
}

var GLM_MODEL_RE = /^(glm[-.\d]|zai-org\/glm)/i;
var GLM_BASE_RE = /(bigmodel\.cn|friendli|127\.0\.0\.1:18791)/i;
function isGlmRoute(modelId, baseUrl) {
  if (GLM_MODEL_RE.test(String(modelId || ""))) return true;
  return GLM_BASE_RE.test(String(baseUrl || ""));
}

var CLAUDE_MODEL_RE = /^claude[-.]/i;
function isClaudeRoute(modelId, baseUrl) {
  if (CLAUDE_MODEL_RE.test(modelId)) return true;
  return /127\.0\.0\.1:18776/.test(baseUrl);
}

var GEMINI_MODEL_RE = /^gemini/i;
var GEMINI_TIERED_FAMILY_RE = /^gemini-3\.6-flash$/i; // only verified tiered family
var GEMINI_EFFORT_TO_SLUG = { low: "low", medium: "medium", high: "high", max: "high", xhigh: "high" };
function isGeminiRoute(modelId, baseUrl) {
  if (GEMINI_MODEL_RE.test(modelId)) return true;
  return /127\.0\.0\.1:18778/.test(baseUrl);
}
function applyGemini(body, parameters) {
  // Rewrite body.model only when the id is EXACTLY the tiered family and a
  // recognized effort is present. Never touch 3.7-flash/thinking variants.
  var m = String(body.model || "");
  if (!GEMINI_TIERED_FAMILY_RE.test(m)) return false;
  var effort = param(parameters, "effort");
  if (effort == null && !(param(parameters, "fast") != null)) return false;
  if (param(parameters, "fast") === true) return false; // no verified fast slug -> leave defaults
  var token = GEMINI_EFFORT_TO_SLUG[String(effort)];
  if (!token) return false;
  body.model = m + "-" + token;
  return true;
}

var DEEPSEEK_MODEL_RE = /deepseek/i;
var DEEPSEEK_BASE_RE = /(nano-gpt\.com|127\.0\.0\.1:8791)/;
function isDeepSeekRoute(modelId, baseUrl) {
  if (DEEPSEEK_MODEL_RE.test(modelId)) return true;
  return DEEPSEEK_BASE_RE.test(baseUrl);
}
function applyDeepSeek(body, modelId, parameters) {
  var slugThinking = /:thinking\s*$/i.test(String(modelId));
  var harnessThinking = param(parameters, "thinking");
  var enable = slugThinking || harnessThinking === true || String(harnessThinking).toLowerCase() === "true";
  if (!enable) return false;
  // Top-level (post-extra_body merge) DeepSeek Harness wire shape:
  body.thinking = { type: "enabled" };
  if (body.reasoning_effort == null) body.reasoning_effort = "high";
  if (body.max_tokens == null) body.max_tokens = 256000;
  return true;
}

function isQwenRoute(modelId, baseUrl) {
  if (/qwen/i.test(String(modelId || ""))) {
    return /127\.0\.0\.1:18787/.test(String(baseUrl || ""));
  }
  return /127\.0\.0\.1:18787/.test(String(baseUrl || ""));
}

function applyQwen(body, maxMode, parameters) {
  var thinking = param(parameters, "thinking");
  var enableThinking = thinking === true || String(thinking).toLowerCase() === "true" || (thinking !== false && maxMode === true);
  if (!body.chat_template_kwargs) body.chat_template_kwargs = {};
  body.chat_template_kwargs.enable_thinking = enableThinking;
  var effort = param(parameters, "effort");
  if (effort != null) {
    body.reasoning_effort = String(effort);
  }
  return "qwen-local";
}

function repairTruncatedJson(str) {
  if (typeof str !== "string") return null;
  var s = str.trim();
  if (!s) return "{}";

  try {
    var direct = JSON.parse(s);
    return typeof direct === "object" && direct !== null ? JSON.stringify(direct) : null;
  } catch (e) {}

  if (!s.startsWith("{") && !s.startsWith("[")) {
    s = "{" + s;
  }

  var inString = false;
  var isEscaped = false;
  var cleanChars = [];

  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (isEscaped) {
      isEscaped = false;
      cleanChars.push(ch);
      continue;
    }
    if (ch === "\\") {
      isEscaped = true;
      cleanChars.push(ch);
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      cleanChars.push(ch);
      continue;
    }
    cleanChars.push(ch);
  }

  var repaired = cleanChars.join("");
  if (inString) {
    if (isEscaped) {
      repaired = repaired.slice(0, -1);
    }
    repaired += '"';
  }

  var stack = [];
  var inStr = false;
  var esc = false;
  for (var j = 0; j < repaired.length; j++) {
    var c = repaired[j];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (!inStr) {
      if (c === "{" || c === "[") {
        stack.push(c);
      } else if (c === "}") {
        if (stack.length > 0 && stack[stack.length - 1] === "{") stack.pop();
      } else if (c === "]") {
        if (stack.length > 0 && stack[stack.length - 1] === "[") stack.pop();
      }
    }
  }

  if (stack.length > 0 && stack[stack.length - 1] === "{") {
    if (/:\s*$/.test(repaired)) {
      repaired = repaired.replace(/:\s*$/, ": null");
    } else if (/\{\s*""\s*$/.test(repaired)) {
      repaired = repaired.replace(/\{\s*""\s*$/, "{");
    } else if (/,\s*""\s*$/.test(repaired)) {
      repaired = repaired.replace(/,\s*""\s*$/, "");
    } else if (/([{,]\s*)"([^"]+)"\s*$/.test(repaired)) {
      repaired += ": null";
    }
  }

  repaired = repaired.replace(/,\s*$/, "");

  var finalStack = [];
  inStr = false;
  esc = false;
  for (var k = 0; k < repaired.length; k++) {
    var cur = repaired[k];
    if (esc) {
      esc = false;
      continue;
    }
    if (cur === "\\") {
      esc = true;
      continue;
    }
    if (cur === '"') {
      inStr = !inStr;
      continue;
    }
    if (!inStr) {
      if (cur === "{" || cur === "[") {
        finalStack.push(cur);
      } else if (cur === "}") {
        if (finalStack.length > 0 && finalStack[finalStack.length - 1] === "{") finalStack.pop();
      } else if (cur === "]") {
        if (finalStack.length > 0 && finalStack[finalStack.length - 1] === "[") finalStack.pop();
      }
    }
  }

  while (finalStack.length > 0) {
    var open = finalStack.pop();
    if (open === "{") {
      repaired = repaired.replace(/,\s*$/, "") + "}";
    } else if (open === "[") {
      repaired = repaired.replace(/,\s*$/, "") + "]";
    }
  }

  try {
    var parsed = JSON.parse(repaired);
    if (typeof parsed === "object" && parsed !== null) {
      return JSON.stringify(parsed);
    }
  } catch (e) {}

  return null;
}

function canonicalToolArguments(raw) {
  var parsed;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      var repaired = repairTruncatedJson(raw);
      if (repaired != null) {
        try {
          parsed = JSON.parse(repaired);
        } catch (err) {
          return null;
        }
      } else {
        return null;
      }
    }
  } else {
    parsed = raw;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  try {
    return JSON.stringify(parsed);
  } catch (e) {
    return null;
  }
}

function repairTruncatedJsonArguments(raw) {
  return repairTruncatedJson(raw);
}

var ToolArgumentRepairEngine = {
  canonical_tool_arguments: canonicalToolArguments,
  canonicalToolArguments: canonicalToolArguments,
  repair_json_string: repairTruncatedJson,
  repairTruncatedJson: repairTruncatedJson,
  repairTruncatedJsonArguments: repairTruncatedJson
};

module.exports = {
  applyProviderReasoningControls: applyProviderReasoningControls,
  isGrokRoute: isGrokRoute,
  isClaudeRoute: isClaudeRoute,
  isGeminiRoute: isGeminiRoute,
  isDeepSeekRoute: isDeepSeekRoute,
  isGlmRoute: isGlmRoute,
  isQwenRoute: isQwenRoute,
  applyGrok: applyGrok,
  applyGemini: applyGemini,
  applyDeepSeek: applyDeepSeek,
  applyGlm: applyGlm,
  applyQwen: applyQwen,
  repairTruncatedJson: repairTruncatedJson,
  repairTruncatedJsonArguments: repairTruncatedJsonArguments,
  canonicalToolArguments: canonicalToolArguments,
  ToolArgumentRepairEngine: ToolArgumentRepairEngine,
  __test: {
    EFFORT_TO_XAI: EFFORT_TO_XAI,
    applyGrok: applyGrok,
    isClaudeRoute: isClaudeRoute,
    isGeminiRoute: isGeminiRoute,
    applyGemini: applyGemini,
    isDeepSeekRoute: isDeepSeekRoute,
    applyDeepSeek: applyDeepSeek,
    isGlmRoute: isGlmRoute,
    applyGlm: applyGlm,
    isQwenRoute: isQwenRoute,
    applyQwen: applyQwen,
    repairTruncatedJson: repairTruncatedJson,
    repairTruncatedJsonArguments: repairTruncatedJsonArguments,
    canonicalToolArguments: canonicalToolArguments,
    ToolArgumentRepairEngine: ToolArgumentRepairEngine
  },
};