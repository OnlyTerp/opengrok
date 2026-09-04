#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const tempProvenanceLog = path.join(os.tmpdir(), "grokbot-provenance-" + Date.now() + ".jsonl");
process.env.GROKBOT_LOCAL_PROVENANCE_LOG = tempProvenanceLog;

const assert = require("assert");
const hopSessionPath = "../openai-hop-session.cjs";
const { createOpenAiHopSession } = require(hopSessionPath);

console.log("=== M2 Adversarial Node.js In-Chat Interception Test Suite ===\n");

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

async function runAll() {
  const CONFIRM_MSG = "✨ Conversation reset. History cleared; agent identity, system instructions, memory, and model bindings preserved.";
  const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

  // Test 1: In-chat variations that MUST trigger reset
  const resetVariations = [
    "/new",
    "/reset",
    "/clear",
    "/NEW",
    "/RESET",
    "/CLEAR",
    "/Clear",
    "/Reset",
    "/New",
    "/reset please",
    "   /reset   ",
    "\t/new\t",
    "/new chat",
    "/reset context",
    "/clear history",
    "/reset --all",
    "/clear session 1",
  ];

  for (const cmd of resetVariations) {
    await testAsync(`In-chat variation '${cmd}' intercepts without network call`, async () => {
      // Intentionally unreachable port that would throw ECONNREFUSED if network call was attempted
      const session = createOpenAiHopSession({
        baseUrl: "http://127.0.0.1:59999/v1",
        modelId: "grok-4.6",
        agentId: VALID_UUID,
        provenanceAgentId: VALID_UUID
      });

      const executor = session.getExecutor([
        { role: "system", content: "System prompt" },
        { role: "user", content: "Historical question" },
        { role: "assistant", content: "Historical answer" },
        { role: "user", content: cmd }
      ]);

      const handle = executor.stream();
      const events = [];
      for await (const ev of handle.fullStream) {
        events.push(ev);
      }

      // Expected: heartbeat, text-delta, finish
      assert.strictEqual(events.length, 3, `Expected 3 events (heartbeat, text-delta, finish), got ${events.length}`);
      assert.strictEqual(events[0].type, "heartbeat");
      assert.strictEqual(events[1].type, "text-delta");
      assert.strictEqual(events[1].textDelta, CONFIRM_MSG);
      assert.strictEqual(events[2].type, "finish");
      assert.strictEqual(events[2].finishReason, "stop");
      assert.strictEqual(events[2].usage.promptTokens, 0);
      assert.strictEqual(events[2].usage.completionTokens, 20);
      assert.strictEqual(events[2].usage.totalTokens, 20);

      // Verify promises settle properly
      const usage = await handle.usage;
      assert.strictEqual(usage.promptTokens, 0);
      assert.strictEqual(usage.completionTokens, 20);
      assert.strictEqual(usage.totalTokens, 20);

      // Verify message builder was wiped
      assert.strictEqual(executor.builder.getMessages().length, 0, "Builder messages should be wiped to 0");
    });
  }

  // Test 2: Multi-part structured message content
  await testAsync("In-chat reset with multi-part structured content", async () => {
    const session = createOpenAiHopSession({
      baseUrl: "http://127.0.0.1:59999/v1",
      modelId: "grok-4.6",
      agentId: VALID_UUID,
      provenanceAgentId: VALID_UUID
    });

    const executor = session.getExecutor([
      {
        role: "user",
        content: [
          { type: "text", text: "   /reset   " }
        ]
      }
    ]);

    const handle = executor.stream();
    const events = [];
    for await (const ev of handle.fullStream) {
      events.push(ev);
    }
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[1].textDelta, CONFIRM_MSG);
    assert.strictEqual(executor.builder.getMessages().length, 0);
  });

  // Test 3: Non-reset command (/clear-all) does NOT trigger false reset
  await testAsync("Non-reset command '/clear-all' passes through to network layer", async () => {
    const session = createOpenAiHopSession({
      baseUrl: "http://127.0.0.1:59999/v1",
      modelId: "grok-4.6",
      agentId: VALID_UUID,
      provenanceAgentId: VALID_UUID
    });

    const executor = session.getExecutor([
      { role: "user", content: "/clear-all" }
    ]);

    const handle = executor.stream();
    const events = [];
    let sawError = false;
    for await (const ev of handle.fullStream) {
      events.push(ev);
      if (ev.type === "error" && ev.error && ev.error.code === "ECONNREFUSED") {
        sawError = true;
      }
    }
    assert.strictEqual(sawError, true, "/clear-all should reach postJsonStream and encounter network attempt");
    // Builder should not be wiped by reset handler
    assert.strictEqual(executor.builder.getMessages().length, 1);
  });

  // Cleanup temp provenance log
  try {
    if (fs.existsSync(tempProvenanceLog)) {
      fs.unlinkSync(tempProvenanceLog);
    }
  } catch {}

  console.log("\n=================================================");
  console.log(`Results: ${passed} passed, ${failed} failed.`);
  console.log("=================================================");
  process.exit(failed > 0 ? 1 : 0);
}

runAll();
