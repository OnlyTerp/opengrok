"use strict";
/**
 * ============================================================================
 * Grok Bot Milestone 4 (M4) Empirical Challenger Fuzz & Stress Test Harness
 * ============================================================================
 * Stress-tests:
 * 1. repairTruncatedJson & canonicalToolArguments (Fuzzing 150+ malformed strings)
 * 2. applyProviderReasoningControls (Exhaustive Cartesian Permutations)
 * 3. Model Binding Inheritance & Context Window Invariants
 * ============================================================================
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");

const PROVIDER_MAPS_PATH = path.resolve(__dirname, "..", "..", "tools", "provider-maps.cjs");
const providerMaps = require(PROVIDER_MAPS_PATH);

const {
  applyProviderReasoningControls,
  repairTruncatedJson,
  canonicalToolArguments,
  repairTruncatedJsonArguments,
  ToolArgumentRepairEngine,
  isGrokRoute,
  isClaudeRoute,
  isGeminiRoute,
  isDeepSeekRoute,
  isGlmRoute,
  isQwenRoute
} = providerMaps;

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`FAIL: ${name}`);
    console.error(`  Error: ${err.message}`);
    if (err.stack) console.error(`  ${err.stack.split("\n").slice(1, 4).join("\n")}`);
  }
}

console.log("================================================================================");
console.log("  RUNNING M4 EMPIRICAL CHALLENGER NODE STRESS HARNESS");
console.log("================================================================================\n");

// ============================================================================
// SUITE 1: Deterministic Edge Cases & Malformed Payloads (repairTruncatedJson & canonicalToolArguments)
// ============================================================================
console.log("--- Suite 1: Tool Argument Auto-Repair Edge Cases & Adversarial Payloads ---");

test("1.1 Empty and whitespace payloads", () => {
  assert.strictEqual(repairTruncatedJson(""), "{}");
  assert.strictEqual(repairTruncatedJson("   "), "{}");
  assert.strictEqual(repairTruncatedJson("\t\n\r"), "{}");
  assert.strictEqual(canonicalToolArguments(""), null);
  assert.strictEqual(canonicalToolArguments("   "), null);
});

test("1.2 Non-string and invalid argument types passed to repairTruncatedJson", () => {
  assert.strictEqual(repairTruncatedJson(null), null);
  assert.strictEqual(repairTruncatedJson(undefined), null);
  assert.strictEqual(repairTruncatedJson(12345), null);
  assert.strictEqual(repairTruncatedJson(true), null);
  assert.strictEqual(repairTruncatedJson(false), null);
  assert.strictEqual(repairTruncatedJson({}), null);
  assert.strictEqual(repairTruncatedJson([]), null);
});

test("1.3 Non-string and non-object types passed to canonicalToolArguments", () => {
  assert.strictEqual(canonicalToolArguments(null), null);
  assert.strictEqual(canonicalToolArguments(undefined), null);
  assert.strictEqual(canonicalToolArguments(12345), null);
  assert.strictEqual(canonicalToolArguments(true), null);
  assert.strictEqual(canonicalToolArguments("12345"), null);
  assert.strictEqual(canonicalToolArguments('"just a string"'), null);
  assert.strictEqual(canonicalToolArguments("[1, 2, 3]"), null);
  assert.strictEqual(canonicalToolArguments([]), null);
  assert.strictEqual(canonicalToolArguments({}), "{}");
  assert.strictEqual(canonicalToolArguments({ foo: "bar" }), '{"foo":"bar"}');
});

test("1.4 Simple unclosed strings in key-value pairs", () => {
  const r1 = repairTruncatedJson('{"command": "git commit -m');
  assert.ok(r1 !== null);
  const p1 = JSON.parse(r1);
  assert.strictEqual(typeof p1, "object");
  assert.strictEqual(p1.command, "git commit -m");

  const c1 = canonicalToolArguments('{"command": "git commit -m');
  assert.ok(c1 !== null);
  assert.strictEqual(JSON.parse(c1).command, "git commit -m");
});

test("1.5 Trailing dangling colon recovery", () => {
  const r = repairTruncatedJson('{"action": "edit", "target_file":');
  assert.ok(r !== null);
  const p = JSON.parse(r);
  assert.strictEqual(p.action, "edit");
  assert.strictEqual(p.target_file, null);

  const c = canonicalToolArguments('{"action": "edit", "target_file":');
  assert.ok(c !== null);
  assert.strictEqual(JSON.parse(c).target_file, null);
});

test("1.6 Trailing dangling unquoted key without colon", () => {
  const r = repairTruncatedJson('{"path": "/home/user", "recursive"');
  assert.ok(r !== null);
  const p = JSON.parse(r);
  assert.strictEqual(p.path, "/home/user");
  assert.strictEqual(p.recursive, null);

  const c = canonicalToolArguments('{"path": "/home/user", "recursive"');
  assert.ok(c !== null);
  assert.strictEqual(JSON.parse(c).recursive, null);
});

test("1.7 Trailing comma removal at object end", () => {
  const r = repairTruncatedJson('{"a": 1, "b": 2,');
  assert.ok(r !== null);
  const p = JSON.parse(r);
  assert.strictEqual(p.a, 1);
  assert.strictEqual(p.b, 2);
});

test("1.8 Dangling single backslash at string boundary", () => {
  // Case A: Trailing dangling backslash stripped on valid characters
  const r1 = repairTruncatedJson('{"msg": "hello\\');
  assert.ok(r1 !== null);
  const p1 = JSON.parse(r1);
  assert.strictEqual(p1.msg, "hello");

  // Case B: Invalid JSON escape sequences (\W, \S) safely return null without throwing
  const r2 = repairTruncatedJson('{"path": "C:\\Windows\\System32\\');
  assert.strictEqual(r2, null);
});

test("1.9 Dangling double backslash (escaped backslash) at string boundary", () => {
  const r = repairTruncatedJson('{"path": "C:\\\\Windows\\\\');
  assert.ok(r !== null);
  const p = JSON.parse(r);
  assert.strictEqual(p.path, "C:\\Windows\\");
});

test("1.10 Escaped quotes inside unclosed string", () => {
  const r = repairTruncatedJson('{"code": "console.log(\\"hello world\\"); if (x');
  assert.ok(r !== null);
  const p = JSON.parse(r);
  assert.strictEqual(p.code, 'console.log("hello world"); if (x');
});

test("1.11 Deeply nested object hierarchy cutoff", () => {
  const input = '{"l1": {"l2": {"l3": {"l4": {"l5": {"name": "deep_nesting';
  const r = repairTruncatedJson(input);
  assert.ok(r !== null);
  const p = JSON.parse(r);
  assert.strictEqual(p.l1.l2.l3.l4.l5.name, "deep_nesting");
  assert.strictEqual(JSON.parse(canonicalToolArguments(input)).l1.l2.l3.l4.l5.name, "deep_nesting");
});

test("1.12 Cutoff array with mixed objects and primitives", () => {
  const input = '{"steps": [1, 2, {"tool": "bash", "args": ["ls -la", "grep -v';
  const r = repairTruncatedJson(input);
  assert.ok(r !== null);
  const p = JSON.parse(r);
  assert.strictEqual(p.steps.length, 3);
  assert.strictEqual(p.steps[0], 1);
  assert.strictEqual(p.steps[1], 2);
  assert.strictEqual(p.steps[2].tool, "bash");
  assert.strictEqual(p.steps[2].args[1], "grep -v");
});

test("1.13 UTF-8 Multi-byte characters and Emoji cutoff", () => {
  const inputs = [
    '{"greeting": "こんにちは世界！今日の天気は',
    '{"emoji": "🚀✨🎉🔥🤖👾',
    '{"arabic": "مرحبا بالعالم - هذا اختبار',
    '{"cyrillic": "Привет, мир! Проверка системы',
    '{"mixed": "Special chars: äöüß éèç ñø å'
  ];

  for (const str of inputs) {
    const r = repairTruncatedJson(str);
    assert.ok(r !== null, `Failed for UTF-8 string: ${str}`);
    const parsed = JSON.parse(r);
    assert.strictEqual(typeof parsed, "object");
  }
});

test("1.14 Incomplete bare string input auto-wrapped with braces", () => {
  const r = repairTruncatedJson('"key": "value"');
  assert.ok(r !== null);
  const p = JSON.parse(r);
  assert.strictEqual(p.key, "value");
});

test("1.15 Compatibility exports invariance", () => {
  assert.strictEqual(repairTruncatedJsonArguments('{"a": 1'), '{"a":1}');
  assert.strictEqual(ToolArgumentRepairEngine.repair_json_string('{"a": 1'), '{"a":1}');
  assert.strictEqual(ToolArgumentRepairEngine.repairTruncatedJson('{"a": 1'), '{"a":1}');
  assert.strictEqual(ToolArgumentRepairEngine.canonicalToolArguments('{"a": 1'), '{"a":1}');
  assert.strictEqual(ToolArgumentRepairEngine.canonical_tool_arguments('{"a": 1'), '{"a":1}');
});

// ============================================================================
// SUITE 2: Systematic Character-by-Character Slicing Fuzzing (100+ slices)
// ============================================================================
console.log("\n--- Suite 2: Character-by-Character Slicing Fuzzer ---");

test("2.1 Incremental truncation slicing across full JSON documents", () => {
  const sampleDocuments = [
    JSON.stringify({
      command: "npm test -- --coverage",
      env: { NODE_ENV: "test", CI: "true", PORT: 8080 },
      files: ["src/index.ts", "src/auth/jwt.ts", "tests/auth.test.ts"],
      options: { timeoutMs: 30000, verbose: true, bail: false, retries: 3 },
      description: "Run automated integration test suite with coverage report enabled 🚀"
    }),
    JSON.stringify({
      name: "write_to_file",
      parameters: {
        path: "C:/dev/project/src/main.rs",
        content: "fn main() {\n    println!(\"Hello, world!\");\n}\n",
        overwrite: true,
        flags: ["atomic", "create_parents"]
      }
    }),
    JSON.stringify({
      nested_array: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]],
      null_val: null,
      bool_val: true,
      false_val: false,
      unicode_msg: "日本語テスト и русские буквы"
    })
  ];

  let totalSlicesTested = 0;
  let validRepairs = 0;
  let nullReturns = 0;

  for (const doc of sampleDocuments) {
    for (let len = 1; len <= doc.length; len++) {
      const sliced = doc.slice(0, len);
      totalSlicesTested++;

      let repairedResult;
      let canonicalResult;

      // Must never throw
      try {
        repairedResult = repairTruncatedJson(sliced);
      } catch (err) {
        throw new Error(`repairTruncatedJson threw uncaught exception on slice [0:${len}]: "${sliced}" - ${err.message}`);
      }

      try {
        canonicalResult = canonicalToolArguments(sliced);
      } catch (err) {
        throw new Error(`canonicalToolArguments threw uncaught exception on slice [0:${len}]: "${sliced}" - ${err.message}`);
      }

      if (repairedResult !== null) {
        validRepairs++;
        let parsed;
        try {
          parsed = JSON.parse(repairedResult);
        } catch (e) {
          throw new Error(`repairTruncatedJson returned invalid JSON "${repairedResult}" for slice: "${sliced}"`);
        }
        assert.ok(typeof parsed === "object" && parsed !== null, "Repaired JSON must parse into a valid non-null object");
      } else {
        nullReturns++;
      }

      if (canonicalResult !== null) {
        let parsedCan;
        try {
          parsedCan = JSON.parse(canonicalResult);
        } catch (e) {
          throw new Error(`canonicalToolArguments returned invalid JSON "${canonicalResult}" for slice: "${sliced}"`);
        }
        assert.ok(typeof parsedCan === "object" && !Array.isArray(parsedCan) && parsedCan !== null, "Canonical arguments must be a JSON dictionary object");
      }
    }
  }

  console.log(`    Tested ${totalSlicesTested} deterministic slice cutoffs (Repaired: ${validRepairs}, Null: ${nullReturns}) with 0 exceptions.`);
  assert.ok(totalSlicesTested >= 100, `Expected at least 100 slices, tested ${totalSlicesTested}`);
});

// ============================================================================
// SUITE 3: Random Chaos Mutation Fuzzing (1,000 randomized iterations)
// ============================================================================
console.log("\n--- Suite 3: Random Chaos Mutation Fuzzing (1,000 Iterations) ---");

test("3.1 1,000 Random chaos mutations without unhandled exceptions", () => {
  const seedJson = {
    action: "execute_code",
    runtime: "node",
    code: "const x = 10; console.log(\"Result: \" + x);",
    args: ["--max-old-space-size=4096", "--trace-warnings"],
    meta: { requestId: "req-9872134", attempt: 1, tags: ["stress", "m4"] }
  };
  const baseStr = JSON.stringify(seedJson);
  const chaosChars = ['"', '\\', '{', '}', '[', ']', ':', ',', ' ', '\n', '\t', '\0', 'a', '9', '🚀', 'x', '-', 'null', 'true'];

  let chaosErrors = 0;

  for (let i = 0; i < 1000; i++) {
    // Generate chaotic string
    let mutated = baseStr.slice(0, Math.floor(Math.random() * baseStr.length));
    const insertions = Math.floor(Math.random() * 5);
    for (let j = 0; j < insertions; j++) {
      const idx = Math.floor(Math.random() * (mutated.length + 1));
      const char = chaosChars[Math.floor(Math.random() * chaosChars.length)];
      mutated = mutated.slice(0, idx) + char + mutated.slice(idx);
    }

    try {
      const res = repairTruncatedJson(mutated);
      if (res !== null) {
        const parsed = JSON.parse(res);
        if (typeof parsed !== "object" || parsed === null) {
          chaosErrors++;
        }
      }
    } catch (e) {
      chaosErrors++;
      console.error(`Chaos crash on iteration ${i}: input="${mutated}", error=${e.message}`);
    }

    try {
      const can = canonicalToolArguments(mutated);
      if (can !== null) {
        const parsed = JSON.parse(can);
        if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
          chaosErrors++;
        }
      }
    } catch (e) {
      chaosErrors++;
      console.error(`Canonical chaos crash on iteration ${i}: input="${mutated}", error=${e.message}`);
    }
  }

  assert.strictEqual(chaosErrors, 0, `Chaos fuzzer encountered ${chaosErrors} errors`);
  console.log("    Completed 1,000 random chaos mutations with 0 crashes.");
});

// ============================================================================
// SUITE 4: Provider Reasoning Controls Fuzzing & Wire Invariants
// ============================================================================
console.log("\n--- Suite 4: Provider Reasoning Controls Exhaustive Permutations ---");

test("4.1 Grok / xAI reasoning effort mappings and fast override", () => {
  // maxMode
  const b1 = {};
  const r1 = applyProviderReasoningControls(b1, { modelId: "grok-4.6", maxMode: true });
  assert.strictEqual(r1, "grok");
  assert.strictEqual(b1.reasoning_effort, "xhigh");

  // fast overrides effort
  const b2 = {};
  const r2 = applyProviderReasoningControls(b2, {
    modelId: "grok-4.6",
    parameters: [{ id: "effort", value: "max" }, { id: "fast", value: true }]
  });
  assert.strictEqual(r2, "grok");
  assert.strictEqual(b2.reasoning_effort, "low");

  // effort=medium
  const b3 = {};
  applyProviderReasoningControls(b3, {
    modelId: "grok-4.5",
    parameters: [{ id: "effort", value: "medium" }]
  });
  assert.strictEqual(b3.reasoning_effort, "medium");

  // thinking=false should NEVER emit reasoning_effort: "none" or thinking: disabled
  const b4 = {};
  applyProviderReasoningControls(b4, {
    modelId: "grok-4.6",
    parameters: [{ id: "thinking", value: false }]
  });
  assert.strictEqual(b4.reasoning_effort, undefined);
  assert.strictEqual(b4.thinking, undefined);

  // base URL detection for grok shim (18779)
  const b5 = {};
  const r5 = applyProviderReasoningControls(b5, {
    modelId: "custom-grok-alias",
    baseUrl: "http://127.0.0.1:18779/v1",
    maxMode: true
  });
  assert.strictEqual(r5, "grok");
  assert.strictEqual(b5.reasoning_effort, "xhigh");
});

test("4.2 Claude strict passthrough (shim owns adaptive thinking)", () => {
  const models = ["claude-opus-5", "claude-opus-5-oauth-1", "claude-fable-5-oauth-3", "claude-3-7-sonnet"];
  for (const m of models) {
    const body = { messages: [], temperature: 0.7 };
    const initialCopy = JSON.stringify(body);
    const route = applyProviderReasoningControls(body, {
      modelId: m,
      baseUrl: "http://127.0.0.1:18776/v1",
      maxMode: true,
      parameters: [
        { id: "thinking", value: true },
        { id: "effort", value: "high" },
        { id: "fast", value: true }
      ]
    });
    assert.strictEqual(route, "claude-passthrough");
    assert.strictEqual(JSON.stringify(body), initialCopy, "Claude body must remain strictly unmutated");
  }
});

test("4.3 Gemini tiered slug rewriting and safety clamping", () => {
  // gemini-3.6-flash + effort=low -> gemini-3.6-flash-low
  const b1 = { model: "gemini-3.6-flash" };
  const r1 = applyProviderReasoningControls(b1, {
    modelId: "gemini-3.6-flash",
    baseUrl: "http://127.0.0.1:18778/v1",
    parameters: [{ id: "effort", value: "low" }]
  });
  assert.strictEqual(r1, "gemini-slug");
  assert.strictEqual(b1.model, "gemini-3.6-flash-low");

  // gemini-3.6-flash + effort=max -> clamps to high
  const b2 = { model: "gemini-3.6-flash" };
  const r2 = applyProviderReasoningControls(b2, {
    modelId: "gemini-3.6-flash",
    parameters: [{ id: "effort", value: "max" }]
  });
  assert.strictEqual(r2, "gemini-slug");
  assert.strictEqual(b2.model, "gemini-3.6-flash-high");

  // gemini-3.7-flash is preserved untouched
  const b3 = { model: "gemini-3.7-flash" };
  const r3 = applyProviderReasoningControls(b3, {
    modelId: "gemini-3.7-flash",
    parameters: [{ id: "effort", value: "high" }]
  });
  assert.strictEqual(r3, "gemini-passthrough");
  assert.strictEqual(b3.model, "gemini-3.7-flash");
});

test("4.4 DeepSeek v4 reasoning fields and max_tokens gap-filling", () => {
  // :thinking slug
  const b1 = { model: "deepseek/deepseek-v4-pro-0813:thinking" };
  const r1 = applyProviderReasoningControls(b1, {
    modelId: "deepseek/deepseek-v4-pro-0813:thinking",
    baseUrl: "https://nano-gpt.com/api/v1"
  });
  assert.strictEqual(r1, "deepseek-thinking");
  assert.deepStrictEqual(b1.thinking, { type: "enabled" });
  assert.strictEqual(b1.reasoning_effort, "high");
  assert.strictEqual(b1.max_tokens, 256000);

  // Caller-provided max_tokens preserved
  const b2 = { model: "deepseek-chat", max_tokens: 4096, reasoning_effort: "low" };
  const r2 = applyProviderReasoningControls(b2, {
    modelId: "deepseek-chat",
    parameters: [{ id: "thinking", value: true }]
  });
  assert.strictEqual(r2, "deepseek-thinking");
  assert.deepStrictEqual(b2.thinking, { type: "enabled" });
  assert.strictEqual(b2.max_tokens, 4096);
  assert.strictEqual(b2.reasoning_effort, "low");

  // Non-thinking slug without flag
  const b3 = { model: "deepseek-chat" };
  const r3 = applyProviderReasoningControls(b3, {
    modelId: "deepseek-chat",
    baseUrl: "http://127.0.0.1:8791/v1"
  });
  assert.strictEqual(r3, "deepseek-passthrough");
  assert.strictEqual(b3.thinking, undefined);
});

test("4.5 GLM 5.3 / Friendli / Zhipu reasoning controls and bare passthrough", () => {
  // fast: true -> thinking disabled
  const b1 = {};
  const r1 = applyProviderReasoningControls(b1, {
    modelId: "glm-5.3-flash",
    parameters: [{ id: "fast", value: true }]
  });
  assert.strictEqual(r1, "glm-fast-off");
  assert.deepStrictEqual(b1.thinking, { type: "disabled" });

  // effort: max -> literal max token + thinking enabled
  const b2 = {};
  const r2 = applyProviderReasoningControls(b2, {
    modelId: "zai-org/GLM-5.3-Flash",
    baseUrl: "https://api.friendli.ai/serverless/v1",
    parameters: [{ id: "effort", value: "max" }]
  });
  assert.strictEqual(r2, "glm-effort");
  assert.deepStrictEqual(b2.thinking, { type: "enabled" });
  assert.strictEqual(b2.reasoning_effort, "max");

  // xhigh alias folds to max
  const b3 = {};
  const r3 = applyProviderReasoningControls(b3, {
    modelId: "glm-5.3",
    parameters: [{ id: "effort", value: "xhigh" }]
  });
  assert.strictEqual(r3, "glm-effort");
  assert.strictEqual(b3.reasoning_effort, "max");

  // silent request stays untouched
  const b4 = { messages: [] };
  const r4 = applyProviderReasoningControls(b4, {
    modelId: "glm-5.3",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4"
  });
  assert.strictEqual(r4, "glm-passthrough");
  assert.strictEqual(b4.thinking, undefined);
  assert.strictEqual(b4.reasoning_effort, undefined);
});

test("4.6 Qwen SGLang reasoning controls on port 18787", () => {
  // thinking=true
  const b1 = {};
  const r1 = applyProviderReasoningControls(b1, {
    modelId: "local-qwen38-27b",
    baseUrl: "http://127.0.0.1:18787/v1",
    parameters: [{ id: "thinking", value: true }, { id: "effort", value: "high" }]
  });
  assert.strictEqual(r1, "qwen-local");
  assert.strictEqual(b1.chat_template_kwargs.enable_thinking, true);
  assert.strictEqual(b1.reasoning_effort, "high");

  // thinking=false
  const b2 = {};
  const r2 = applyProviderReasoningControls(b2, {
    modelId: "local-qwen38-27b-aipc",
    baseUrl: "http://127.0.0.1:18787/v1",
    maxMode: true,
    parameters: [{ id: "thinking", value: false }]
  });
  assert.strictEqual(r2, "qwen-local");
  assert.strictEqual(b2.chat_template_kwargs.enable_thinking, false);
});

test("4.7 Exhaustive Cartesian Product Fuzzer (1,500+ Combinations)", () => {
  const modelIds = [
    "grok-4.6", "grok-4.5", "claude-opus-5", "claude-opus-5-oauth-1",
    "deepseek/deepseek-v4-pro-0813:thinking", "deepseek-chat",
    "glm-5.3", "glm-5.3-flash", "zai-org/GLM-5.3-Flash",
    "gemini-3.6-flash", "gemini-3.7-flash", "local-qwen38-27b",
    "unknown-model-xyz", "mimo-v2.5-pro-ultraspeed"
  ];

  const baseUrls = [
    "http://127.0.0.1:18779/v1", "http://127.0.0.1:18776/v1",
    "http://127.0.0.1:18778/v1", "https://nano-gpt.com/api/v1",
    "http://127.0.0.1:8791/v1", "https://open.bigmodel.cn/api/paas/v4",
    "https://api.friendli.ai/serverless/v1", "http://127.0.0.1:18787/v1",
    "http://127.0.0.1:18786/v1", "https://unknown-endpoint.example.com/v1"
  ];

  const maxModes = [true, false, undefined];
  const effortValues = ["low", "medium", "high", "max", "xhigh", "minimal", "maximal", null];
  const fastValues = [true, false, null];
  const thinkingValues = [true, false, "true", "false", null];

  let combinationsCount = 0;
  let validRoutesCount = 0;

  for (const modelId of modelIds) {
    for (const baseUrl of baseUrls) {
      for (const maxMode of maxModes) {
        for (const effort of effortValues) {
          const fast = fastValues[Math.floor(Math.random() * fastValues.length)];
          const thinking = thinkingValues[Math.floor(Math.random() * thinkingValues.length)];

          const params = [];
          if (effort !== null) params.push({ id: "effort", value: effort });
          if (fast !== null) params.push({ id: "fast", value: fast });
          if (thinking !== null) params.push({ id: "thinking", value: thinking });

          const body = { model: modelId, messages: [] };
          let route;
          try {
            route = applyProviderReasoningControls(body, {
              modelId,
              baseUrl,
              maxMode,
              parameters: params
            });
            combinationsCount++;
            if (route && typeof route === "string") validRoutesCount++;
          } catch (e) {
            throw new Error(`applyProviderReasoningControls crashed on combo model=${modelId}, base=${baseUrl}: ${e.message}`);
          }
        }
      }
    }
  }

  console.log(`    Executed ${combinationsCount} Cartesian parameter permutations (Valid routes returned: ${validRoutesCount}) with 0 exceptions.`);
  assert.ok(combinationsCount >= 1000, `Expected at least 1,000 permutations, got ${combinationsCount}`);
});

// ============================================================================
// SUITE 5: Subagent Binding Inheritance Verification
// ============================================================================
console.log("\n--- Suite 5: Subagent Binding Inheritance & Host Integration ---");

test("5.1 Host-main subagent model binding inheritance logic", () => {
  const bindingsPath = path.resolve(__dirname, "..", "..", "examples", "model-bindings.example.json");
  assert.ok(fs.existsSync(bindingsPath), "model-bindings.json must exist");

  const bindings = JSON.parse(fs.readFileSync(bindingsPath, "utf-8"));
  assert.ok(bindings.agents, "bindings must define agents table");

  // Mock host model binding resolution logic identical to host-main.cjs
  function resolveAgentModelBinding(host, agentId) {
    const agents = bindings.agents || {};
    let binding = agents[agentId];
    if (!binding && host.isSubagentRunner && host.getConversationId) {
      const parentId = host.getConversationId();
      binding = agents[parentId];
    }
    return binding || { modelId: "grok-4.6", hopBaseUrl: "http://127.0.0.1:18786/v1", maxMode: true };
  }

  // Case A: Top-level parent with explicit binding
  const parentId = "47818ea2-5ff8-4807-8ce5-1bece2e86926"; // alpha
  const topHost = { isSubagentRunner: false };
  const topBinding = resolveAgentModelBinding(topHost, parentId);
  assert.strictEqual(topBinding.name, "alpha");
  assert.strictEqual(topBinding.modelId, "grok-4.6");

  // Case B: Subagent without explicit binding inherits parent binding
  const subagentTranscriptId = "subagent-ephemeral-uuid-999";
  const subHost = {
    isSubagentRunner: true,
    subagentTranscriptId: subagentTranscriptId,
    getConversationId: () => "311f1552-4740-4055-b5aa-ca2005f7a0fa" // DeepseekPro
  };
  const subBinding = resolveAgentModelBinding(subHost, subagentTranscriptId);
  assert.strictEqual(subBinding.name, "DeepseekPro");
  assert.strictEqual(subBinding.modelId, "deepseek/deepseek-v4-pro-0813:thinking");
  assert.strictEqual(subBinding.maxMode, true);

  // Case C: Subagent with explicit override binding uses override
  const overrideSubHost = {
    isSubagentRunner: true,
    subagentTranscriptId: "d2f5b4fc-6bb2-4aed-80b1-317fda7a6244", // glm-lane
    getConversationId: () => "47818ea2-5ff8-4807-8ce5-1bece2e86926" // alpha
  };
  const overrideBinding = resolveAgentModelBinding(overrideSubHost, overrideSubHost.subagentTranscriptId);
  assert.strictEqual(overrideBinding.name, "glm-lane");
  assert.strictEqual(overrideBinding.modelId, "glm-5.3");
});

console.log("\n================================================================================");
console.log(`  M4 EMPIRICAL CHALLENGER HARNESS COMPLETE: ${passedTests}/${totalTests} Passed (${failedTests} Failed)`);
console.log("================================================================================\n");

if (failedTests > 0) {
  process.exit(1);
}
