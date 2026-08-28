"use strict";
/*
 * Unit tests for provider-maps.cjs — run: node test-provider-maps.cjs
 * Exit 0 = all pass. No framework; plain assert.
 * Regression block keeps the ORIGINAL 8 Grok behaviors green (they shipped first),
 * then covers the 2026-08-26 extension (claude/gemini/deepseek).
 */
var maps = require("./provider-maps.cjs");
var applyControls = maps.applyProviderReasoningControls;

var passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("PASS " + name); }
  catch (e) { failed++; console.log("FAIL " + name + " :: " + e.message); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg || "") + " expected=" + JSON.stringify(expected) + " actual=" + JSON.stringify(actual));
}
function deepEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || "") + "\n  expected=" + JSON.stringify(b) + "\n  actual=" + JSON.stringify(a));
}

// ---------- REGRESSION: Grok map (original ship, must stay green) ----------
check("grok: maxMode -> xhigh", function () {
  var b = {}; var label = applyControls(b, { modelId: "grok-4.6-superheavy", maxMode: true });
  eq(label, "grok"); eq(b.reasoning_effort, "xhigh");
});
check("grok: effort=max -> xhigh", function () {
  var b = {}; applyControls(b, { modelId: "grok-4.6", parameters: [{ id: "effort", value: "max" }] });
  eq(b.reasoning_effort, "xhigh");
});
check("grok: effort=medium -> medium", function () {
  var b = {}; applyControls(b, { modelId: "grok-4.5", parameters: [{ id: "effort", value: "medium" }] });
  eq(b.reasoning_effort, "medium");
});
check("grok: fast=true overrides effort -> low", function () {
  var b = {}; applyControls(b, { modelId: "grok-4.6", baseUrl: "http://127.0.0.1:18779/v1",
    parameters: [{ id: "effort", value: "high" }, { id: "fast", value: true }] });
  eq(b.reasoning_effort, "low");
});
check("grok: thinking param -> no-op, no field emitted", function () {
  var b = {}; applyControls(b, { modelId: "grok-4.6", parameters: [{ id: "thinking", value: "true" }] });
  eq(b.reasoning_effort, undefined);
});
check("grok: base-url detection when id lacks prefix", function () {
  var b = {}; var label = applyControls(b, { modelId: "whatever", baseUrl: "http://127.0.0.1:18779/v1", maxMode: true });
  eq(label, "grok"); eq(b.reasoning_effort, "xhigh");
});

// ---------- CLAUDE: strict pass-through ----------
check("claude: body NEVER mutated (shim owns wire state)", function () {
  var b = { model: "claude-opus-5-oauth-3", messages: [] };
  var label = applyControls(b, { modelId: "claude-opus-5-oauth-3", baseUrl: "http://127.0.0.1:18786/v1",
    maxMode: true, parameters: [{ id: "thinking", value: "true" }, { id: "effort", value: "max" }] });
  eq(label, "claude-passthrough");
  deepEq(Object.keys(b), ["model", "messages"], "claude body gained fields");
});
check("claude: -slug detection without port", function () {
  eq(maps.__test.isClaudeRoute("claude-fable-5-oauth-1", ""), true);
  eq(maps.__test.isClaudeRoute("mystery-model", "http://127.0.0.1:18776/v1"), true);
});

