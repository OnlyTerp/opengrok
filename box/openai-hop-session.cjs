#!/usr/bin/env node
"use strict";
/**
 * PromptSession/executor duck-typed to MockPromptExecutor + ProtoPromptExecutor.stream.
 * POSTs OpenAI-compatible streaming chat completions to a local hop (never logs secrets).
 * Stable system/developer prefix. Reasoning stays type:"reasoning". Cache usage is forwarded.
 *
 * Working/streaming contract (must match catalog models or the UI goes idle):
 *   text-delta, reasoning, tool-call-streaming-start, tool-call-delta, tool-call, finish, error
 * Immediate first event + idle heartbeats so Grok Bot's working chip never vanishes.
 * Always finish or error; never hang. Hot-reload: host should delete require.cache on createSession.
 */
const http = require("http");
const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");
const fs = require("fs");
let applyProviderReasoningControls;
try {
  ({ applyProviderReasoningControls } = require("/home/box/sand-data/provider-maps.cjs"));
} catch {
  try {
    ({ applyProviderReasoningControls } = require("./provider-maps.cjs"));
  } catch {
    try {
      ({ applyProviderReasoningControls } = require("./provider-maps.cjs")); // same-dir fallback (Windows runs)
    } catch {
      applyProviderReasoningControls = (body) => body;
    }
  }
}

const ZWSP = "\u200b";
const LOCAL_QWEN_CONTEXT_WINDOW = 196608;
// A single-sequence local model may spend more than 45s queued behind a long
// prefill. Keep a hard upper bound, but emit host heartbeats while waiting so
// the UI does not mark the turn dead before upstream headers arrive.
const HEADERS_TIMEOUT_MS = 120000;
const SSE_IDLE_MS = 120000;
const HEARTBEAT_MS = 4000;
const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_HOP_RETRIES = 3;
const PROVENANCE_SCHEMA = "GROKBOT_LOCAL_PROVENANCE_V1";
const PROVENANCE_AUDIT_PATH = process.env.GROKBOT_LOCAL_PROVENANCE_LOG ||
  (process.env.GROKBOT_STATE_DIR
    ? require("path").join(process.env.GROKBOT_STATE_DIR, "local-bound-provenance.jsonl")
    : "/home/box/sand-data/local-bound-provenance.jsonl");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_METADATA_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,199}$/;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const KNOWN_CONTEXT_WINDOWS = {
  "grok-4.6": 2097152,
  "grok-4.6-superheavy": 2097152,
  "local-qwen38-27b": 196608,
  "local-qwen38-27b-aipc": 131072,
  "deepseek/deepseek-v4-pro-0813:thinking": 262144,
  "deepseek/deepseek-v4-pro": 262144,
  "deepseek/deepseek-v4-flash-0731:thinking": 262144,
  "deepseek/deepseek-v4-flash": 262144,
  "qwen3.8-max": 262144,
  "mimo-v2.5-pro-ultraspeed": 1048576,
  "glm-5.3": 1048576,
  "glm-5.3-flash": 1048576,
  "zai-org/GLM-5.3-Flash": 1048576,
  "gemini-3.7-flash": 1048576,
  "gemini-3.7-flash-thinking": 1048576,
  "gemini-3.6-flash": 1048576,
  "gemini-3.6-flash-low": 1048576,
  "gemini-3.6-flash-medium": 1048576,
  "gemini-3.6-flash-high": 1048576,
  "gpt-5.6-luna-max": 1048576,
  "claude-opus-5": 200000,
  "claude-opus-5-oauth-1": 200000,
  "claude-opus-5-oauth-3": 200000,
  "claude-fable-5-oauth-1": 200000,
  "claude-fable-5-oauth-3": 200000
};

function reportedContextWindow(modelId, baseUrl, parameters) {
  if (Array.isArray(parameters)) {
    for (const p of parameters) {
      if (p && p.id === "context" && typeof p.value === "string") {
        const val = p.value.trim().toLowerCase();
        if (val === "2m") return 2097152;
        if (val === "1m") return 1048576;
        if (val === "256k") return 262144;
        if (val === "196k" || val === "192k") return 196608;
        if (val === "128k") return 131072;
      }
    }
  }
  const normalizedId = String(modelId || "").trim().toLowerCase();
  if (KNOWN_CONTEXT_WINDOWS[normalizedId]) {
    return KNOWN_CONTEXT_WINDOWS[normalizedId];
  }
  if (normalizedId.startsWith("grok")) return 2097152;
  if (normalizedId.includes("claude") || normalizedId.includes("opus") || normalizedId.includes("fable")) return 200000;
  if (normalizedId.includes("gemini")) return 1048576;
  if (normalizedId.includes("deepseek")) return 262144;
  if (normalizedId.includes("glm") || normalizedId.includes("zai-org")) return 1048576;
  if (normalizedId.includes("qwen")) return 196608;
  if (normalizedId.includes("luna") || normalizedId.includes("gpt-5")) return 1048576;

  return 131072;
}

function isLocalQwenRoute(modelId, baseUrl) {
  if (String(modelId || "").trim().toLowerCase() !== "local-qwen38-27b") return false;
  try {
    const parsed = new URL(String(baseUrl || ""));
    return parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port === "18787" &&
      (parsed.pathname === "/v1" || parsed.pathname === "/v1/") &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function requireTraceContext(agentId, baseUrl) {
  const normalizedAgentId = String(agentId || "").trim();
  if (!UUID_RE.test(normalizedAgentId)) {
    throw new Error("local-bound provenance requires a valid agent UUID");
  }
  let parsed;
  try {
    parsed = new URL(String(baseUrl || ""));
  } catch {
    throw new Error("local-bound provenance requires a valid hop URL");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("local-bound provenance hop URL cannot contain credentials, query, or fragment");
  }
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  return {
    agentId: normalizedAgentId,
    routeLabel: parsed.protocol + "//" + parsed.host + path
  };
}

function safeMetadataToken(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return SAFE_METADATA_RE.test(normalized) ? normalized : null;
}

function exactTokenCount(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function ensureProvenanceAuditReady() {
  try {
    const p = process.env.GROKBOT_LOCAL_PROVENANCE_LOG || PROVENANCE_AUDIT_PATH;
    const dir = require("path").dirname(p);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const fd = fs.openSync(p, "a", 0o600);
    fs.closeSync(fd);
    try { fs.chmodSync(p, 0o600); } catch {}
  } catch {}
}

function appendProvenanceRecord(record) {
  try {
    const p = process.env.GROKBOT_LOCAL_PROVENANCE_LOG || PROVENANCE_AUDIT_PATH;
    const line = JSON.stringify(record) + "\n";
    const dir = require("path").dirname(p);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const fd = fs.openSync(p, "a", 0o600);
    try {
      fs.writeSync(fd, line, null, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

const LIVE_METRICS_PATHS = [
  process.env.GROKBOT_LIVE_METRICS_LOG,
  process.env.GROKBOT_STATE_DIR,
  process.env.XDG_STATE_HOME,
  process.env.HOME,
].filter(Boolean).map((base, i) => {
  try {
    if (i === 0) return base;
    if (i === 1 && base) return require("path").join(base, "live-metrics.jsonl");
    return require("path").join(base || ".", ".grokbot", "live-metrics.jsonl");
  } catch { return null; }
}).filter(Boolean);

function recordLiveMetrics(metric) {
  try {
    const line = JSON.stringify(metric) + "\n";
    const customLog = process.env.GROKBOT_LIVE_METRICS_LOG;
    const targets = customLog ? [customLog] : LIVE_METRICS_PATHS;
    for (const p of targets) {
      if (!p) continue;
      try {
        const dir = require("path").dirname(p);
        if (!dir || dir === "." || fs.existsSync(dir)) {
          fs.appendFileSync(p, line, "utf8");
        }
      } catch {}
    }
    try {
      const relayBase = process.env.GROKBOT_METRICS_RELAY; // e.g. http://100.x.y.z:8799 (loopback/private net only)
      if (relayBase && process.platform === "linux") {
        const http = require("http");
        const url = new URL(relayBase + "/append?f=live-metrics.jsonl");
        const req = http.request({
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname + (url.search || ""),
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(line) },
          timeout: 1000
        });
        req.on("error", () => {});
        req.write(line);
        req.end();
      }
    } catch {}
  } catch {}
}

function looksLikeToolMarkup(text) {
  if (!text) return false;
  return /<tool_call\b/i.test(text) || /<\|\s*DSML/i.test(text) || text.includes("<|DSML");
}

function stripToolMarkup(text) {
  if (!text) return "";
  let s = String(text).replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
  s = s.replace(/<\|\s*DSML[\s\S]*/gi, "");
  return s.trim();
}


function flattenText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  const bits = [];
  for (const part of content) {
    if (part == null) continue;
    if (typeof part === "string") bits.push(part);
    else if (part.type === "text" && typeof part.text === "string") bits.push(part.text);
    else if (part.type === "image" || part.type === "image-url" || part.type === "file") bits.push("[media omitted]");
  }
  return bits.join("");
}

function stringifyResult(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function toJsonSchema(parameters) {
  if (parameters == null) return { type: "object", properties: {} };
  if (typeof parameters !== "object") return { type: "object", properties: {} };
  if (parameters.jsonSchema && typeof parameters.jsonSchema === "object") return parameters.jsonSchema;
  if (parameters.type || parameters.properties || parameters.$schema) return parameters;
  return { type: "object", properties: {} };
}

function toOpenAiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "provider-defined") continue;
    const name = tool.name;
    if (typeof name !== "string" || name.length === 0) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: toJsonSchema(tool.parameters)
      }
    });
  }
  return out.length ? out : undefined;
}

