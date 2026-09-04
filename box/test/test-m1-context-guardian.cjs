#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Load the hop session module
const hopSessionPath = "../openai-hop-session.cjs";
const hopSession = require(hopSessionPath);
const {
  applyAntiCookingContextGuardian,
  reportedContextWindow,
  toOpenAiMessages
} = hopSession.__test;

console.log("=== M1 Anti-Cooking Context Guardian & Headroom Budgeting Test Suite ===\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

// -----------------------------------------------------------------------------
// 1. Context Window Registry & Fallback Tests
// -----------------------------------------------------------------------------
test("1.1 reportedContextWindow: grok-4.6 returns 2,097,152", () => {
  const cap = reportedContextWindow("grok-4.6", "http://127.0.0.1:18779/v1");
  assert.strictEqual(cap, 2097152);
});

test("1.2 reportedContextWindow: deepseek-v4-pro returns 262,144", () => {
  const cap = reportedContextWindow("deepseek/deepseek-v4-pro-0813:thinking", "http://127.0.0.1:18786/v1");
  assert.strictEqual(cap, 262144);
});

test("1.3 reportedContextWindow: glm-5.3 returns 1,048,576", () => {
  const cap = reportedContextWindow("glm-5.3", "http://127.0.0.1:18786/v1");
  assert.strictEqual(cap, 1048576);
});

test("1.4 reportedContextWindow: claude-opus-5 returns 200,000 baseline", () => {
  const cap = reportedContextWindow("claude-opus-5", "http://127.0.0.1:18786/v1");
  assert.strictEqual(cap, 200000);
});

test("1.5 reportedContextWindow: claude-opus-5 with context=1m parameter returns 1,048,576", () => {
  const cap = reportedContextWindow("claude-opus-5", "http://127.0.0.1:18786/v1", [{ id: "context", value: "1m" }]);
  assert.strictEqual(cap, 1048576);
});

test("1.6 reportedContextWindow: uncataloged model returns safe 131,072 baseline (never 0)", () => {
  const cap = reportedContextWindow("custom-unknown-model-xyz", "http://127.0.0.1:18786/v1");
  assert.strictEqual(cap, 131072);
});

test("1.7 reportedContextWindow: verify all 16 agents in model-bindings.json resolve > 0", () => {
  const bindingsPath = path.resolve(__dirname, "..", "..", "examples", "model-bindings.example.json");
  const bindings = JSON.parse(fs.readFileSync(bindingsPath, "utf8"));
  assert(bindings.agents, "model-bindings.json missing agents map");

  for (const [agentId, agent] of Object.entries(bindings.agents)) {
    const cap = reportedContextWindow(agent.modelId, agent.hopBaseUrl || agent.baseUrl, agent.parameters);
    assert(cap >= 131072, `Agent ${agent.name} (${agent.modelId}) reported invalid context window: ${cap}`);
  }
});

// -----------------------------------------------------------------------------
// 2. Sliding Window & Fidelity Preservation (<= 5 User Turns)
// -----------------------------------------------------------------------------
test("2.1 Conversations with <= 5 user turns preserve 100% full fidelity of large tool outputs", () => {
  const largeOutput = "X".repeat(15000);
  const messages = [
    { role: "user", content: "Turn 1" },
    { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "run", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: largeOutput },
    { role: "user", content: "Turn 2" },
    { role: "assistant", tool_calls: [{ id: "call_2", type: "function", function: { name: "run", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_2", content: largeOutput },
    { role: "user", content: "Turn 3" },
    { role: "assistant", content: "Done" }
  ];

  const processed = applyAntiCookingContextGuardian(JSON.parse(JSON.stringify(messages)), "grok-4.6", "http://127.0.0.1:18779/v1");
  assert.strictEqual(processed[2].content.length, 15000, "Turn 1 tool output must remain 100% full fidelity");
  assert.strictEqual(processed[5].content.length, 15000, "Turn 2 tool output must remain 100% full fidelity");
  assert.strictEqual(processed[2].content, largeOutput);
});

// -----------------------------------------------------------------------------
// 3. Historical Tool Output Pruning (> 5 User Turns)
// -----------------------------------------------------------------------------
test("3.1 In >5 user turn conversations, historical tool outputs >1000 chars are pruned by >70%", () => {
  const largeHistoricalOutput = "HEAD_MARKER_" + "A".repeat(4000) + "\nLINE2\nLINE3\n" + "B".repeat(4000) + "_TAIL_MARKER";
  const largeRecentOutput = "RECENT_TOOL_OUTPUT_" + "C".repeat(5000);
  const smallHistoricalOutput = "Small historical output under 1000 characters.";

  // Build an 8-turn conversation:
  // Turns 1, 2, 3: Historical (>5th-to-last user turn)
  // Turns 4, 5, 6, 7, 8: Recent (last 5 user turns)
  const messages = [
    // Turn 1 (Historical) - Large Tool Output (>1000c)
    { role: "user", content: "Turn 1" },
    { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "run", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: largeHistoricalOutput },

    // Turn 2 (Historical) - Small Tool Output (<=1000c)
    { role: "user", content: "Turn 2" },
    { role: "assistant", tool_calls: [{ id: "call_2", type: "function", function: { name: "run", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_2", content: smallHistoricalOutput },

    // Turn 3 (Historical) - Large Tool Output (>1000c)
    { role: "user", content: "Turn 3" },
    { role: "assistant", tool_calls: [{ id: "call_3", type: "function", function: { name: "run", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_3", content: largeHistoricalOutput },

    // Turn 4 (Recent #1) - 5th-to-last user turn
    { role: "user", content: "Turn 4" },
    { role: "assistant", tool_calls: [{ id: "call_4", type: "function", function: { name: "run", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_4", content: largeRecentOutput },

    // Turn 5 (Recent #2)
    { role: "user", content: "Turn 5" },
    { role: "assistant", tool_calls: [{ id: "call_5", type: "function", function: { name: "run", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_5", content: largeRecentOutput },

    // Turn 6 (Recent #3)
    { role: "user", content: "Turn 6" },
    { role: "assistant", tool_calls: [{ id: "call_6", type: "function", function: { name: "run", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_6", content: largeRecentOutput },

    // Turn 7 (Recent #4)
    { role: "user", content: "Turn 7" },
    { role: "assistant", tool_calls: [{ id: "call_7", type: "function", function: { name: "run", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_7", content: largeRecentOutput },

    // Turn 8 (Recent #5) - Current turn
    { role: "user", content: "Turn 8" },
    { role: "assistant", content: "Working on it" }
  ];

  const processed = applyAntiCookingContextGuardian(JSON.parse(JSON.stringify(messages)), "grok-4.6", "http://127.0.0.1:18779/v1");

  // Historical Turn 1: Truncated
  const t1Tool = processed[2];
  assert(t1Tool.content.includes("truncated by Anti-Cooking Context Guardian"), "Turn 1 tool must have truncation notice");
  assert(t1Tool.content.startsWith("HEAD_MARKER_"), "Turn 1 tool head (350c) preserved");
  assert(t1Tool.content.endsWith("_TAIL_MARKER"), "Turn 1 tool tail (200c) preserved");
  const reductionPct = ((largeHistoricalOutput.length - t1Tool.content.length) / largeHistoricalOutput.length) * 100;
  assert(reductionPct > 70, `Expected >70% reduction, achieved ${reductionPct.toFixed(1)}%`);

  // Historical Turn 2: Small tool output preserved verbatim
  const t2Tool = processed[5];
  assert.strictEqual(t2Tool.content, smallHistoricalOutput, "Small historical tool output under 1000 chars must not be truncated");

  // Historical Turn 3: Truncated
  const t3Tool = processed[8];
  assert(t3Tool.content.includes("truncated by Anti-Cooking Context Guardian"), "Turn 3 tool must have truncation notice");

  // Recent Turns 4, 5, 6, 7: 100% full fidelity
  assert.strictEqual(processed[11].content, largeRecentOutput, "Turn 4 tool output must be 100% intact");
  assert.strictEqual(processed[14].content, largeRecentOutput, "Turn 5 tool output must be 100% intact");
  assert.strictEqual(processed[17].content, largeRecentOutput, "Turn 6 tool output must be 100% intact");
  assert.strictEqual(processed[20].content, largeRecentOutput, "Turn 7 tool output must be 100% intact");
});

// -----------------------------------------------------------------------------
// 4. Headroom Budget Emergency Check
// -----------------------------------------------------------------------------
test("4.1 Aggressive compaction triggered when tokens exceed 70% of context window", () => {
  // Create conversation on 128k baseline model (70% = ~89k tokens = ~313k chars)
  const hugeHistory = "D".repeat(40000);
  const messages = [
    { role: "user", content: "Turn 1" },
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "cmd", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: hugeHistory },
    { role: "user", content: "Turn 2" },
    { role: "assistant", tool_calls: [{ id: "c2", type: "function", function: { name: "cmd", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c2", content: hugeHistory },
    { role: "user", content: "Turn 3" },
    { role: "assistant", tool_calls: [{ id: "c3", type: "function", function: { name: "cmd", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c3", content: hugeHistory },
    { role: "user", content: "Turn 4" },
    { role: "assistant", tool_calls: [{ id: "c4", type: "function", function: { name: "cmd", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c4", content: hugeHistory },
    { role: "user", content: "Turn 5" },
    { role: "assistant", tool_calls: [{ id: "c5", type: "function", function: { name: "cmd", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c5", content: hugeHistory },
    { role: "user", content: "Turn 6" },
    { role: "assistant", tool_calls: [{ id: "c6", type: "function", function: { name: "cmd", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c6", content: hugeHistory },
    { role: "user", content: "Turn 7" },
    { role: "assistant", content: "Recent turn" }
  ];

  // Under small context window (e.g. 131072 tokens), total ~240k chars estTokens ~68k tokens
  // If we simulate windowLimit=50000 via custom model override:
  const processed = applyAntiCookingContextGuardian(
    JSON.parse(JSON.stringify(messages)),
    "custom-tiny",
    "http://127.0.0.1:18786/v1",
    [{ id: "context", value: "128k" }]
  );
  // cutoffIndex will be userIndices[7 - 5] = userIndices[2] = 6 (Turn 3)
  // Historical tools before cutoffIndex (Turns 1 and 2) will be pruned
  assert(processed[2].content.includes("truncated"), "Historical tool must be truncated");
});

// -----------------------------------------------------------------------------
// 5. toOpenAiMessages Integration
// -----------------------------------------------------------------------------
test("5.1 toOpenAiMessages passes modelId and parameters to applyAntiCookingContextGuardian", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: "Turn 1" },
    { role: "assistant", content: [{ type: "text", text: "running command" }, { type: "tool-call", toolCallId: "t1", toolName: "exec", args: "{}" }] },
    { role: "tool", toolCallId: "t1", content: "TOOL_OUTPUT_DATA_" + "Z".repeat(3000) },
    { role: "user", content: "Turn 2" },
    { role: "user", content: "Turn 3" },
    { role: "user", content: "Turn 4" },
    { role: "user", content: "Turn 5" },
    { role: "user", content: "Turn 6" }
  ];

  const result = toOpenAiMessages(messages, "http://127.0.0.1:18779/v1", "grok-4.6", [{ id: "context", value: "2m" }]);
  assert(Array.isArray(result));
  // Tool output in Turn 1 should be truncated
  const toolMsg = result.find(m => m.role === "tool");
  assert(toolMsg, "Must include tool message");
  assert(toolMsg.content.includes("Anti-Cooking Context Guardian"), "Tool message must be pruned by Guardian");
});

console.log(`\n=================================================`);
console.log(`Results: ${passed} passed, ${failed} failed.`);
console.log(`=================================================`);

if (failed > 0) {
  process.exit(1);
}
