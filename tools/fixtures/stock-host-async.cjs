"use strict";
async function createProtoSession(opts) {
  return { kind: "proto", model: (opts && opts.modelId) || "none" };
}
function ping() {
  return createProtoSession({ modelId: "stock-model" });
}
module.exports = { ping, createProtoSession };
