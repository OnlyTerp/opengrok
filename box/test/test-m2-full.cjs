"use strict";
/**
 * Comprehensive M2 Verification Test Suite
 * Tests:
 * 1. Subagent routing inheritance simulation
 * 2. Dynamic context window capacity contract (never returns 0)
 * 3. Multi-provider reasoning transformation (Grok, Claude, DeepSeek, GLM/Friendli, Gemini)
 * 4. Streaming tool delta recovery & JSON auto-repair for truncated arguments
 * 5. Context transformation logic (preservation of history and system prompts)
 */

const assert = require("assert");
const providerMaps = require("../../tools/provider-maps.cjs");
const applyControls = providerMaps.applyProviderReasoningControls;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("PASS: " + name);
  } catch (err) {
    failed++;
    console.error("FAIL: " + name + " -> " + (err && err.message ? err.message : String(err)));
  }
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || "") + ` expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }
}

function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error((msg || "") + `\n  expected: ${e}\n  actual:   ${a}`);
  }
}

console.log("=== M2 Comprehensive Verification Test Suite ===\n");

// =========================================================================
// 1. Subagent Routing Inheritance Simulation
// =========================================================================
console.log("--- 1. Subagent Routing Inheritance ---");

function simulateResolveBinding(binds, host) {
  let resolvedTopLevelModelId = host.subagentModelId;
  let resolvedOpenaiBaseUrl = void 0;
  let resolvedHopMaxMode = void 0;
  let resolvedHopParameters = void 0;

  const __agentId = (host.isSubagentRunner && host.subagentTranscriptId)
    ? host.subagentTranscriptId
    : host.getConversationId();

  const __agents = binds != null && typeof binds === "object" && binds.agents != null
    ? binds.agents
    : binds;

  let __entry = __agents?.[__agentId];
  if (!__entry && host.isSubagentRunner) {
    const __parentAgentId = host.getConversationId();
    __entry = __agents?.[__parentAgentId];
  }

  if (__entry && typeof __entry === "object") {
    if (__entry.modelId) resolvedTopLevelModelId = __entry.modelId;
    if (typeof __entry.maxMode === "boolean") resolvedHopMaxMode = __entry.maxMode;
    if (Array.isArray(__entry.parameters)) {
      resolvedHopParameters = __entry.parameters
        .filter((p) => p && typeof p.id === "string")
        .map((p) => ({ id: p.id, value: p.value == null ? "" : String(p.value) }));
    }
    if (typeof __entry.hopBaseUrl === "string" && __entry.hopBaseUrl.length > 0) {
      const __hopUrl = new URL(__entry.hopBaseUrl);
      if (__hopUrl.protocol === "http:" && __hopUrl.hostname === "127.0.0.1") {
        resolvedOpenaiBaseUrl = `${__hopUrl.protocol}//${__hopUrl.host}/v1`;
      }
    }
  }

  return {
    modelId: resolvedTopLevelModelId,
    openaiBaseUrl: resolvedOpenaiBaseUrl,
    maxMode: resolvedHopMaxMode,
    parameters: resolvedHopParameters
  };
}

const mockBindings = {
  agents: {
    "parent-uuid-001": {
      name: "Grok Super Parent",
      modelId: "grok-4.6-superheavy",
      provider: "grok",
      hopBaseUrl: "http://127.0.0.1:18779/v1",
      maxMode: true,
      parameters: [{ id: "effort", value: "xhigh" }]
    },
    "subagent-override-uuid-002": {
      name: "Specialized Subagent",
      modelId: "zai-org/GLM-5.3-Flash",
      provider: "friendli",
      hopBaseUrl: "http://127.0.0.1:18791/v1",
      parameters: [{ id: "fast", value: "true" }]
    }
  }
};

test("subagent inherits parent binding when no explicit binding exists", () => {
  const host = {
    isSubagentRunner: true,
    subagentTranscriptId: "child-worker-unbound-999",
    getConversationId: () => "parent-uuid-001"
  };
  const resolved = simulateResolveBinding(mockBindings, host);
  eq(resolved.modelId, "grok-4.6-superheavy");
  eq(resolved.openaiBaseUrl, "http://127.0.0.1:18779/v1");
  eq(resolved.maxMode, true);
  deepEq(resolved.parameters, [{ id: "effort", value: "xhigh" }]);
});