// ---------- GEMINI: tiered slug family ONLY ----------
check("gemini: 3.6-flash + effort=low -> slug rewrite", function () {
  var b = { model: "gemini-3.6-flash" };
  var label = applyControls(b, { modelId: "gemini-3.7-flash", baseUrl: "http://127.0.0.1:18778/v1",
    parameters: [{ id: "effort", value: "low" }] });
  eq(label, "gemini-slug"); eq(b.model, "gemini-3.6-flash-low");
});
check("gemini: effort=max clamps high (no invented tier)", function () {
  var b = { model: "gemini-3.6-flash" };
  applyControls(b, { modelId: "gemini-3.6-flash", baseUrl: "http://127.0.0.1:18778/v1",
    parameters: [{ id: "effort", value: "max" }] });
  eq(b.model, "gemini-3.6-flash-high");
});
check("gemini: 3.7-flash untouched (not a verified tiered family)", function () {
  var b = { model: "gemini-3.7-flash" };
  var label = applyControls(b, { modelId: "gemini-3.7-flash", baseUrl: "http://127.0.0.1:18778/v1",
    parameters: [{ id: "effort", value: "low" }] });
  eq(label, "gemini-passthrough"); eq(b.model, "gemini-3.7-flash");
});
check("gemini: fast=true leaves defaults (no verified fast slug)", function () {
  var b = { model: "gemini-3.6-flash" };
  var label = applyControls(b, { modelId: "gemini-3.6-flash", baseUrl: "http://127.0.0.1:18778/v1",
    parameters: [{ id: "fast", value: true }] });
  eq(label, "gemini-passthrough"); eq(b.model, "gemini-3.6-flash");
});

// ---------- DEEPSEEK: Harness wire shape ----------
check("deepseek: :thinking slug -> enabled+high+256k", function () {
  var b = { model: "deepseek/deepseek-v4-pro-0813:thinking", messages: [] };
  var label = applyControls(b, { modelId: "deepseek/deepseek-v4-pro-0813:thinking",
    baseUrl: "https://nano-gpt.com/api/v1", parameters: [] });
  eq(label, "deepseek-thinking");
  deepEq(b.thinking, { type: "enabled" });
  eq(b.reasoning_effort, "high"); eq(b.max_tokens, 256000);
});
check("deepseek: caller max_tokens preserved (only fill gaps)", function () {
  var b = { model: "x", max_tokens: 4096 };
  maps.__test.applyDeepSeek(b, "deepseek/deepseek-v4-flash-0731:thinking", []);
  eq(b.max_tokens, 4096);
});
check("deepseek: harness thinking=true flips non-slug id too", function () {
  var b = {};
  applyControls(b, { modelId: "deepseek/deepseek-v4-pro", parameters: [{ id: "thinking", value: "true" }] });
  deepEq(b.thinking, { type: "enabled" });
});
check("deepseek: non-thinking slug + no flag -> untouched", function () {
  var b = { model: "deepseek/deepseek-v4-pro" };
  var label = applyControls(b, { modelId: "deepseek/deepseek-v4-pro", parameters: [] });
  eq(label, "deepseek-passthrough");
  eq(b.thinking, undefined); eq(b.max_tokens, undefined);
});

// ---------- STUBS stay stubs ----------
check("unknown routes (mimo/qwen/hermes-agent) -> none, body clean", function () {
  var ids = ["mimo-v2.5-pro-ultraspeed", "qwen3.8-max", "local-qwen38-27b", "hermes-agent"];
  ids.forEach(function (id) {
    var b = {}; var label = applyControls(b, { modelId: id, maxMode: true,
      parameters: [{ id: "effort", value: "max" }, { id: "thinking", value: "true" }] });
    eq(label, "none", "route " + id); deepEq({}, b, "body for " + id);
  });
});

// ---------- GLM: minimal-intervention map (wire-verified 2026-08-27) ----------
check("glm: fast=true -> REAL off switch (thinking disabled)", function () {
  var b = { model: "glm-5.3-flash" };
  var label = applyControls(b, { modelId: "glm-5.3-flash",
    parameters: [{ id: "fast", value: "true" }] });
  eq(label, "glm-fast-off");
  deepEq(b.thinking, { type: "disabled" });
});
check("glm: effort=max -> literal max token + thinking enabled", function () {
  var b = { model: "glm-5.3" };
  var label = applyControls(b, { modelId: "glm-5.3",
    parameters: [{ id: "effort", value: "max" }] });
  eq(label, "glm-effort");
  deepEq(b.thinking, { type: "enabled" });
  eq(b.reasoning_effort, "max");
});
check("glm: xhigh alias folds to max (GLM has no xhigh)", function () {
  var b = {};
  maps.__test.applyGlm(b, [{ id: "effort", value: "xhigh" }]);
  eq(b.reasoning_effort, "max");
});
check("glm: caller-set fields NEVER overridden (gap-fill only)", function () {
  var b = { reasoning_effort: "low", thinking: { type: "enabled" } };
  applyControls(b, { modelId: "glm-5.3", parameters: [{ id: "effort", value: "max" }] });
  eq(b.reasoning_effort, "low"); // caller wins
});
check("glm: SILENT request stays byte-untouched (bare wire already native)", function () {
  var b = { model: "glm-5.3-flash", messages: [] };
  var label = applyControls(b, { modelId: "glm-5.3-flash", parameters: [] });
  eq(label, "glm-passthrough");
  deepEq(Object.keys(b), ["model", "messages"], "silent glm body gained fields");
});
check("glm: base-url detection via bigmodel.cn", function () {
  eq(maps.__test.isGlmRoute("some-slug", "https://open.bigmodel.cn/api/coding/paas/v4"), true);
});