function repairTruncatedJson(str) {
  if (typeof str !== "string") return null;
  let s = str.trim();
  if (!s) return "{}";

  try {
    const direct = JSON.parse(s);
    return typeof direct === "object" && direct !== null ? JSON.stringify(direct) : null;
  } catch {}

  if (!s.startsWith("{") && !s.startsWith("[")) {
    s = "{" + s;
  }

  let inString = false;
  let isEscaped = false;
  const cleanChars = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
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

  let repaired = cleanChars.join("");
  if (inString) {
    if (isEscaped) {
      repaired = repaired.slice(0, -1);
    }
    repaired += '"';
  }

  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (!inStr) {
      if (ch === "{" || ch === "[") {
        stack.push(ch);
      } else if (ch === "}") {
        if (stack.length > 0 && stack[stack.length - 1] === "{") stack.pop();
      } else if (ch === "]") {
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

  const finalStack = [];
  inStr = false;
  esc = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (!inStr) {
      if (ch === "{" || ch === "[") {
        finalStack.push(ch);
      } else if (ch === "}") {
        if (finalStack.length > 0 && finalStack[finalStack.length - 1] === "{") finalStack.pop();
      } else if (ch === "]") {
        if (finalStack.length > 0 && finalStack[finalStack.length - 1] === "[") finalStack.pop();
      }
    }
  }

  while (finalStack.length > 0) {
    const open = finalStack.pop();
    if (open === "{") {
      repaired = repaired.replace(/,\s*$/, "") + "}";
    } else if (open === "[") {
      repaired = repaired.replace(/,\s*$/, "") + "]";
    }
  }

  try {
    const parsed = JSON.parse(repaired);
    if (typeof parsed === "object" && parsed !== null) {
      return JSON.stringify(parsed);
    }
  } catch {}

  return null;
}

function repairTruncatedJsonArguments(raw) {
  return repairTruncatedJson(raw);
}

function canonicalToolArguments(raw) {
  let parsed;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const repaired = repairTruncatedJson(raw);
      if (repaired != null) {
        try {
          parsed = JSON.parse(repaired);
        } catch {
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
  } catch {
    return null;
  }
}

const ToolArgumentRepairEngine = {
  canonical_tool_arguments: canonicalToolArguments,
  canonicalToolArguments: canonicalToolArguments,
  repair_json_string: repairTruncatedJson,
  repairTruncatedJson: repairTruncatedJson,
  repairTruncatedJsonArguments: repairTruncatedJson
};

function convertOneMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const role = msg.role;
  if (role === "system" || role === "developer" || role === "user") {
    const mapped = role === "developer" ? "system" : role;
    return { role: mapped, content: flattenText(msg.content) };
  }
  if (role === "assistant") {
    const content = msg.content;
    let text = "";
    const toolCalls = [];
    let invalidToolTurn = false;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part) continue;
        if (part.type === "text") text += part.text || "";
        else if (part.type === "tool-call") {
          const id = typeof part.toolCallId === "string" ? part.toolCallId.trim() : "";
          const name = typeof part.toolName === "string" ? part.toolName.trim() : "";
          const args = canonicalToolArguments(part.args);
          if (!id || !name || args == null) {
            invalidToolTurn = true;
            continue;
          }
          toolCalls.push({
            id,
            type: "function",
            function: {
              name,
              arguments: args
            }
          });
        }
      }
    }
    if (invalidToolTurn) {
      return {
        __grokHopInvalidToolTurn: true,
        textMessage: text.trim().length ? { role: "assistant", content: text } : null
      };
    }
    const m = { role: "assistant", content: text.length ? text : (toolCalls.length ? null : "") };
    if (toolCalls.length) m.tool_calls = toolCalls;
    return m;
  }
  if (role === "tool") {
    const content = msg.content;
    const parts = Array.isArray(content) ? content.filter((p) => p && p.type === "tool-result") : [];
    if (parts.length) {
      return parts.map((p) => ({
        role: "tool",
        tool_call_id: p.toolCallId || "unknown",
        content: stringifyResult(p.result)
      }));
    }
    return {
      role: "tool",
      tool_call_id: msg.toolCallId || "unknown",
      content: flattenText(content)
    };
  }
  return null;
}

// Hop environment briefing. Sanitized default = generic specialist behavior.
// Operators tailor it for THEIR machine via GROKBOT_HOP_BRIEFING_FILE (a text file;
// max 4000 chars) or GROKBOT_HOP_BRIEFING (inline string). Never bake identities.
function loadHopBriefing() {
  const inline = process.env.GROKBOT_HOP_BRIEFING;
  if (inline && inline.trim()) return inline.slice(0, 4000);
  const file = process.env.GROKBOT_HOP_BRIEFING_FILE;
  if (file) {
    try { return fs.readFileSync(file, "utf8").slice(0, 4000); } catch {}
  }
  return "[Grok Bot hop] You are a specialist running inside Grok Bot on the user's "
    + "own computer. Complete work yourself with the tools actually present; do not "
    + "ask the user to perform steps you can do with tools. Use native function/tool "
    + "calls (never XML/DSML tool markup). Prefer connector (MCP) tools where they are "
    + "the real access path. Do not claim routes, links, or credentials are up or down "
    + "without live verification. Keep using tools until the task is actually done, "
    + "then report results plainly. If two equivalent paths exist, pick one, do it, "
    + "and state the assumption.";
}
const HOP_ENV_BRIEFING = loadHopBriefing();

function qwenLiveStateInstruction(baseUrl) {
  if (!/127\.0\.0\.1:18787\/v1/.test(String(baseUrl || ""))) return "";
  try {
    const status = JSON.parse(fs.readFileSync("/home/box/sand-data/grokbot-platform-status.json", "utf8"));
    const qwen = status.checks && status.checks.qwenRoute;
    const canary = status.checks && status.checks.localInferenceCanary;
    if (status.state === "ready" && qwen && qwen.ok === true && qwen.exactModel === true && qwen.contextWindow === 196608 && canary && canary.ok === true && canary.generationMatch === true) {
      return "[Current local route state] This turn is bound to the verified local Qwen38 NVFP4 route. Treat older token, PC-link, or outage claims as historical; reverify live metadata before asserting them.";
    }
  } catch {}
  return "[Current local route state] Live Qwen route metadata is unavailable or not generation-verified. Do not claim the local route, computer link, or token state is up or down; reverify with live health/tools before asserting.";
}

const RESET_COMMAND_PATTERN = /^\s*(?:\/(?:new|reset|clear)\b|new\s+chat|clear\s+context)/i;