test("subagent uses explicit override binding when present", () => {
  const host = {
    isSubagentRunner: true,
    subagentTranscriptId: "subagent-override-uuid-002",
    getConversationId: () => "parent-uuid-001"
  };
  const resolved = simulateResolveBinding(mockBindings, host);
  eq(resolved.modelId, "zai-org/GLM-5.3-Flash");
  eq(resolved.openaiBaseUrl, "http://127.0.0.1:18791/v1");
  deepEq(resolved.parameters, [{ id: "fast", value: "true" }]);
});

test("top-level turn resolves its own binding directly", () => {
  const host = {
    isSubagentRunner: false,
    getConversationId: () => "parent-uuid-001"
  };
  const resolved = simulateResolveBinding(mockBindings, host);
  eq(resolved.modelId, "grok-4.6-superheavy");
  eq(resolved.openaiBaseUrl, "http://127.0.0.1:18779/v1");
  eq(resolved.maxMode, true);
});

// =========================================================================
// 2. Context Window Capacity Contract
// =========================================================================
console.log("\n--- 2. Context Window Contract (Never returns 0) ---");

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
  "claude-opus-5-oauth-1": 200000,
  "claude-opus-5-oauth-3": 200000,
  "claude-fable-5-oauth-1": 200000
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

test("context window: grok-4.6-superheavy reports 2,097,152", () => {
  eq(reportedContextWindow("grok-4.6-superheavy", "http://127.0.0.1:18779/v1"), 2097152);
});

test("context window: claude-opus-5-oauth-1 reports 200,000", () => {
  eq(reportedContextWindow("claude-opus-5-oauth-1", "http://127.0.0.1:18776/v1"), 200000);
});

test("context window: deepseek-v4-pro-0813:thinking reports 262,144", () => {
  eq(reportedContextWindow("deepseek/deepseek-v4-pro-0813:thinking", "http://127.0.0.1:18786/v1"), 262144);
});

test("context window: zai-org/GLM-5.3-Flash reports 1,048,576", () => {
  eq(reportedContextWindow("zai-org/GLM-5.3-Flash", "http://127.0.0.1:18791/v1"), 1048576);
});

test("context window: gemini-3.7-flash reports 1,048,576", () => {
  eq(reportedContextWindow("gemini-3.7-flash", "http://127.0.0.1:18778/v1"), 1048576);
});

test("context window: explicit context parameter '2m' overrides catalog", () => {
  eq(reportedContextWindow("custom-model", "http://127.0.0.1:18786/v1", [{ id: "context", value: "2m" }]), 2097152);
});

test("context window: unknown custom model defaults to safe 128k baseline (never 0)", () => {
  const cap = reportedContextWindow("completely-unknown-custom-model", "http://127.0.0.1:18786/v1");
  eq(cap >= 131072, true);
  eq(cap !== 0, true);
});

// =========================================================================
// 3. Multi-Provider Reasoning Wire Adapters
// =========================================================================
console.log("\n--- 3. Multi-Provider Reasoning Wire Adapters ---");

test("provider-map: Grok maxMode -> xhigh", () => {
  const b = {};
  const route = applyControls(b, { modelId: "grok-4.6-superheavy", maxMode: true });
  eq(route, "grok");
  eq(b.reasoning_effort, "xhigh");
});

test("provider-map: Grok fast -> low", () => {
  const b = {};
  const route = applyControls(b, { modelId: "grok-4.6", parameters: [{ id: "fast", value: true }] });
  eq(route, "grok");
  eq(b.reasoning_effort, "low");
});

test("provider-map: Claude passthrough (shim owns adaptive thinking)", () => {
  const b = { model: "claude-opus-5-oauth-1", messages: [] };
  const route = applyControls(b, { modelId: "claude-opus-5-oauth-1", baseUrl: "http://127.0.0.1:18776/v1", maxMode: true });
  eq(route, "claude-passthrough");
  deepEq(Object.keys(b), ["model", "messages"]);
});

