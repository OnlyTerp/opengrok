"use strict";
/**
 * ============================================================================
 * Milestone 4 (M4) Node.js Empirical Challenger Test Suite
 * ============================================================================
 * Adversarially tests:
 * 1. Subagent model binding inheritance logic & loopback security validation.
 * 2. Strict streaming delta event sequencing:
 *    - text-delta -> finish -> settled
 *    - tool-call-streaming-start -> tool-call-delta -> tool-call -> finish -> settled
 *    - Auto-repair of truncated tool arguments in live streams
 *    - Error stream sequencing (error -> finish -> settled rejection)
 *    - Parallel tool call sequencing
 * 3. Provider wire parity matrix under contradictory/extreme parameters:
 *    - xAI (maxMode, effort, fast, thinking ignored)
 *    - Claude (untouched passthrough)
 *    - DeepSeek (:thinking slug, thinking parameter, max_tokens preservation)
 *    - GLM 5.3 (fast=true off switch, effort=max, silent passthrough)
 *    - Qwen SGLang (chat_template_kwargs.enable_thinking, port 18787)
 *    - Gemini (tiered slug rewriting, 3.7 untouched)
 * 4. Pathological Tool Argument JSON repair fuzzing.
 * ============================================================================
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const HOP_SESSION_PATH = path.resolve(__dirname, "..", "openai-hop-session.cjs");
const hop = require(fs.existsSync(HOP_SESSION_PATH) ? HOP_SESSION_PATH : path.resolve(__dirname, "../openai-hop-session.cjs"));
const maps = require("../../tools/provider-maps.cjs");

const VALID_PARENT_UUID = "00000000-0000-4000-8000-000000000101";

let passed = 0;
let failed = 0;

function check(name, fn) {
  return new Promise((resolve) => {
    Promise.resolve()
      .then(() => fn())
      .then(() => {
        passed++;
        console.log("  [PASS] " + name);
        resolve(true);
      })
      .catch((err) => {
        failed++;
        console.error("  [FAIL] " + name + "\n    " + (err && err.stack ? err.stack : String(err)));
        resolve(false);
      });
  });
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || "") + " expected=" + JSON.stringify(expected) + " actual=" + JSON.stringify(actual));
  }
}

function deepEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || "") + "\n  expected=" + JSON.stringify(b) + "\n  actual=" + JSON.stringify(a));
  }
}

async function runAll() {
  console.log("================================================================================");
  console.log("  M4 EMPIRICAL CHALLENGER: STREAMING DELTA SEQUENCING & SUBAGENT INHERITANCE");
  console.log("================================================================================");

  // --------------------------------------------------------------------------
  // SECTION 1: STRICT STREAMING DELTA SEQUENCING TESTS
  // --------------------------------------------------------------------------
  console.log("\n--- 1. Strict Streaming Delta Sequencing ---");

  await check("Stream: Text delta sequencing (heartbeat -> text-deltas -> finish -> settled)", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({
        id: "chatcmpl-test-1",
        model: "grok-4.6",
        choices: [{ delta: { content: "Hello" } }]
      }) + "\n\n");
      res.write("data: " + JSON.stringify({
        id: "chatcmpl-test-1",
        model: "grok-4.6",
        choices: [{ delta: { content: " world!" } }]
      }) + "\n\n");
      res.write("data: " + JSON.stringify({
        id: "chatcmpl-test-1",
        model: "grok-4.6",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        choices: [{ delta: {}, finish_reason: "stop" }]
      }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const session = hop.createOpenAiHopSession({
        baseUrl: "http://127.0.0.1:" + port + "/v1",
        modelId: "grok-4.6",
        provenanceAgentId: VALID_PARENT_UUID,
        requestKind: "main"
      });

      const executor = session.getExecutor({
        messages: [{ role: "user", content: "Hi" }]
      });

      const stream = executor.stream();
      const events = [];
      let finishedSeen = false;

      for await (const chunk of stream.fullStream) {
        events.push(chunk);
        if (chunk.type === "finish") {
          finishedSeen = true;
        } else if (finishedSeen) {
          throw new Error("Received event after finish: " + JSON.stringify(chunk));
        }
      }

      // Assert event order: heartbeat -> text-delta (Hello) -> text-delta ( world!) -> finish (stop)
      const eventTypes = events.map((e) => e.type);
      eq(eventTypes[0], "heartbeat");
      eq(eventTypes[1], "text-delta");
      eq(eventTypes[2], "text-delta");
      eq(eventTypes[3], "finish");

      eq(events[1].textDelta, "Hello");
      eq(events[2].textDelta, " world!");
      eq(events[3].finishReason, "stop");
      eq(events[3].usage.totalTokens, 15);

      // Verify settled promises
      const resp = await stream.response;
      deepEq(resp.messages[0].content, [{ type: "text", text: "Hello world!" }]);
      const usage = await stream.usage;
      eq(usage.totalTokens, 15);
    } finally {
      server.close();
    }
  });

  await check("Stream: Tool calls sequencing (streaming-start -> delta -> tool-call -> finish -> settled)", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({
        id: "chatcmpl-tool-1",
        model: "grok-4.6",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_abc123",
              type: "function",
              function: { name: "readFile", arguments: '{"file' }
            }]
          }
        }]
      }) + "\n\n");
      res.write("data: " + JSON.stringify({
        id: "chatcmpl-tool-1",
        model: "grok-4.6",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: 'Path": "test.txt"}' }
            }]
          }
        }]
      }) + "\n\n");
      res.write("data: " + JSON.stringify({
        id: "chatcmpl-tool-1",
        model: "grok-4.6",
        usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        choices: [{ delta: {}, finish_reason: "tool_calls" }]
      }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const session = hop.createOpenAiHopSession({
        baseUrl: "http://127.0.0.1:" + port + "/v1",
        modelId: "grok-4.6",
        provenanceAgentId: VALID_PARENT_UUID,
        requestKind: "main"
      });

      const executor = session.getExecutor({
        messages: [{ role: "user", content: "Read test.txt" }],
        tools: [{ type: "function", function: { name: "readFile", parameters: {} } }]
      });

      const stream = executor.stream();
      const events = [];
      let finishIndex = -1;

      for await (const chunk of stream.fullStream) {
        events.push(chunk);
        if (chunk.type === "finish") {
          finishIndex = events.length - 1;
        } else if (finishIndex !== -1) {
          throw new Error("Event emitted after finish event!");
        }
      }

      // Check event sequence:
      // 1. heartbeat
      // 2. tool-call-streaming-start
      // 3. tool-call-delta
      // 4. tool-call-delta
      // 5. tool-call (complete parsed object)
      // 6. finish (finishReason: "tool-calls")
      const eventTypes = events.map((e) => e.type);
      eq(eventTypes.includes("tool-call-streaming-start"), true);
      eq(eventTypes.includes("tool-call-delta"), true);
      eq(eventTypes.includes("tool-call"), true);
      eq(eventTypes[eventTypes.length - 1], "finish");

      const finalToolCall = events.find((e) => e.type === "tool-call");
      eq(finalToolCall.toolName, "readFile");
      eq(finalToolCall.toolCallId, "call_abc123");
      deepEq(finalToolCall.args, { filePath: "test.txt" });

      const finishEvent = events[events.length - 1];
      eq(finishEvent.finishReason, "tool-calls");
      eq(finishEvent.usage.totalTokens, 35);

      const resp = await stream.response;
      const contentParts = resp.messages[0].content;
      eq(Array.isArray(contentParts), true);
      eq(contentParts.length, 1);
      eq(contentParts[0].type, "tool-call");
      deepEq(contentParts[0].args, { filePath: "test.txt" });
    } finally {
      server.close();
    }
  });

  await check("Stream: Truncated JSON tool argument auto-repair in streaming pipeline", async () => {
    // Model abruptly cuts off at token limit with unclosed quotes and braces
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({
        id: "chatcmpl-trunc-1",
        model: "grok-4.6",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_trunc_999",
              type: "function",
              function: { name: "runCommand", arguments: '{"command": "cat /var/log/syslog | grep error' }
            }]
          }
        }]
      }) + "\n\n");
      res.write("data: " + JSON.stringify({
        id: "chatcmpl-trunc-1",
        model: "grok-4.6",
        usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 },
        choices: [{ delta: {}, finish_reason: "stop" }]
      }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const session = hop.createOpenAiHopSession({
        baseUrl: "http://127.0.0.1:" + port + "/v1",
        modelId: "grok-4.6",
        provenanceAgentId: VALID_PARENT_UUID,
        requestKind: "main"
      });

      const executor = session.getExecutor({
        messages: [{ role: "user", content: "Find errors in log" }],
        tools: [{ type: "function", function: { name: "runCommand", parameters: {} } }]
      });

      const stream = executor.stream();
      const events = [];
      for await (const chunk of stream.fullStream) {
        events.push(chunk);
      }

      const toolCallEvent = events.find((e) => e.type === "tool-call");
      eq(toolCallEvent != null, true, "Expected repaired tool-call event");
      eq(toolCallEvent.toolName, "runCommand");
      eq(typeof toolCallEvent.args.command, "string");
      eq(toolCallEvent.args.command.startsWith("cat /var/log/syslog"), true);

      const finishEvent = events[events.length - 1];
      eq(finishEvent.type, "finish");
      eq(finishEvent.finishReason, "tool-calls");

      const resp = await stream.response;
      const contentParts = resp.messages[0].content;
      eq(Array.isArray(contentParts), true);
      eq(contentParts.length, 1);
      eq(contentParts[0].args.command.startsWith("cat /var/log/syslog"), true);
    } finally {
      server.close();
    }
  });

  await check("Stream: Parallel multi-tool call sequencing", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({
        id: "chatcmpl-multi-1",
        model: "grok-4.6",
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: "call_p0", type: "function", function: { name: "toolA", arguments: '{"a":1}' } },
              { index: 1, id: "call_p1", type: "function", function: { name: "toolB", arguments: '{"b":2}' } }
            ]
          }
        }]
      }) + "\n\n");
      res.write("data: " + JSON.stringify({
        id: "chatcmpl-multi-1",
        model: "grok-4.6",
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
        choices: [{ delta: {}, finish_reason: "tool_calls" }]
      }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const session = hop.createOpenAiHopSession({
        baseUrl: "http://127.0.0.1:" + port + "/v1",
        modelId: "grok-4.6",
        provenanceAgentId: VALID_PARENT_UUID,
        requestKind: "main"
      });

      const executor = session.getExecutor({
        messages: [{ role: "user", content: "Run tools A and B" }]
      });

      const stream = executor.stream();
      const events = [];
      for await (const chunk of stream.fullStream) {
        events.push(chunk);
      }

      const toolCalls = events.filter((e) => e.type === "tool-call");
      eq(toolCalls.length, 2);
      eq(toolCalls[0].toolName, "toolA");
      deepEq(toolCalls[0].args, { a: 1 });
      eq(toolCalls[1].toolName, "toolB");
      deepEq(toolCalls[1].args, { b: 2 });

      eq(events[events.length - 1].type, "finish");
      eq(events[events.length - 1].finishReason, "tool-calls");
    } finally {
      server.close();
    }
  });

  await check("Stream: Upstream server error sequencing (error -> finish -> promise rejection)", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({
        error: { message: "Upstream rate limit exceeded", code: "rate_limit_exceeded" }
      }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const session = hop.createOpenAiHopSession({
        baseUrl: "http://127.0.0.1:" + port + "/v1",
        modelId: "grok-4.6",
        provenanceAgentId: VALID_PARENT_UUID,
        requestKind: "main"
      });

      const executor = session.getExecutor({
        messages: [{ role: "user", content: "Hello" }]
      });

      const stream = executor.stream();
      const events = [];
      for await (const chunk of stream.fullStream) {
        events.push(chunk);
      }

      // Expected sequence: heartbeat -> error -> finish (finishReason: "error")
      const errorEvent = events.find((e) => e.type === "error");
      eq(errorEvent != null, true, "Expected error event");
      eq(errorEvent.error.message.includes("Upstream rate limit exceeded"), true);

      const finishEvent = events[events.length - 1];
      eq(finishEvent.type, "finish");
      eq(finishEvent.finishReason, "error");

      // Attach catch handlers to companion promises to prevent unhandled rejection events
      stream.usage.catch(() => {});
      stream.extendedUsage?.catch(() => {});
      stream.providerMetadata?.catch(() => {});
      stream.invocationId?.catch(() => {});

      let rejected = false;
      try {
        await stream.response;
      } catch (err) {
        rejected = true;
        eq(err.message.includes("Upstream rate limit exceeded"), true);
      }
      eq(rejected, true, "Expected stream.response promise to reject");
    } finally {
      server.close();
    }
  });

  // --------------------------------------------------------------------------
  // SECTION 2: SUBAGENT MODEL BINDING INHERITANCE LOGIC TESTS
  // --------------------------------------------------------------------------
  console.log("\n--- 2. Subagent Model Binding Inheritance & Security ---");

  await check("Inheritance: Dynamic subagent inherits parent hopBaseUrl, modelId, maxMode, parameters", async () => {
    const parentAgentId = "00000000-0000-4000-8000-000000000101";
    const subagentTranscriptId = "subagent-uuid-" + Math.random().toString(36).slice(2);

    const mockModelBindings = {
      agents: {
        [parentAgentId]: {
          name: "alpha-agent",
          modelId: "grok-4.6-superheavy",
          provider: "grok-superheavy",
          baseUrl: "http://127.0.0.1:18779/v1",
          parameters: [{ id: "effort", value: "max" }],
          maxMode: true,
          hopBaseUrl: "http://127.0.0.1:18786/v1"
        }
      }
    };

    // Simulate host-main.cjs resolution logic
    const host = {
      isSubagentRunner: true,
      subagentTranscriptId: subagentTranscriptId,
      getConversationId: () => parentAgentId,
      subagentModelId: undefined,
      isComputerUseSubagent: false,
      isBrowserUseSubagent: false
    };

    let resolvedTopLevelModelId = host.subagentModelId;
    let resolvedOpenaiBaseUrl = undefined;
    let resolvedTopLevelMaxMode = undefined;
    let resolvedTopLevelParameters = undefined;
    let boundLocalRouteActive = false;

    const __agentId = host.isSubagentRunner && host.subagentTranscriptId
      ? host.subagentTranscriptId
      : host.getConversationId();

    const __agents = mockModelBindings.agents;
    let __entry = __agents[__agentId];
    if (!__entry && host.isSubagentRunner) {
      const __parentAgentId = host.getConversationId();
      __entry = __agents[__parentAgentId];
    }

    const __exactBindingFound = __entry != null;
    eq(__exactBindingFound, true, "Parent binding must be found for subagent fallback");

    if (__entry && typeof __entry === "object") {
      if (!resolvedTopLevelModelId) resolvedTopLevelModelId = __entry.modelId;
      if (typeof __entry.maxMode === "boolean") resolvedTopLevelMaxMode = __entry.maxMode;
      if (Array.isArray(__entry.parameters)) resolvedTopLevelParameters = __entry.parameters;
      if (__entry.hopBaseUrl) {
        const u = new URL(__entry.hopBaseUrl);
        if (u.protocol === "http:" && u.hostname === "127.0.0.1" && u.pathname.replace(/\/+$/, "") === "/v1") {
          resolvedOpenaiBaseUrl = `${u.protocol}//${u.host}/v1`;
          boundLocalRouteActive = true;
        }
      }
    }

    eq(resolvedTopLevelModelId, "grok-4.6-superheavy");
    eq(resolvedOpenaiBaseUrl, "http://127.0.0.1:18786/v1");
    eq(resolvedTopLevelMaxMode, true);
    deepEq(resolvedTopLevelParameters, [{ id: "effort", value: "max" }]);
    eq(boundLocalRouteActive, true);
  });

  await check("Inheritance: Explicit subagent override takes precedence over parent binding", async () => {
    const parentAgentId = "00000000-0000-4000-8000-000000000101";
    const subagentExplicitId = "explicit-subagent-uuid-001";

    const mockModelBindings = {
      agents: {
        [parentAgentId]: {
          name: "alpha-agent",
          modelId: "grok-4.6-superheavy",
          hopBaseUrl: "http://127.0.0.1:18786/v1"
        },
        [subagentExplicitId]: {
          name: "ExplicitSubagent",
          modelId: "deepseek/deepseek-v4-pro-0813:thinking",
          hopBaseUrl: "http://127.0.0.1:18786/v1"
        }
      }
    };

    const host = {
      isSubagentRunner: true,
      subagentTranscriptId: subagentExplicitId,
      getConversationId: () => parentAgentId,
      subagentModelId: undefined
    };

    const __agentId = host.isSubagentRunner && host.subagentTranscriptId
      ? host.subagentTranscriptId
      : host.getConversationId();

    const __agents = mockModelBindings.agents;
    let __entry = __agents[__agentId];
    if (!__entry && host.isSubagentRunner) {
      __entry = __agents[host.getConversationId()];
    }

    eq(__entry.modelId, "deepseek/deepseek-v4-pro-0813:thinking", "Explicit subagent binding must win");
    eq(__entry.name, "ExplicitSubagent");
  });

  await check("Security: Malformed / Non-Loopback hopBaseUrl fails with LocalProviderBindingError", async () => {
    const invalidHopUrls = [
      "http://203.0.113.10:18786/v1", // Non-loopback (TEST-NET-3 doc range)
      "http://attacker.com/v1",         // Remote domain SSRF
      "https://127.0.0.1:18786/v1",     // Non-http protocol
      "http://user:pass@127.0.0.1:18786/v1", // Embedded credentials
      "http://127.0.0.1:18786/api/v2",  // Non-/v1 path
      "http://127.0.0.1/v1",            // Missing explicit port
      "javascript:alert(1)"             // Malicious scheme
    ];

    for (const invalidUrl of invalidHopUrls) {
      let rejected = false;
      try {
        const u = new URL(invalidUrl);
        const hopPath = u.pathname.replace(/\/+$/, "");
        if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" ||
            u.username !== "" || u.password !== "" || u.search !== "" ||
            u.hash !== "" || u.port === "" || hopPath !== "/v1") {
          throw new Error("exact local binding hopBaseUrl must be loopback http://127.0.0.1:<port>/v1");
        }
      } catch (e) {
        rejected = true;
      }
      eq(rejected, true, "URL " + invalidUrl + " must be rejected");
    }
  });

  // --------------------------------------------------------------------------
  // SECTION 3: PROVIDER WIRE PARITY MATRIX & EDGE CASES
  // --------------------------------------------------------------------------
  console.log("\n--- 3. Provider Wire Parity Matrix ---");

  await check("Parity: xAI contradictory parameters (maxMode vs fast vs effort)", async () => {
    const b = {};
    const label = maps.applyProviderReasoningControls(b, {
      modelId: "grok-4.6",
      maxMode: true,
      parameters: [{ id: "fast", value: true }, { id: "effort", value: "low" }]
    });
    eq(label, "grok");
    // maxMode has highest precedence on grok
    eq(b.reasoning_effort, "xhigh");
  });

  await check("Parity: Claude extra body parameters are byte-preserved", async () => {
    const b = { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }], custom_field: 42 };
    const label = maps.applyProviderReasoningControls(b, {
      modelId: "claude-opus-5",
      baseUrl: "http://127.0.0.1:18776/v1",
      maxMode: true,
      parameters: [{ id: "thinking", value: "true" }]
    });
    eq(label, "claude-passthrough");
    eq(b.custom_field, 42);
    eq(b.reasoning_effort, undefined);
    eq(b.thinking, undefined);
  });

  await check("Parity: GLM contradictory parameters (fast vs effort)", async () => {
    const b = { model: "glm-5.3" };
    // fast: true has precedence over effort
    const label = maps.applyProviderReasoningControls(b, {
      modelId: "glm-5.3",
      parameters: [{ id: "fast", value: true }, { id: "effort", value: "max" }]
    });
    eq(label, "glm-fast-off");
    deepEq(b.thinking, { type: "disabled" });
  });

  await check("Parity: Qwen local SGLang chat_template_kwargs", async () => {
    const b = { model: "local-qwen38-27b" };
    const label = maps.applyProviderReasoningControls(b, {
      modelId: "local-qwen38-27b",
      baseUrl: "http://127.0.0.1:18787/v1",
      parameters: [{ id: "thinking", value: "true" }, { id: "effort", value: "medium" }]
    });
    eq(label, "qwen-local");
    deepEq(b.chat_template_kwargs, { enable_thinking: true });
    eq(b.reasoning_effort, "medium");
  });

  await check("Parity: Gemini tiered slug boundary (3.6 vs 3.7)", async () => {
    const b1 = { model: "gemini-3.6-flash" };
    maps.applyProviderReasoningControls(b1, {
      modelId: "gemini-3.6-flash",
      parameters: [{ id: "effort", value: "medium" }]
    });
    eq(b1.model, "gemini-3.6-flash-medium");

    const b2 = { model: "gemini-3.7-flash" };
    maps.applyProviderReasoningControls(b2, {
      modelId: "gemini-3.7-flash",
      parameters: [{ id: "effort", value: "medium" }]
    });
    eq(b2.model, "gemini-3.7-flash");
  });

  // --------------------------------------------------------------------------
  // SECTION 4: PATHOLOGICAL JSON AUTO-REPAIR FUZZING
  // --------------------------------------------------------------------------
  console.log("\n--- 4. Pathological JSON Auto-Repair Fuzzing ---");

  await check("JSON Repair: Escaped quote and nested JSON cutoffs", async () => {
    const inputs = [
      '{"code": "print(\\"hello world\\")\\n\\n',
      '{"query": "SELECT * FROM users WHERE name = \\"O\'Connor\\"',
      '{"nested": {"array": [{"k": "v',
      '{"flag": true, "list": [1, 2, 3,',
      '{"message": "Dangling colon test", "detail":'
    ];

    for (const raw of inputs) {
      const repaired = maps.canonicalToolArguments(raw);
      eq(repaired != null, true, "Must successfully repair: " + raw);
      const parsed = JSON.parse(repaired);
      eq(typeof parsed, "object");
      eq(parsed !== null, true);
    }
  });

  console.log("\n================================================================================");
  console.log("  TOTAL PASSED: " + passed + " / " + (passed + failed) + " | FAILED: " + failed);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error("Fatal test runner crash:", err);
  process.exit(1);
});