var CLIPROXY = "http://127.0.0.1:8317/v1";
var CLIPROXY_FAMILY_IDS = ["claude-opus-5-oauth-3", "grok-4.6-superheavy", "gemini-3-flash"];

check("cliproxy: family modelIds on :8317 -> cliproxy-passthrough, body byte-identical", function () {
  CLIPROXY_FAMILY_IDS.forEach(function (id) {
    var b = { model: id, messages: [] };
    var before = JSON.stringify(b);
    var label = applyControls(b, {
      modelId: id,
      baseUrl: CLIPROXY,
      maxMode: true,
      parameters: [
        { id: "effort", value: "high" },
        { id: "thinking", value: "false" },
        { id: "fast", value: "true" },
      ],
    });
    eq(label, "cliproxy-passthrough", "label for " + id);
    eq(JSON.stringify(b), before, "body mutated for " + id);
    eq(b.reasoning_effort, undefined, "no reasoning_effort for " + id);
    eq(b.thinking, undefined, "no thinking for " + id);
  });
});

check("cliproxy: same modelIds on family ports still take family routes", function () {
  var bClaude = { model: "claude-opus-5-oauth-3", messages: [] };
  eq(applyControls(bClaude, {
    modelId: "claude-opus-5-oauth-3",
    baseUrl: "http://127.0.0.1:18776/v1",
    parameters: [{ id: "effort", value: "high" }],
  }), "claude-passthrough");

  var bGrok = {};
  eq(applyControls(bGrok, {
    modelId: "grok-4.6-superheavy",
    baseUrl: "http://127.0.0.1:18779/v1",
    maxMode: true,
  }), "grok");
  eq(bGrok.reasoning_effort, "xhigh");

  var bGem = { model: "gemini-3.7-flash" };
  eq(applyControls(bGem, {
    modelId: "gemini-3.7-flash",
    baseUrl: "http://127.0.0.1:18778/v1",
    parameters: [{ id: "effort", value: "low" }],
  }), "gemini-passthrough");
});

check("cliproxy: unmatched slug on :8317 -> cliproxy-passthrough, body clean", function () {
  var b = { model: "mystery-slug-xyz", messages: [] };
  var before = JSON.stringify(b);
  var label = applyControls(b, {
    modelId: "mystery-slug-xyz",
    baseUrl: CLIPROXY,
    parameters: [{ id: "effort", value: "max" }],
  });
  eq(label, "cliproxy-passthrough");
  eq(JSON.stringify(b), before);
});

check("cliproxy: effort/thinking/fast on :8317 must NOT inject fields", function () {
  var b = {};
  applyControls(b, {
    modelId: "gemini-3-flash",
    baseUrl: CLIPROXY,
    maxMode: true,
    parameters: [
      { id: "effort", value: "xhigh" },
      { id: "thinking", value: "disabled" },
      { id: "fast", value: true },
    ],
  });
  deepEq(b, {});
});

check("cliproxy: isCliproxyRoute detects :8317 only", function () {
  eq(maps.__test.isCliproxyRoute(CLIPROXY), true);
  eq(maps.__test.isCliproxyRoute("http://127.0.0.1:18776/v1"), false);
});

console.log("\n" + passed + "/" + (passed + failed) + " pass, " + failed + " fail");
process.exit(failed ? 1 : 0);