test("provider-map: DeepSeek :thinking slug enables thinking with high effort and 256k max_tokens", () => {
  const b = { model: "deepseek/deepseek-v4-pro-0813:thinking" };
  const route = applyControls(b, { modelId: "deepseek/deepseek-v4-pro-0813:thinking", baseUrl: "https://nano-gpt.com/api/v1" });
  eq(route, "deepseek-thinking");
  deepEq(b.thinking, { type: "enabled" });
  eq(b.reasoning_effort, "high");
  eq(b.max_tokens, 256000);
});

test("provider-map: GLM fast=true -> thinking: { type: 'disabled' }", () => {
  const b = { model: "glm-5.3-flash" };
  const route = applyControls(b, { modelId: "glm-5.3-flash", parameters: [{ id: "fast", value: "true" }] });
  eq(route, "glm-fast-off");
  deepEq(b.thinking, { type: "disabled" });
});

test("provider-map: GLM effort=max -> literal max reasoning_effort + thinking enabled", () => {
  const b = { model: "glm-5.3" };
  const route = applyControls(b, { modelId: "glm-5.3", parameters: [{ id: "effort", value: "max" }] });
  eq(route, "glm-effort");
  deepEq(b.thinking, { type: "enabled" });
  eq(b.reasoning_effort, "max");
});

test("provider-map: Friendli serverless GLM-5.3-Flash route detected and mapped", () => {
  const b = { model: "zai-org/GLM-5.3-Flash" };
  const route = applyControls(b, { modelId: "zai-org/GLM-5.3-Flash", baseUrl: "http://127.0.0.1:18791/v1", parameters: [{ id: "effort", value: "high" }] });
  eq(route, "glm-effort");
  deepEq(b.thinking, { type: "enabled" });
  eq(b.reasoning_effort, "high");
});

test("provider-map: Gemini 3.6-flash rewrites to tiered slug", () => {
  const b = { model: "gemini-3.6-flash" };
  const route = applyControls(b, { modelId: "gemini-3.6-flash", baseUrl: "http://127.0.0.1:18778/v1", parameters: [{ id: "effort", value: "low" }] });
  eq(route, "gemini-slug");
  eq(b.model, "gemini-3.6-flash-low");
});

test("provider-map: Gemini 3.7-flash is preserved without rewritten slug", () => {
  const b = { model: "gemini-3.7-flash" };
  const route = applyControls(b, { modelId: "gemini-3.7-flash", baseUrl: "http://127.0.0.1:18778/v1", parameters: [{ id: "effort", value: "high" }] });
  eq(route, "gemini-passthrough");
  eq(b.model, "gemini-3.7-flash");
});

// =========================================================================
// 4. Streaming Tool Delta Recovery & JSON Auto-Repair
// =========================================================================
console.log("\n--- 4. Streaming Tool Delta Recovery & JSON Auto-Repair ---");

function repairTruncatedJson(str) {
  if (typeof str !== "string") return null;
  let s = str.trim();
  if (!s) return null;

  try {
    const direct = JSON.parse(s);
    return typeof direct === "object" && direct !== null ? s : null;
  } catch {}

  let inString = false;
  let isEscaped = false;
  const stack = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') {
        inString = true;
      } else if (ch === "{" || ch === "[") {
        stack.push(ch);
      } else if (ch === "}" || ch === "]") {
        if (stack.length > 0) {
          const expected = stack[stack.length - 1] === "{" ? "}" : "]";
          if (ch === expected) {
            stack.pop();
          }
        }
      }
    }
  }

  let repaired = s;
  if (inString) {
    if (isEscaped) {
      repaired = repaired.slice(0, -1);
    }
    repaired += '"';
  }

  repaired = repaired.replace(/,\s*$/, "");
  if (/:\s*$/.test(repaired)) {
    repaired += '""';
  }

  while (stack.length > 0) {
    const open = stack.pop();
    if (open === "{") {
      repaired = repaired.replace(/,\s*$/, "") + "}";
    } else if (open === "[") {
      repaired = repaired.replace(/,\s*$/, "") + "]";
    }
  }

  try {
    const parsed = JSON.parse(repaired);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
  } catch {}

  return null;
}