function applyAntiCookingContextGuardian(coherentRest, modelId, baseUrl, parameters) {
  if (!Array.isArray(coherentRest) || coherentRest.length === 0) return coherentRest;

  // 1. Identify user message turn indices
  const userIndices = [];
  for (let i = 0; i < coherentRest.length; i++) {
    if (coherentRest[i] && coherentRest[i].role === "user") {
      userIndices.push(i);
    }
  }

  // Preserve the last 5 user turns in 100% full fidelity
  const RECENT_USER_TURNS = 5;
  const MAX_HISTORICAL_TOOL_CHARS = 1000;
  const cutoffIndex = userIndices.length > RECENT_USER_TURNS
    ? userIndices[userIndices.length - RECENT_USER_TURNS]
    : -1;

  if (cutoffIndex > 0) {
    for (let i = 0; i < cutoffIndex; i++) {
      const msg = coherentRest[i];
      if (msg && msg.role === "tool" && typeof msg.content === "string") {
        if (msg.content.length > MAX_HISTORICAL_TOOL_CHARS) {
          const raw = msg.content;
          const head = raw.slice(0, 350);
          const tail = raw.slice(-200);
          const omittedLen = raw.length - 550;
          const lineCount = (raw.match(/\n/g) || []).length;
          msg.content = `${head}\n[... ${lineCount} lines / ${omittedLen} characters of historical tool output truncated by Anti-Cooking Context Guardian ...]\n${tail}`;
        }
      }
    }
  }

  // 2. Headroom budget check
  const windowLimit = reportedContextWindow(modelId, baseUrl, parameters);
  let totalChars = 0;
  for (const m of coherentRest) {
    if (m && typeof m.content === "string") totalChars += m.content.length;
  }
  const estTokens = Math.ceil(totalChars / 3.5);
  // If prompt exceeds 70% of context capacity, aggressively trim older historical tools
  if (estTokens > windowLimit * 0.70 && cutoffIndex > 0) {
    for (let i = 0; i < cutoffIndex; i++) {
      const msg = coherentRest[i];
      if (msg && msg.role === "tool" && typeof msg.content === "string" && msg.content.length > 250) {
        msg.content = "[Historical tool output truncated: command executed successfully; output omitted to preserve context headroom]";
      }
    }
  }

  return coherentRest;
}

function toOpenAiMessages(messages, baseUrl, modelId, parameters) {
  const prefix = [];
  const rest = [];
  let dropImmediateToolBlock = false;

  // Filter messages based on in-chat reset if present
  let sourceMessages = messages || [];
  let lastResetIdx = -1;
  for (let i = sourceMessages.length - 1; i >= 0; i--) {
    const m = sourceMessages[i];
    if (m && m.role === "user") {
      const text = flattenText(m.content).trim();
      if (RESET_COMMAND_PATTERN.test(text)) {
        lastResetIdx = i;
        break;
      }
    }
  }
  if (lastResetIdx >= 0) {
    sourceMessages = sourceMessages.slice(lastResetIdx);
  }

  for (const msg of sourceMessages) {
    const role = msg && String(msg.role || "").toLowerCase();
    if (dropImmediateToolBlock) {
      if (role === "tool" || role === "tool_result") continue;
      dropImmediateToolBlock = false;
    }
    const converted = convertOneMessage(msg);
    if (converted == null) continue;
    if (converted.__grokHopInvalidToolTurn) {
      if (converted.textMessage) rest.push(converted.textMessage);
      dropImmediateToolBlock = true;
      continue;
    }
    const items = Array.isArray(converted) ? converted : [converted];
    const isPrefix = msg && (msg.role === "system" || msg.role === "developer");
    if (isPrefix) prefix.push(...items);
    else rest.push(...items);
  }
  const coherentRest = [];
  let expectedToolIds = null;
  for (const message of rest) {
    if (message && message.role === "assistant") {
      const ids = Array.isArray(message.tool_calls) ? message.tool_calls.map((tc) => tc && tc.id).filter(Boolean) : [];
      expectedToolIds = ids.length ? new Set(ids) : null;
      coherentRest.push(message);
      continue;
    }
    if (message && message.role === "tool") {
      if (expectedToolIds && message.tool_call_id && expectedToolIds.has(message.tool_call_id)) {
        coherentRest.push(message);
      }
      continue;
    }
    expectedToolIds = null;
    coherentRest.push(message);
  }

  // Apply Anti-Cooking Guardian to coherentRest
  applyAntiCookingContextGuardian(coherentRest, modelId, baseUrl, parameters);

  const joined = prefix.concat(coherentRest);
  const has = joined.some((m) => typeof (m && m.content) === "string" && m.content.includes("[Grok Bot hop]"));
  if (!has) {
    prefix.unshift({ role: "system", content: HOP_ENV_BRIEFING });
  }
  const liveState = qwenLiveStateInstruction(baseUrl);
  if (liveState) {
    // Always append the current route state after any persisted system/developer
    // messages. A conversation may already contain the static hop briefing (or
    // even an older state line); the fresh, generation-verified state must win.
    prefix.push({ role: "system", content: liveState });
  }
  return prefix.concat(coherentRest);
}

function extractCacheUsage(u) {
  if (!u || typeof u !== "object") return { cacheReadTokens: 0, cacheWriteTokens: 0 };
  const details = u.prompt_tokens_details || u.input_tokens_details || {};
  const cacheReadTokens = Number(
    details.cached_tokens ||
      u.prompt_cache_hit_tokens ||
      u.cache_read_input_tokens ||
      details.cache_read_input_tokens ||
      0
  ) || 0;
  const cacheWriteTokens = Number(
    details.cache_creation_input_tokens ||
      u.cache_creation_input_tokens ||
      details.cache_write_tokens ||
      0
  ) || 0;
  return { cacheReadTokens, cacheWriteTokens };
}

function asArgString(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function extractXmlTools(text) {
  const tools = [];
  if (!text || typeof text !== "string") return tools;
  const re = /<tool_call>\s*([\s\S]*?)<\/tool_call>/g;
  let m;
  while ((m = re.exec(text))) {
    const inner = m[1].trim();
    try {
      const obj = JSON.parse(inner);
      if (obj && typeof obj.name === "string" && obj.name) {
        tools.push({
          name: obj.name,
          args: asArgString(obj.arguments != null ? obj.arguments : obj.input != null ? obj.input : {})
        });
        continue;
      }
    } catch {
    }
    const nameMatch = inner.match(/<name>\s*([^<]+)\s*<\/name>/i) || inner.match(/^([A-Za-z0-9_]+)\s/);
    const argMatch = inner.match(/<arguments>\s*([\s\S]*?)<\/arguments>/i);
    if (nameMatch) {
      tools.push({ name: nameMatch[1].trim(), args: argMatch ? argMatch[1].trim() : "{}" });
    }
  }
  const dsmlInvoke = /<\|\s*DSML\s*\|\s*invoke\s+name="([^"]+)"\s*>/gi;
  while ((m = dsmlInvoke.exec(text))) {
    const name = m[1].trim();
    const start = m.index + m[0].length;
    const next = text.indexOf("<|", start);
    const chunk = text.slice(start, next >= 0 ? next : start + 4000);
    const args = {};
    const pre = /<\|\s*DSML\s*\|\s*parameter\s+name="([^"]+)"[^>]*>\s*([\s\S]*?)(?:<\|\s*DSML\s*\|)?/gi;
    let p;
    while ((p = pre.exec(chunk))) {
      args[p[1]] = String(p[2] || "").replace(/<\/?\|?\s*DSML[^>]*>/g, "").trim();
    }
    if (name) tools.push({ name, args: asArgString(args) });
  }
  return tools;
}

class HopPromptBuilder {
  constructor(initialMessages) {
    this.messages = [];
    if (initialMessages) {
      if (Array.isArray(initialMessages)) {
        this.messages = [...initialMessages];
      } else if (initialMessages && Array.isArray(initialMessages.messages)) {
        this.messages = [...initialMessages.messages];
      } else {
        this.messages = [initialMessages];
      }
    }
  }
  appendMessages(newMessages) {
    const add = Array.isArray(newMessages) ? newMessages : [newMessages];
    this.messages.push(...add);
    return this;
  }
  getState() {
    return [...this.messages];
  }
  getMessages() {
    return [...this.messages];
  }
  clearMessages() {
    this.messages = [];
  }
}

