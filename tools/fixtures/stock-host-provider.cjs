"use strict";
function createProtoSessionProvider(client, requestedModel, modelConfig, inferenceReason) {
  return {
    getSession: function () {
      return {
        getExecutor: function () {
          return {
            getMessages: function () {
              return [{ role: "user", content: "hi" }];
            },
            stream: function () {
              throw new Error("stock stream must not run");
            },
          };
        },
        getModelId: function () {
          return (requestedModel && requestedModel.modelId) || "none";
        },
      };
    },
    getProviderName: function () { return "proto"; },
    getModelId: function () {
      return (requestedModel && requestedModel.modelId) || "none";
    },
    getThinkingDetails: function () { return undefined; },
  };
}
function ping() {
  const client = { kind: "cursor-backend" };
  const options2 = { requestedModel: { modelId: "stock-model" }, inferenceReason: "chat" };
  return createProtoSessionProvider(
    client,
    options2.requestedModel,
    void 0,
    options2.inferenceReason
  );
}
module.exports = { ping, createProtoSessionProvider };
