"use strict";
/**
 * Empirical Challenger Node Stress Harness for M2:
 * Directly tests the in-chat interception, prompt builder clearing,
 * and zero-history / fresh turn 1 behavior in Node.js runtime.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

console.log("=== M2 Empirical Challenger Node Stress Suite ===\n");

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

// 1. In-Chat Reset regex evaluation on edge cases
const RESET_REGEX = /^\s*\/(?:new|reset|clear)(?:\s+.*)?$/i;

test("Regex matches slash variants with arguments and whitespace", () => {
  const matches = [
    "/new", "/reset", "/clear",
    "/NEW", "/RESET", "/CLEAR",
    "/new chat", "/reset context", "/clear history",
    "   /new   ", "\t/reset \t", " /clear \r\n",
    "/new model:grok", "/reset --force"
  ];
  for (const m of matches) {
    assert.strictEqual(RESET_REGEX.test(m), true, `Should match: ${m}`);
  }
});

test("Regex rejects false positive commands and normal sentences", () => {
  const nonMatches = [
    "new", "reset", "clear",
    "/newline", "/news", "/help", "/status",
    "hello /new", "how do I reset", "clear the screen",
    "//new", "/ reset", "/\tnew"
  ];
  for (const nm of nonMatches) {
    assert.strictEqual(RESET_REGEX.test(nm), false, `Should NOT match: ${nm}`);
  }
});

// 2. Simulated HopPromptBuilder & HopPromptExecutor turn sequence
class MockPromptBuilder {
  constructor() {
    this.messages = [];
  }
  appendMessages(msgs) {
    this.messages.push(...msgs);
  }
  getMessages() {
    return [...this.messages];
  }
  clearMessages() {
    this.messages = [];
  }
}

function flattenText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
  }
  return "";
}

class MockHopPromptExecutor {
  constructor(builder) {
    this.builder = builder;
    this.upstreamCalls = 0;
  }

  *stream(prompt) {
    if (prompt !== undefined) {
      this.builder.appendMessages([{ role: "user", content: prompt }]);
    }

    // Exact matching logic from openai-hop-session.cjs
    const rawMessages = this.builder.getMessages();
    let lastUserMsg = null;
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      if (rawMessages[i] && (rawMessages[i].role === "user" || rawMessages[i].role === "human")) {
        lastUserMsg = rawMessages[i];
        break;
      }
    }
    const promptText = flattenText(lastUserMsg?.content).trim();
    if (RESET_REGEX.test(promptText)) {
      this.builder.clearMessages();
      const confirmMsg = "✨ Conversation reset. History cleared; agent identity, system instructions, memory, and model bindings preserved.";
      yield { type: "text-delta", textDelta: confirmMsg, text: confirmMsg };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 20, totalTokens: 20 }
      };
      return;
    }

    this.upstreamCalls++;
    yield { type: "text-delta", textDelta: `Response to ${promptText}`, text: `Response to ${promptText}` };
    yield {
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 }
    };
  }
}

test("Multi-turn state machine: Turn 1 -> Turn 2 -> /reset -> Fresh Turn 1 (0 history)", () => {
  const builder = new MockPromptBuilder();
  const executor = new MockHopPromptExecutor(builder);

  // Turn 1
  const t1 = [...executor.stream("Turn 1: Tell me a joke.")];
  assert.strictEqual(executor.upstreamCalls, 1);
  builder.appendMessages([{ role: "assistant", content: "Why did the chicken cross the road?" }]);

  // Turn 2
  const t2 = [...executor.stream("Turn 2: Why?")];
  assert.strictEqual(executor.upstreamCalls, 2);
  builder.appendMessages([{ role: "assistant", content: "To get to the other side!" }]);

  assert.strictEqual(builder.getMessages().length, 4);

  // Reset turn
  const resetRes = [...executor.stream("   /RESET   ")];
  assert.strictEqual(resetRes[0].textDelta.includes("Conversation reset"), true);
  assert.strictEqual(resetRes[1].usage.promptTokens, 0);
  assert.strictEqual(executor.upstreamCalls, 2); // No extra upstream call
  assert.strictEqual(builder.getMessages().length, 0); // Completely cleared

  // Fresh Turn 1
  const freshRes = [...executor.stream("Fresh Turn 1: Write a quicksort in Python.")];
  assert.strictEqual(executor.upstreamCalls, 3);
  const msgs = builder.getMessages();
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].content, "Fresh Turn 1: Write a quicksort in Python.");

  const allMsgsJson = JSON.stringify(msgs);
  assert.strictEqual(allMsgsJson.includes("chicken"), false);
  assert.strictEqual(allMsgsJson.includes("joke"), false);
});

console.log("\n=================================================");
console.log(`Results: ${passed} passed, ${failed} failed.`);
console.log("=================================================");
process.exit(failed > 0 ? 1 : 0);