function completionsUrl(baseUrl) {
  const root = String(baseUrl || "").replace(/\/$/, "");
  if (root.endsWith("/chat/completions")) return root;
  return root + "/chat/completions";
}

function postJsonStream(urlStr, bodyObj, signal, traceId, requestKind) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    const payload = Buffer.from(JSON.stringify(bodyObj));
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "content-length": payload.length,
          "x-grokbot-trace-id": traceId,
          "x-grokbot-request-kind": requestKind === "summarization" ? "summarization" : "main"
        }
      },
      (res) => {
        req.setTimeout(0);
        resolve(res);
      }
    );
    req.setTimeout(HEADERS_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error("hop headers timeout"), { code: "ETIMEDOUT" }));
    });
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          req.destroy();
        },
        { once: true }
      );
    }
    req.write(payload);
    req.end();
  });
}

async function* iterateSse(res) {
  res.setEncoding("utf8");
  let buf = "";
  let lastByte = Date.now();
  let lastHb = Date.now();
  let pending = null;
  let ended = false;
  let err = null;
  const wake = () => {
    if (pending) {
      const r = pending;
      pending = null;
      r();
    }
  };
  const onData = (chunk) => {
    lastByte = Date.now();
    buf += chunk;
    wake();
  };
  const onEnd = () => {
    ended = true;
    wake();
  };
  const onErr = (e) => {
    err = e;
    ended = true;
    wake();
  };
  res.on("data", onData);
  res.on("end", onEnd);
  res.on("error", onErr);
  const hb = setInterval(() => wake(), 1000);
  try {
    while (!ended || buf.length) {
      let idx = buf.indexOf("\n");
      if (idx < 0) {
        if (ended) break;
        if (Date.now() - lastByte >= SSE_IDLE_MS) {
          throw Object.assign(new Error("hop SSE idle timeout"), { code: "ETIMEDOUT" });
        }
        if (Date.now() - lastHb >= HEARTBEAT_MS) {
          lastHb = Date.now();
          yield { kind: "heartbeat" };
        }
        await new Promise((r) => {
          pending = r;
        });
        continue;
      }
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      // SSE comments are transport keep-alives.  They keep the TCP stream
      // alive, but previously we silently discarded them here, which meant
      // the host never saw a working/heartbeat event during a long provider
      // think.  Surface at most one heartbeat per interval; ordinary data
      // frames still reset the interval below.
      if (line.startsWith(":")) {
        if (Date.now() - lastHb >= HEARTBEAT_MS) {
          lastHb = Date.now();
          yield { kind: "heartbeat" };
        }
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      lastByte = Date.now();
      lastHb = lastByte;
      yield { kind: "data", data };
    }
    if (buf.startsWith("data:")) {
      const data = buf.slice(5).trim();
      if (data) yield { kind: "data", data };
    }
    if (err) throw err;
  } finally {
    clearInterval(hb);
    res.removeListener("data", onData);
    res.removeListener("end", onEnd);
    res.removeListener("error", onErr);
  }
}

function reasoningDeltaOf(delta) {
  if (!delta || typeof delta !== "object") return "";
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length) {
    return delta.reasoning_content;
  }
  if (typeof delta.reasoning === "string" && delta.reasoning.length) {
    return delta.reasoning;
  }
  return "";
}

