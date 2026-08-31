"use strict";
function createProtoSession2(opts) {
  return { kind: "proto", model: (opts && opts.modelId) || "none" };
}
function ping() {
  return createProtoSession2({ modelId: "stock-model" });
}
module.exports = { ping, createProtoSession2 };
