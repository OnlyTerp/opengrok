"use strict";
/* The hop-lane contract test suite. Originally contract tests: applyHarnessControls(input) -> {body, route, applied, unknownIds}
 * Source of truth: provider-maps-v2.cjs (the LIVE box maps, GLM-upgraded 2026-08-27). */
const maps = require("./provider-maps-hop.cjs");
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("PASS " + name); }
  catch (e) { failed++; console.log("FAIL " + name + " :: " + e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "eq") + ": got " + JSON.stringify(a) + " want " + JSON.stringify(b)); }
function deepEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || "deepEq") + ": got " + JSON.stringify(a) + " want " + JSON.stringify(b)); }

check("hop-glm: fast -> thinking disabled off-switch", function () {
  const r = maps.applyHarnessControls({ modelId: "glm-5.3", maxMode: false,
    parameters: [{ id: "fast", value: "true" }], body: { model: "glm-5.3", messages: [] } });
  deepEq(r.body.thinking, { type: "disabled" });
  eq(r.route, "glm-coding-plan");
});
check("hop-glm: effort xhigh folds to max + thinking enabled", function () {
  const r = maps.applyHarnessControls({ modelId: "glm-5.3", maxMode: true,
    parameters: [{ id: "effort", value: "xhigh" }], body: { model: "glm-5.3", messages: [] } });
  eq(r.body.reasoning_effort, "max");
  deepEq(r.body.thinking, { type: "enabled" });
});
check("hop-glm: bare request untouched (minimal intervention)", function () {
  const r = maps.applyHarnessControls({ modelId: "glm-5.3", parameters: [], body: { model: "glm-5.3", messages: [] } });
  eq(r.body.reasoning_effort, undefined);
  eq(r.body.thinking, undefined);
});
check("hop-glm: caller-set effort preserved (gap-fill only)", function () {
  const r = maps.applyHarnessControls({ modelId: "glm-5.3",
    parameters: [{ id: "effort", value: "max" }], body: { model: "glm-5.3", messages: [], reasoning_effort: "low" } });
  eq(r.body.reasoning_effort, "low");
});
check("hop-route table: known slugs route correctly", function () {
  eq(maps.routeNameForModel("grok-4.6", "windows-shim"), "grok-superheavy");
  eq(maps.routeNameForModel("glm-5.3", "zai"), "glm-coding-plan");
  eq(maps.routeNameForModel("deepseek/deepseek-v4-pro-0813", "nano-gpt"), "nano-gpt");
});
check("hop-claude: shim-owned thinking; effort passes as reasoning_effort (live behavior)", function () {
  const r = maps.applyHarnessControls({ modelId: "claude-opus-5-oauth-3", maxMode: true,
    parameters: [{ id: "thinking", value: "true" }, { id: "effort", value: "high" }],
    body: { model: "claude-opus-5-oauth-3", messages: [] } });
  eq(r.route, "claude-plans");
  eq(r.body.reasoning_effort, "high", "explicit effort passes through (shim accepts it)");
  eq(r.applied.wire.thinking.status, "shim-owned", "thinking never body-painted");
});

console.log("");
console.log(passed + "/" + (passed + failed) + " hop-pass, " + failed + " fail");
process.exit(failed ? 1 : 0);