class HopPromptExecutor {
  constructor(builder, opts) {
    const traceContext = requireTraceContext(opts.provenanceAgentId, opts.baseUrl);
    ensureProvenanceAuditReady();
    this.builder = builder;
    this.baseUrl = opts.baseUrl;
    this.modelId = opts.modelId;
    this.onRequestId = opts.onRequestId;
    this.agentId = opts.agentId;
    this.provenanceAgentId = traceContext.agentId;
    this.hopRouteLabel = traceContext.routeLabel;
    this.requestKind = opts.requestKind === "summarization" ? "summarization" : "main";
    // Test-only escape hatch for deterministic loopback fixtures. Production
    // recovery remains restricted to the exact dedicated Qwen route below.
    this.allowTestVisibleRecovery = opts.allowTestVisibleRecovery === true;
    this.maxMode = opts.maxMode === true;
    this.parameters = Array.isArray(opts.parameters) ? opts.parameters : [];
  }
  appendMessages(messages) {
    this.builder.appendMessages(messages);
    return this;
  }
  getState() {
    return this.builder.getState();
  }
  getMessages() {
    return this.builder.getMessages();
  }
  clearMessages() {
    this.builder.clearMessages();
  }
  stream(ctx, invocationId, tools, options2) {
    const modelId = this.modelId;
    const requestId = crypto.randomUUID();
    try {
      this.onRequestId?.(requestId);
    } catch {
    }
    let resolveUsage, rejectUsage;
    const usagePromise = new Promise((resolve, reject) => {
      resolveUsage = resolve;
      rejectUsage = reject;
    });
    let resolveExtendedUsage, rejectExtendedUsage;
    const extendedUsagePromise = new Promise((resolve, reject) => {
      resolveExtendedUsage = resolve;
      rejectExtendedUsage = reject;
    });
    const providerMetadataPromise = Promise.resolve(undefined);
    const invocationIdPromise = Promise.resolve(invocationId || crypto.randomUUID());
    let resolveResponse, rejectResponse;
    const responsePromise = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });

    const self = this;
    const fullStream = (async function* () {
      const startedAt = Date.now();
      let firstTokenAt = null;
      let telemetryWritten = false;
      let provenanceWritten = false;
      let auditHttpStatus = null;
      let auditUpstreamId = null;
      let auditResponseModel = null;
      let auditUsage = null;
      let auditUsageReason = "stream_usage_not_received";
      const visibleOutputHash = crypto.createHash("sha256");
      let visibleOutputBytes = 0;
      let visibleOutputCharacters = 0;

      const emitTurnTelemetry = (finalUsage, finalCacheUsage) => {
        if (telemetryWritten) return;
        telemetryWritten = true;
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        const ttftMs = firstTokenAt !== null ? Math.max(0, firstTokenAt - startedAt) : elapsedMs;
        const promptTokens = Number(finalUsage?.promptTokens || 0);
        const completionTokens = Number(finalUsage?.completionTokens || 0);
        const totalTokens = Number(finalUsage?.totalTokens || (promptTokens + completionTokens) || 0);
        const tokensPerSec = elapsedMs > 0 ? Number(((completionTokens / (elapsedMs / 1000))).toFixed(2)) : 0;
        const cacheRead = Number(finalCacheUsage?.cacheReadTokens || 0);
        let cacheHitPct = 0;
        if (cacheRead > 0) {
          const cacheBase = promptTokens >= cacheRead && promptTokens > 0 ? promptTokens : (promptTokens + cacheRead);
          cacheHitPct = cacheBase > 0 ? Number(((cacheRead / cacheBase) * 100).toFixed(2)) : 0;
        }
        cacheHitPct = Math.min(100, Math.max(0, cacheHitPct));
        const limit = reportedContextWindow(self.modelId || modelId, self.baseUrl, self.parameters);
        const contextUtilizationPct = limit > 0 ? Number(((totalTokens / limit) * 100).toFixed(2)) : 0;

        let hopRoute = "127.0.0.1:18786";
        if (self.baseUrl) {
          try {
            const parsed = new URL(self.baseUrl);
            hopRoute = parsed.host || self.baseUrl;
          } catch {
            hopRoute = String(self.baseUrl).replace(/^https?:\/\//, "").replace(/\/.*$/, "") || "127.0.0.1:18786";
          }
        }

        const record = {
          timestamp: new Date().toISOString(),
          agentId: String(self.provenanceAgentId || self.agentId || "root-assistant"),
          modelId: String(self.modelId || modelId || "unknown"),
          hopRoute,
          ttftMs,
          elapsedMs,
          tokensPerSec,
          promptTokens,
          completionTokens,
          totalTokens,
          cacheHitPct,
          contextUtilizationPct
        };
        recordLiveMetrics(record);
      };

      const writeTerminalProvenance = ({ outcome, finishReason, outputComplete }) => {
        if (provenanceWritten) return;
        provenanceWritten = true;
        const safeFinishReason = safeMetadataToken(finishReason);
        const visibleOutputSha256 = visibleOutputHash.digest("hex");
        const nullReasons = {};
        if (auditUpstreamId == null) nullReasons.upstreamId = "not_received_or_unsafe";
        if (auditResponseModel == null) nullReasons.responseModel = "not_received_or_unsafe";
        if (auditHttpStatus == null) nullReasons.httpStatus = "no_http_response";
        if (auditUsage == null) {
          nullReasons.promptTokens = auditUsageReason;
          nullReasons.completionTokens = auditUsageReason;
        }
        if (safeFinishReason == null) nullReasons.finishReason = "not_received_or_unsafe";
        appendProvenanceRecord({
          schema: PROVENANCE_SCHEMA,
          event: "local-bound-terminal",
          timestamp: new Date().toISOString(),
          traceId: requestId,
          agentId: self.provenanceAgentId,
          modelId,
          hopBaseUrlHostOrRouteLabel: self.hopRouteLabel,
          requestKind: self.requestKind,
          upstreamId: auditUpstreamId,
          responseModel: auditResponseModel,
          httpStatus: auditHttpStatus,
          promptTokens: auditUsage ? auditUsage.promptTokens : null,
          completionTokens: auditUsage ? auditUsage.completionTokens : null,
          finishReason: safeFinishReason,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          visibleOutputSha256,
          visibleOutputBytes,
          visibleOutputCharacters,
          outputComplete: Boolean(outputComplete),
          outcome,
          nullReasons
        });
      };
      try {
      let usageSettled = false;
      let extSettled = false;
      let respSettled = false;
      const fail = (error) => {
        if (!usageSettled) {
          usageSettled = true;
          rejectUsage(error);
        }
        if (!extSettled) {
          extSettled = true;
          rejectExtendedUsage(error);
        }
        if (!respSettled) {
          respSettled = true;
          rejectResponse(error);
        }
      };
      const okUsage = (usage, cacheUsage) => {
        if (!usageSettled) {
          usageSettled = true;
          resolveUsage({
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens
          });
        }
        if (!extSettled) {
          extSettled = true;
          resolveExtendedUsage({
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens,
            cacheReadTokens: cacheUsage.cacheReadTokens,
            cacheWriteTokens: cacheUsage.cacheWriteTokens,
            // The host persists this value as the model's context contract and
            // uses it to enable its compaction machinery. Reporting zero made
            // long local conversations replay almost the entire transcript.
            // Keep every other custom/provider route unchanged because their
            // verified context window can differ.
            maxTokens: reportedContextWindow(modelId, self.baseUrl, self.parameters)
          });
        }
      };
      const okResp = (contentParts, textOut) => {
        if (respSettled) return;
        respSettled = true;
        resolveResponse({
          id: requestId,
          timestamp: new Date(),
          modelId,
          messages: [
            {
              role: "assistant",
              content: contentParts.length ? contentParts : (textOut || ""),
              id: requestId
            }
          ]
        });
      };

      // First-class transport heartbeat: host maps this to Updates.heartbeat()
      // without storing an empty reasoning block in conversation history.
      yield { type: "heartbeat" };

      // In-chat reset command interception (/new, /reset, /clear)
      const rawMessages = self.builder.getMessages();
      let lastUserMsg = null;
      for (let i = rawMessages.length - 1; i >= 0; i--) {
        if (rawMessages[i] && (rawMessages[i].role === "user" || rawMessages[i].role === "human")) {
          lastUserMsg = rawMessages[i];
          break;
        }
      }
      const promptText = flattenText(lastUserMsg?.content).trim();
      if (/^\s*\/(?:new|reset|clear)(?:\s+.*)?$/i.test(promptText)) {
        self.builder.clearMessages();
        const confirmMsg = "✨ Conversation reset. History cleared; agent identity, system instructions, memory, and model bindings preserved.";
        if (firstTokenAt === null) firstTokenAt = Date.now();
        yield { type: "text-delta", textDelta: confirmMsg, text: confirmMsg };
        yield {
          type: "finish",
          finishReason: "stop",
          finish_reason: "stop",
          usage: { promptTokens: 0, completionTokens: 20, totalTokens: 20 },
          logprobs: undefined,
          response: { id: requestId, timestamp: new Date(), modelId }
        };
        okResp([], confirmMsg);
        okUsage({ promptTokens: 0, completionTokens: 20, totalTokens: 20 }, { cacheReadTokens: 0, cacheWriteTokens: 0 });
        emitTurnTelemetry({ promptTokens: 0, completionTokens: 20, totalTokens: 20 }, { cacheReadTokens: 0, cacheWriteTokens: 0 });
        writeTerminalProvenance({
          outcome: "success",
          finishReason: "stop",
          outputComplete: true
        });
        return;
      }

      const openaiMessages = toOpenAiMessages(self.builder.getMessages(), self.baseUrl, self.modelId, self.parameters);
      const localQwen = isLocalQwenRoute(modelId, self.baseUrl) || self.allowTestVisibleRecovery;
      const openaiTools = localQwen && self.requestKind === "summarization" ? undefined : toOpenAiTools(tools);
      const body = {
        model: modelId,
        messages: openaiMessages,
        stream: true,
        stream_options: { include_usage: true }
      };
      if (self.agentId) body.prompt_cache_key = "grok-hop:" + self.agentId;
      if (openaiTools) {
        body.tools = openaiTools;
        body.tool_choice = "auto";
      }
      const requestedMaxTokens = options2 && typeof options2.maxTokens === "number"
        ? options2.maxTokens : undefined;
      if (localQwen && self.requestKind === "summarization") {
        // Keep local maintenance summaries bounded; an unbounded summary can
        // monopolize the single Qwen slot and starve the foreground turn.
        body.max_tokens = Math.min(2048, Math.max(1, Number.isFinite(requestedMaxTokens) ? requestedMaxTokens : 2048));
        body.chat_template_kwargs = { enable_thinking: false };
        body.reasoning_effort = "low";
      } else if (localQwen) {
        // Preserve an explicit host budget for substantive/tool turns. When
        // the host omits one, use a safer default than the relay's old 1,024.
        body.max_tokens = Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
          ? requestedMaxTokens
          : 2048;
      } else if (typeof requestedMaxTokens === "number") {
        body.max_tokens = requestedMaxTokens;
      }
      if (!localQwen) {
        applyProviderReasoningControls(body, { modelId: modelId, baseUrl: self.baseUrl, maxMode: self.maxMode, parameters: self.parameters });
      }
      const url = completionsUrl(self.baseUrl);
      let res;
      let lastHopErr = null;
      for (let attempt = 1; attempt <= MAX_HOP_RETRIES; attempt++) {
        if (attempt > 1) {
          yield { type: "heartbeat" };
          await sleep(400 * attempt);
        }
        try {
          const headerRequest = postJsonStream(url, body, ctx && ctx.signal, requestId, self.requestKind);
          // postJsonStream resolves only when upstream headers arrive. Race it
          // against a short timer so a queued local request remains visibly
          // active. The request itself still owns the 120s hard timeout and
          // preserves real HTTP/network errors for the existing handler.
          while (true) {
            let heartbeatTimer = null;
            const heartbeatPromise = new Promise((resolve) => {
              heartbeatTimer = setTimeout(() => resolve({ heartbeat: true }), HEARTBEAT_MS);
            });
            let headerEvent;
            try {
              headerEvent = await Promise.race([
                headerRequest.then((response) => ({ response })),
                heartbeatPromise
              ]);
            } finally {
              if (heartbeatTimer != null) clearTimeout(heartbeatTimer);
            }
            if (headerEvent.heartbeat) {
              yield { type: "heartbeat" };
              continue;
            }
            res = headerEvent.response;
            break;
          }
        } catch (err) {
          lastHopErr = err instanceof Error ? err : new Error(String(err));
          const code = lastHopErr.code || "";
          if (attempt < MAX_HOP_RETRIES && (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED")) {
            continue;
          }
          writeTerminalProvenance({
            outcome: "error",
            finishReason: "error",
            outputComplete: false
          });
          yield { type: "error", error: lastHopErr };
          fail(lastHopErr);
          yield {
            type: "finish",
            finishReason: "error",
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            logprobs: undefined,
            response: { id: requestId, timestamp: new Date(), modelId }
          };
          return;
        }
        const status = res.statusCode || 500;
        auditHttpStatus = status;
        if (status < 400) {
          lastHopErr = null;
          break;
        }
        let errText = "";
        try {
          for await (const c of res) errText += c;
        } catch {
        }
        lastHopErr = new Error("hop HTTP " + status + (errText ? " " + errText.slice(0, 300) : ""));
        res = null;
        if (RETRYABLE.has(status) && attempt < MAX_HOP_RETRIES) {
          yield { type: "heartbeat" };
          continue;
        }
        writeTerminalProvenance({
          outcome: "error",
          finishReason: "error",
          outputComplete: false
        });
        yield { type: "error", error: lastHopErr };
        fail(lastHopErr);
        yield {
          type: "finish",
          finishReason: "error",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          logprobs: undefined,
          response: { id: requestId, timestamp: new Date(), modelId }
        };
        return;
      }
      if (!res) {
        const error = lastHopErr || new Error("hop failed");
        writeTerminalProvenance({
          outcome: "error",
          finishReason: "error",
          outputComplete: false
        });
        yield { type: "error", error };
        fail(error);
        yield {
          type: "finish",
          finishReason: "error",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          logprobs: undefined,
          response: { id: requestId, timestamp: new Date(), modelId }
        };
        return;
      }

      const toolAcc = new Map();
      let textOut = "";
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let cacheUsage = { cacheReadTokens: 0, cacheWriteTokens: 0 };
      let finishReason = "stop";
      let finished = false;
      let sawReasoning = false;
      const contentParts = [];

      const ensureTool = (index, delta) => {
        let rec = toolAcc.get(index);
        if (!rec) {
          rec = { id: "", name: "", args: "", started: false, streamingEmitted: false };
          toolAcc.set(index, rec);
        }
        if (delta && delta.id) rec.id = delta.id;
        if (delta && delta.function && delta.function.name) rec.name = delta.function.name;
        if (!rec.id) rec.id = "call_" + index + "_" + crypto.randomUUID().slice(0, 8);
        return rec;
      };

      const ingestToolCalls = function* (list, replaceArguments = false, emitStreaming = true) {
        if (!Array.isArray(list)) return;
        for (const tc of list) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          const rec = ensureTool(index, tc);
          if (!rec.started) {
            rec.started = true;
            if (emitStreaming) {
              rec.streamingEmitted = true;
              yield {
                type: "tool-call-streaming-start",
                toolCallId: rec.id,
                toolName: rec.name || "unknown"
              };
            }
          } else if (tc.function && tc.function.name && rec.name === "unknown") {
            rec.name = tc.function.name;
          }
          const rawArgs = tc.function ? tc.function.arguments : undefined;
          const argDelta = asArgString(rawArgs);
          if (argDelta && (typeof rawArgs === "string" ? argDelta : true)) {
            if (typeof rawArgs === "string") rec.args = replaceArguments ? rawArgs : rec.args + rawArgs;
            else rec.args = argDelta;
            if (emitStreaming) {
              rec.streamingEmitted = true;
              yield {
                type: "tool-call-delta",
                toolCallId: rec.id,
                toolName: rec.name || "unknown",
                argsTextDelta: typeof rawArgs === "string" ? rawArgs : argDelta
              };
            }
          }
        }
      };

      try {
        for await (const ev of iterateSse(res)) {
          if (ev.kind === "heartbeat") {
            yield { type: "heartbeat" };
            continue;
          }
          const data = ev.data;
          if (data === "[DONE]") break;
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (auditUpstreamId == null && parsed && parsed.id != null) {
            auditUpstreamId = safeMetadataToken(parsed.id);
          }
          if (auditResponseModel == null && parsed && parsed.model != null) {
            auditResponseModel = safeMetadataToken(parsed.model);
          }
          if (parsed && parsed.error) {
            const msg =
              (parsed.error && parsed.error.message) ||
              (typeof parsed.error === "string" ? parsed.error : "hop stream error");
            const error = new Error(String(msg).slice(0, 300));
            writeTerminalProvenance({
              outcome: "error",
              finishReason: "error",
              outputComplete: false
            });
            yield { type: "error", error };
            fail(error);
            finished = true;
            yield {
              type: "finish",
              finishReason: "error",
              usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens },
              logprobs: undefined,
              response: { id: requestId, timestamp: new Date(), modelId }
            };
            return;
          }
                if (parsed.usage) {
            const u = parsed.usage;
            usage = {
              promptTokens: u.prompt_tokens || 0,
              completionTokens: u.completion_tokens || 0,
              totalTokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0)
            };
            cacheUsage = extractCacheUsage(u);
            const promptTokens = exactTokenCount(u.prompt_tokens);
            const completionTokens = exactTokenCount(u.completion_tokens);
            if (promptTokens != null && completionTokens != null) {
              auditUsage = { promptTokens, completionTokens };
              auditUsageReason = null;
            } else {
              auditUsage = null;
              auditUsageReason = "stream_usage_invalid";
            }
          }
          const choice = parsed.choices && parsed.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta || {};
          let toolCallsAreFullMessage = false;
          if ((!delta.tool_calls || !delta.tool_calls.length) && choice.message && Array.isArray(choice.message.tool_calls)) {
            delta.tool_calls = choice.message.tool_calls;
            toolCallsAreFullMessage = true;
          }
          const reasoning = reasoningDeltaOf(delta);
          if (reasoning) {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            sawReasoning = true;
            yield { type: "reasoning", textDelta: reasoning };
          }
          if (typeof delta.content === "string" && delta.content.length && delta.content !== reasoning) {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            textOut += delta.content;
            if (looksLikeToolMarkup(textOut) || looksLikeToolMarkup(delta.content)) {
              yield { type: "reasoning", textDelta: ZWSP };
            } else {
              visibleOutputHash.update(delta.content, "utf8");
              visibleOutputBytes += Buffer.byteLength(delta.content, "utf8");
              visibleOutputCharacters += [...delta.content].length;
              yield { type: "text-delta", textDelta: delta.content };
            }
          }
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            // Buffer local-Qwen tool calls until their complete JSON arguments
            // validate. This prevents a length-truncated partial call from
            // escaping into the host stream before the bounded repair below.
            yield* ingestToolCalls(delta.tool_calls, toolCallsAreFullMessage, !localQwen);
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        writeTerminalProvenance({
          outcome: "error",
          finishReason: "error",
          outputComplete: false
        });
        yield { type: "error", error };
        fail(error);
        if (!finished) {
          finished = true;
          yield {
            type: "finish",
            finishReason: "error",
            usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens },
            logprobs: undefined,
            response: { id: requestId, timestamp: new Date(), modelId }
          };
        }
        return;
      }

      if (localQwen && self.requestKind === "main" && !toolAcc.size) {
        // GROKBOT_LOCAL_QWEN_TERMINAL_V6_3A7E91C:hop-recovery
        // Grok Bot's user-visible completion contract is a real SendMessage;
        // plain assistant prose and reasoning are not visible in this surface.
        // Recover exactly once on the dedicated local route. The first stream
        // emitted no tool call, and recovery exposes only SendMessage, so no
        // external tool side effect can be duplicated. Never do this on a
        // shared or paid route.
        const canRecoverVisibleOnly = self.allowTestVisibleRecovery || localQwen;
        let recoveryError = null;
        let recoveredText = "";
        if (canRecoverVisibleOnly) {
          const recoveryBody = Object.assign({}, body);
          // The host's visible completion contract is SendMessage. A local
          // turn that produced prose/reasoning but no tool call is incomplete;
          // ask once for that tool only, without exposing the full tool catalog.
          const sendMessageTools = Array.isArray(openaiTools)
            ? openaiTools.filter((t) => t && t.function && t.function.name === "SendMessage")
            : [];
          if (!sendMessageTools.length) {
            recoveryError = new Error("local completion had no SendMessage tool available for recovery");
          } else {
            recoveryBody.tools = sendMessageTools;
            recoveryBody.tool_choice = {
              type: "function",
              function: { name: "SendMessage" }
            };
            recoveryBody.messages = Array.isArray(body.messages)
              ? body.messages.concat([{
                  role: "user",
                  content: "<system_reminder>Deliver the complete requested result or blocker now with exactly one SendMessage call using terminal:true. Do not send a progress update, omit terminal, repeat an earlier recap, or call another tool.</system_reminder>"
                }])
              : body.messages;
          }
          recoveryBody.chat_template_kwargs = Object.assign({}, body.chat_template_kwargs || {}, { enable_thinking: false });
          recoveryBody.reasoning_effort = "low";
          recoveryBody.max_tokens = 4096;
          yield { type: "heartbeat" };
          try {
            if (recoveryError) throw recoveryError;
            const recoveryRes = await postJsonStream(url, recoveryBody, ctx && ctx.signal, requestId, self.requestKind);
            auditHttpStatus = recoveryRes.statusCode || 500;
            if (auditHttpStatus >= 400) {
              let errText = "";
              try {
                for await (const c of recoveryRes) {
                  if (errText.length < 300) errText += String(c).slice(0, 300 - errText.length);
                }
              } catch {}
              recoveryError = new Error("local visible-output recovery HTTP " + auditHttpStatus + (errText ? " " + errText : ""));
            } else {
              for await (const ev of iterateSse(recoveryRes)) {
                if (ev.kind === "heartbeat") {
                  yield { type: "heartbeat" };
                  continue;
                }
                if (ev.data === "[DONE]") break;
                let parsed;
                try { parsed = JSON.parse(ev.data); } catch { continue; }
                if (auditUpstreamId == null && parsed && parsed.id != null) auditUpstreamId = safeMetadataToken(parsed.id);
                if (auditResponseModel == null && parsed && parsed.model != null) auditResponseModel = safeMetadataToken(parsed.model);
                if (parsed && parsed.usage) {
                  const u = parsed.usage;
                  usage = {
                    promptTokens: u.prompt_tokens || 0,
                    completionTokens: u.completion_tokens || 0,
                    totalTokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0)
                  };
                  cacheUsage = extractCacheUsage(u);
                  const promptTokens = exactTokenCount(u.prompt_tokens);
                  const completionTokens = exactTokenCount(u.completion_tokens);
                  if (promptTokens != null && completionTokens != null) {
                    auditUsage = { promptTokens, completionTokens };
                    auditUsageReason = null;
                  }
                }
                if (parsed && parsed.error) {
                  recoveryError = new Error(String(parsed.error.message || parsed.error).slice(0, 300));
                  break;
                }
                const choice = parsed && parsed.choices && parsed.choices[0];
                if (!choice) continue;
                if (choice.finish_reason) finishReason = choice.finish_reason;
                const delta = choice.delta || {};
                let toolCallsAreFullMessage = false;
                if ((!delta.tool_calls || !delta.tool_calls.length) && choice.message && Array.isArray(choice.message.tool_calls)) {
                  delta.tool_calls = choice.message.tool_calls;
                  toolCallsAreFullMessage = true;
                }
                if (Array.isArray(delta.tool_calls)) {
                  yield* ingestToolCalls(delta.tool_calls, toolCallsAreFullMessage, !localQwen);
                }
                if (typeof delta.content === "string" && delta.content.length) {
                  if (!looksLikeToolMarkup(delta.content) && !looksLikeToolMarkup(recoveredText + delta.content)) {
                    recoveredText += delta.content;
                    textOut += delta.content;
                    visibleOutputHash.update(delta.content, "utf8");
                    visibleOutputBytes += Buffer.byteLength(delta.content, "utf8");
                    visibleOutputCharacters += [...delta.content].length;
                    yield { type: "text-delta", textDelta: delta.content };
                  }
                }
              }
            }
          } catch (err) {
            recoveryError = err instanceof Error ? err : new Error(String(err));
          }
        }

        if (!recoveredText.trim() && !toolAcc.size) {
          // A thinking-only 200 is not a usable assistant turn. Keep the
          // terminal failure explicit rather than recording a blank reply.
          const error = recoveryError || new Error(
            canRecoverVisibleOnly
              ? "local provider completed without visible assistant content after thinking-disabled recovery"
              : sawReasoning
                ? "provider completed with reasoning only and no visible answer"
                : "provider completed without visible assistant content"
          );
          error.code = "EMPTY_VISIBLE_OUTPUT";
          writeTerminalProvenance({
            outcome: "error",
            finishReason: "empty-visible-output",
            outputComplete: false
          });
          yield { type: "error", error };
          fail(error);
          if (!finished) {
            finished = true;
            yield {
              type: "finish",
              finishReason: "error",
              usage: {
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens
              },
              logprobs: undefined,
              response: { id: requestId, timestamp: new Date(), modelId }
            };
          }
          return;
        }
      }

      if (!toolAcc.size && textOut) {
        const xmlTools = extractXmlTools(textOut);
        if (xmlTools.length) {
          for (let i = 0; i < xmlTools.length; i++) {
            const t = xmlTools[i];
            const rec = ensureTool(i, { id: "call_xml_" + i, function: { name: t.name, arguments: t.args } });
            rec.args = t.args;
            rec.name = t.name;
            rec.started = true;
            rec.streamingEmitted = true;
            yield {
              type: "tool-call-streaming-start",
              toolCallId: rec.id,
              toolName: rec.name || "unknown"
            };
          }
          textOut = stripToolMarkup(textOut);
          finishReason = "tool_calls";
        }
      } else if (textOut && looksLikeToolMarkup(textOut)) {
        textOut = stripToolMarkup(textOut);
      }
      const upstreamFinishReason = finishReason;
      let ordered = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]);
      let invalidTool = ordered.find(([, rec]) => {
        return !rec || !rec.id || !rec.name || rec.name === "unknown" || canonicalToolArguments(rec.args) == null;
      });
      const requestedToolBudget = Number(body.max_tokens);
      const endedAtToolBudget = upstreamFinishReason === "length" ||
        (Number.isFinite(requestedToolBudget) && requestedToolBudget > 0 && usage.completionTokens >= requestedToolBudget);
      let incompleteToolRecoveryAttempted = false;
      if (invalidTool && endedAtToolBudget && self.requestKind === "main" && ordered.length === 1) {
        // A length-truncated tool call has not executed: the host only receives
        // a final tool-call event after complete JSON validation. Repair it
        // exactly once with thinking disabled and only the intended tool
        // exposed. This is safer and much cheaper than re-running the entire
        // 70K+ prompt through the host's generic failed-turn redrive.
        const brokenTool = invalidTool[1];
        const repairTools = Array.isArray(openaiTools)
          ? openaiTools.filter((t) => t && t.function && t.function.name === brokenTool.name)
          : [];
        if (brokenTool.name && brokenTool.name !== "unknown" && repairTools.length === 1) {
          incompleteToolRecoveryAttempted = true;
          const repairBody = Object.assign({}, body);
          repairBody.tools = repairTools;
          repairBody.tool_choice = {
            type: "function",
            function: { name: brokenTool.name }
          };
          repairBody.messages = Array.isArray(body.messages)
            ? body.messages.concat([{
                role: "user",
                content: "<system_reminder>Your previous tool call reached the output limit before its JSON arguments were complete. Reissue exactly one complete " + brokenTool.name + " call now. Use compact valid JSON, do not reason, do not describe the call, and do not invoke any other tool.</system_reminder>"
              }])
            : body.messages;
          repairBody.chat_template_kwargs = Object.assign({}, body.chat_template_kwargs || {}, { enable_thinking: false });
          repairBody.reasoning_effort = "low";
          repairBody.max_tokens = 4096;
          const repairAcc = new Map();
          let repairError = null;
          let repairFinishReason = "stop";
          const ingestRepairCalls = (list, replaceArguments = false) => {
            if (!Array.isArray(list)) return;
            for (const tc of list) {
              const index = typeof tc.index === "number" ? tc.index : 0;
              let rec = repairAcc.get(index);
              if (!rec) {
                rec = { id: "", name: "", args: "", started: false, streamingEmitted: false };
                repairAcc.set(index, rec);
              }
              if (tc && tc.id) rec.id = tc.id;
              if (tc && tc.function && tc.function.name) rec.name = tc.function.name;
              if (!rec.id) rec.id = "call_repair_" + index + "_" + crypto.randomUUID().slice(0, 8);
              const rawArgs = tc && tc.function ? tc.function.arguments : undefined;
              const argText = asArgString(rawArgs);
              if (argText) {
                rec.args = typeof rawArgs === "string"
                  ? (replaceArguments ? rawArgs : rec.args + rawArgs)
                  : argText;
              }
            }
          };
          yield { type: "heartbeat" };
          try {
            const repairRes = await postJsonStream(url, repairBody, ctx && ctx.signal, requestId, self.requestKind);
            auditHttpStatus = repairRes.statusCode || 500;
            if (auditHttpStatus >= 400) {
              let errText = "";
              try {
                for await (const c of repairRes) {
                  if (errText.length < 300) errText += String(c).slice(0, 300 - errText.length);
                }
              } catch {}
              repairError = new Error("local incomplete-tool recovery HTTP " + auditHttpStatus + (errText ? " " + errText : ""));
            } else {
              for await (const ev of iterateSse(repairRes)) {
                if (ev.kind === "heartbeat") {
                  yield { type: "heartbeat" };
                  continue;
                }
                if (ev.data === "[DONE]") break;
                let parsed;
                try { parsed = JSON.parse(ev.data); } catch { continue; }
                if (parsed && parsed.id != null) auditUpstreamId = safeMetadataToken(parsed.id);
                if (parsed && parsed.model != null) auditResponseModel = safeMetadataToken(parsed.model);
                if (parsed && parsed.usage) {
                  const u = parsed.usage;
                  usage = {
                    promptTokens: u.prompt_tokens || 0,
                    completionTokens: u.completion_tokens || 0,
                    totalTokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0)
                  };
                  cacheUsage = extractCacheUsage(u);
                  const promptTokens = exactTokenCount(u.prompt_tokens);
                  const completionTokens = exactTokenCount(u.completion_tokens);
                  if (promptTokens != null && completionTokens != null) {
                    auditUsage = { promptTokens, completionTokens };
                    auditUsageReason = null;
                  }
                }
                if (parsed && parsed.error) {
                  repairError = new Error(String(parsed.error.message || parsed.error).slice(0, 300));
                  break;
                }
                const choice = parsed && parsed.choices && parsed.choices[0];
                if (!choice) continue;
                if (choice.finish_reason) repairFinishReason = choice.finish_reason;
                const delta = choice.delta || {};
                let callsAreFullMessage = false;
                if ((!delta.tool_calls || !delta.tool_calls.length) && choice.message && Array.isArray(choice.message.tool_calls)) {
                  delta.tool_calls = choice.message.tool_calls;
                  callsAreFullMessage = true;
                }
                ingestRepairCalls(delta.tool_calls, callsAreFullMessage);
              }
            }
          } catch (err) {
            repairError = err instanceof Error ? err : new Error(String(err));
          }
          const repaired = [...repairAcc.entries()].sort((a, b) => a[0] - b[0]);
          const repairedRec = repaired.length === 1 ? repaired[0][1] : null;
          const repairedArgs = repairedRec == null ? null : canonicalToolArguments(repairedRec.args);
          if (!repairError && repairFinishReason !== "length" && repairedRec && repairedRec.name === brokenTool.name && repairedArgs != null) {
            toolAcc.clear();
            repairedRec.args = repairedArgs;
            repairedRec.started = true;
            repairedRec.streamingEmitted = false;
            toolAcc.set(repaired[0][0], repairedRec);
            ordered = [...toolAcc.entries()];
            invalidTool = undefined;
            finishReason = "tool_calls";
          }
        }
      }
      if (toolAcc.size && !invalidTool) finishReason = "tool_calls";

      if (textOut) contentParts.push({ type: "text", text: textOut });
      if (invalidTool) {
        const error = new Error(
          "local model ended with incomplete tool-call arguments" +
          (upstreamFinishReason === "length" ? " at the output-token limit" : "") +
          (incompleteToolRecoveryAttempted
            ? "; bounded tool-only recovery did not produce complete JSON, so the turn was not persisted"
            : "; the failure was not safely recoverable, so the turn was not persisted")
        );
        writeTerminalProvenance({
          outcome: "error",
          finishReason: "invalid-tool-call",
          outputComplete: false
        });
        yield { type: "error", error };
        fail(error);
        if (!finished) {
          finished = true;
          yield {
            type: "finish",
            finishReason: "error",
            usage: {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens
            },
            logprobs: undefined,
            response: { id: requestId, timestamp: new Date(), modelId }
          };
        }
        return;
      }
      for (const [, rec] of ordered) {
        const canonicalArgs = canonicalToolArguments(rec.args);
        const argsObj = JSON.parse(canonicalArgs);
        if (!rec.streamingEmitted) {
          rec.streamingEmitted = true;
          yield {
            type: "tool-call-streaming-start",
            toolCallId: rec.id,
            toolName: rec.name || "unknown"
          };
          yield {
            type: "tool-call-delta",
            toolCallId: rec.id,
            toolName: rec.name || "unknown",
            argsTextDelta: canonicalArgs
          };
        }
        yield {
          type: "tool-call",
          toolCallId: rec.id,
          toolName: rec.name || "unknown",
          args: argsObj
        };
        contentParts.push({
          type: "tool-call",
          toolCallId: rec.id,
          toolName: rec.name || "unknown",
          args: argsObj
        });
      }

      if (!finished) {
        finished = true;
        const mappedFinish = toolAcc.size || finishReason === "tool_calls" ? "tool-calls" : finishReason || "stop";
        writeTerminalProvenance({
          outcome: "success",
          finishReason: mappedFinish,
          outputComplete: true
        });
        yield {
          type: "finish",
          finishReason: mappedFinish,
          usage: {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens
          },
          logprobs: undefined,
          response: {
            id: requestId,
            timestamp: new Date(),
            modelId
          }
        };
      }

      emitTurnTelemetry(usage, cacheUsage);
      okUsage(usage, cacheUsage);
      okResp(contentParts, textOut);
      } finally {
        writeTerminalProvenance({
          outcome: "cancelled",
          finishReason: null,
          outputComplete: false
        });
      }
    })();

    return {
      fullStream,
      response: responsePromise,
      usage: usagePromise,
      extendedUsage: extendedUsagePromise,
      providerMetadata: providerMetadataPromise,
      invocationId: invocationIdPromise
    };
  }
}