function canonicalToolArguments(raw) {
  let parsed;
  if (typeof raw === "string") {
    if (!raw.trim()) return "{}";
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

test("json-repair: unclosed string in simple object", () => {
  const truncated = '{"command": "python -c \\"import os\\nprint(';
  const repaired = canonicalToolArguments(truncated);
  assert.notStrictEqual(repaired, null);
  const parsed = JSON.parse(repaired);
  assert.strictEqual(typeof parsed.command, "string");
});

test("json-repair: nested array with incomplete object", () => {
  const truncated = '{"files": [{"path": "/tmp/test.txt", "content": "hello world';
  const repaired = canonicalToolArguments(truncated);
  assert.notStrictEqual(repaired, null);
  const parsed = JSON.parse(repaired);
  assert.strictEqual(parsed.files[0].path, "/tmp/test.txt");
  assert.strictEqual(parsed.files[0].content, "hello world");
});

test("json-repair: trailing key with colon", () => {
  const truncated = '{"tool": "Shell", "params":';
  const repaired = canonicalToolArguments(truncated);
  assert.notStrictEqual(repaired, null);
  const parsed = JSON.parse(repaired);
  assert.strictEqual(parsed.tool, "Shell");
});

test("json-repair: valid JSON passes through intact", () => {
  const valid = '{"command":"ls -la","timeout":5000}';
  const res = canonicalToolArguments(valid);
  deepEq(JSON.parse(res), { command: "ls -la", timeout: 5000 });
});

// =========================================================================
// 5. Context Transformation & History Preservation
// =========================================================================
console.log("\n--- 5. Context Transformation & History Preservation ---");

function flattenText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
  }
  return "";
}

function stringifyResult(res) {
  if (typeof res === "string") return res;
  if (res == null) return "";
  try { return JSON.stringify(res); } catch { return String(res); }
}

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
          if (id && name && args != null) {
            toolCalls.push({
              id,
              type: "function",
              function: { name, arguments: args }
            });
          }
        }
      }
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

function toOpenAiMessages(messages) {
  const prefix = [];
  const rest = [];
  for (const msg of messages || []) {
    const converted = convertOneMessage(msg);
    if (converted == null) continue;
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
  return prefix.concat(coherentRest);
}

test("context-transform: multi-turn parent conversation mapped cleanly", () => {
  const sampleMessages = [
    { role: "system", content: "You are Grok Bot." },
    { role: "user", content: "List the active directory." },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will run ls." },
        { type: "tool-call", toolCallId: "call_001", toolName: "Shell", args: { command: "ls -la" } }
      ]
    },
    {
      role: "tool",
      toolCallId: "call_001",
      content: "file1.txt\nfile2.txt"
    },
    { role: "assistant", content: "Found 2 files." }
  ];

  const transformed = toOpenAiMessages(sampleMessages);
  eq(transformed.length, 5);
  eq(transformed[0].role, "system");
  eq(transformed[1].role, "user");
  eq(transformed[2].role, "assistant");
  eq(transformed[2].tool_calls.length, 1);
  eq(transformed[2].tool_calls[0].function.name, "Shell");
  eq(transformed[3].role, "tool");
  eq(transformed[3].tool_call_id, "call_001");
  eq(transformed[4].role, "assistant");
  eq(transformed[4].content, "Found 2 files.");
});

test("context-transform: orphaned tool results without preceding assistant tool_calls are dropped", () => {
  const sampleMessages = [
    { role: "system", content: "You are Grok Bot." },
    { role: "tool", toolCallId: "orphaned_001", content: "stale tool output" },
    { role: "user", content: "Hello" }
  ];
  const transformed = toOpenAiMessages(sampleMessages);
  eq(transformed.length, 2);
  eq(transformed[0].role, "system");
  eq(transformed[1].role, "user");
});

test("context-transform: worker task delegation prompt preserves system reminder instructions", () => {
  const workerTaskMessage = {
    role: "user",
    content: "<system_reminder>You are an explore worker. Analyze logs.</system_reminder>\nFind root cause of crash."
  };
  const transformed = toOpenAiMessages([workerTaskMessage]);
  eq(transformed.length, 1);
  assert.strictEqual(transformed[0].content.includes("<system_reminder>"), true);
  assert.strictEqual(transformed[0].content.includes("Find root cause of crash."), true);
});

// =========================================================================
// Summary
// =========================================================================
console.log("\n=================================================");
console.log(`Results: ${passed} passed, ${failed} failed.`);
console.log("=================================================");
process.exit(failed > 0 ? 1 : 0);
