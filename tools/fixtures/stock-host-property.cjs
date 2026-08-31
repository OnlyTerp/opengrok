"use strict";
const factories = {
  createProtoSession: function (opts) {
    return { kind: "proto", model: (opts && opts.modelId) || "none" };
  },
};
function ping() {
  return factories.createProtoSession({ modelId: "stock-model" });
}
module.exports = { ping, factories };