function createOpenAiHopSession(opts) {
  const baseUrl = opts && opts.baseUrl;
  const modelId = (opts && opts.modelId) || "unknown";
  const onRequestId = opts && opts.onRequestId;
  const agentId = opts && opts.agentId;
  const provenanceAgentId = opts && opts.provenanceAgentId;
  const requestKind = opts && opts.requestKind;
  const maxMode = (opts && opts.maxMode) === true;
  const parameters = Array.isArray(opts && opts.parameters) ? opts.parameters : [];
  return {
    getModelId: () => modelId,
    getExecutor(state) {
      const builder = new HopPromptBuilder(state);
      return new HopPromptExecutor(builder, {
        baseUrl,
        modelId,
        onRequestId,
        agentId,
        provenanceAgentId,
      requestKind,
      maxMode,
      parameters,
      allowTestVisibleRecovery: opts && opts.allowTestVisibleRecovery === true
    });
    }
  };
}

module.exports = {
  createOpenAiHopSession,
  repairTruncatedJson,
  repairTruncatedJsonArguments,
  canonicalToolArguments,
  ToolArgumentRepairEngine,
  __test: {
    canonicalToolArguments,
    repairTruncatedJson,
    repairTruncatedJsonArguments,
    ToolArgumentRepairEngine,
    convertOneMessage,
    toOpenAiMessages,
    applyAntiCookingContextGuardian,
    iterateSse,
    reportedContextWindow,
    recordLiveMetrics,
    LIVE_METRICS_PATHS
  }
};
