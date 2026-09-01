"use strict";
var assert = require("assert");
var rt = require("./opengrok-runtime.cjs");
var h = rt._testHooks;

function hasMeaningfulContentPart(part) {
  if (part.type === "text") return part.text.trim().length > 0;
  if (part.type === "reasoning") return part.text.trim().length > 0;
  return part.type === "tool-call" || part.type === "file";
}

// GLM sometimes emits tool calls as embedded JSON objects in the text stream.
var embedded = h.extractEmbeddedStreamJson(
  '{"type":"tool-call","toolName":"SendToUser","args":{"type":"text","content":"hi"}}'
);
assert.equal(embedded.calls.length, 1);
assert.equal(embedded.calls[0].function.name, "SendToUser");
assert.equal(embedded.text, "");

var mixed = h.extractEmbeddedStreamJson(
  'hello {"type":"reasoning","text":"think"} {"type":"tool-call","toolName":"send_message","args":{"x":1}}'
);
assert.equal(mixed.text, "hello");
assert.equal(mixed.reasoning, "think");
assert.equal(mixed.calls.length, 1);
assert.equal(mixed.calls[0].function.name, "SendToUser");

// Host treats text-only assistant responses as empty when tools were expected.
var content = h.buildAssistantResponseContent(
  { reasoning_content: "chain" },
  "visible",
  [{ id: "c1", function: { name: "SendToUser", arguments: '{"type":"text","content":"ok"}' } }]
);
assert.ok(Array.isArray(content));
assert.equal(content.filter(function (p) { return p.type === "reasoning"; }).length, 1);
assert.equal(content.filter(function (p) { return p.type === "text"; }).length, 1);
assert.equal(content.filter(function (p) { return p.type === "tool-call"; }).length, 1);
assert.ok(content.every(hasMeaningfulContentPart));

// Round-trip assistant tool history into OpenAI wire shape.
var msgs = h.toOpenAIMessages([
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "tc1", toolName: "SendToUser", args: { type: "text", content: "x" } },
    ],
  },
  { role: "tool", toolCallId: "tc1", content: [{ type: "tool-result", result: "done" }] },
]);
assert.equal(msgs.length, 2);
assert.equal(msgs[0].role, "assistant");
assert.ok(Array.isArray(msgs[0].tool_calls));
assert.equal(msgs[0].tool_calls[0].function.name, "SendToUser");
assert.equal(msgs[1].role, "tool");
assert.equal(msgs[1].tool_call_id, "tc1");
assert.equal(msgs[1].content, "done");

var effortBinding = {
  parameters: [{ id: "effort", value: "high" }],
  effortWhen: {
    medium: ["run_native_sot", "post_screen.py", "backtest_results"],
  },
};
var researchParams = h.resolveParametersForTurn(effortBinding, [
  { role: "user", content: "read LEDGER.tsv and mills.yaml" },
]);
var analyzeParams = h.resolveParametersForTurn(effortBinding, [
  { role: "user", content: "now run_native_sot.py with the session config" },
]);
assert.equal(researchParams.filter(function (p) { return p.id === "effort"; })[0].value, "high");
assert.equal(analyzeParams.filter(function (p) { return p.id === "effort"; })[0].value, "medium");

var compaction = h.compactionConfig({
  contextWindow: 131072,
  compactionFraction: 0.9,
  earlyCompactionFraction: 0.9,
  supportsSelfSummary: true,
});
assert.equal(compaction.compactionThreshold, 117964);
assert.equal(compaction.earlyCompactionThreshold, 117964);
assert.equal(compaction.supportsSelfSummary, true);

var cache = h.extractUsageExtras({
  prompt_tokens: 1000,
  prompt_tokens_details: { cached_tokens: 900, cache_creation_input_tokens: 50 },
});
assert.equal(cache.cacheReadTokens, 900);
assert.equal(cache.cacheWriteTokens, 50);

console.log("opengrok-runtime: ok");
