"use strict";
var fs = require("fs");
var hop = require("./openai-hop-session.cjs");

var BINDINGS = process.env.OPENGROK_BINDINGS || "/home/box/sand-data/model-bindings.json";
var LOG = process.env.OPENGROK_LOG || "/tmp/opengrok-session.log";

var DEFAULT_CONTEXT_WINDOW = (function () {
  var n = parseInt(process.env.OPENGROK_CONTEXT_WINDOW || "131072", 10);
  return n > 0 ? n : 131072;
})();
var DEFAULT_COMPACTION_FRACTION = (function () {
  var n = parseFloat(process.env.OPENGROK_COMPACTION_FRACTION || "0.9");
  return n > 0 && n <= 1 ? n : 0.9;
})();
var DEFAULT_EARLY_COMPACTION_FRACTION = (function () {
  var n = parseFloat(process.env.OPENGROK_EARLY_COMPACTION_FRACTION || "0.9");
  return n > 0 && n <= 1 ? n : 0.9;
})();

function compactionConfig(binding) {
  var ctxWin = binding && binding.contextWindow;
  if (typeof ctxWin !== "number" || !Number.isFinite(ctxWin) || ctxWin <= 0) {
    ctxWin = DEFAULT_CONTEXT_WINDOW;
  }
  var compFrac = binding && binding.compactionFraction;
  if (typeof compFrac !== "number" || !Number.isFinite(compFrac) || compFrac <= 0 || compFrac > 1) {
    compFrac = DEFAULT_COMPACTION_FRACTION;
  }
  var earlyFrac = binding && binding.earlyCompactionFraction;
  if (typeof earlyFrac !== "number" || !Number.isFinite(earlyFrac) || earlyFrac <= 0 || earlyFrac > 1) {
    earlyFrac = DEFAULT_EARLY_COMPACTION_FRACTION;
  }
  var supports = binding && binding.supportsSelfSummary === false ? false : true;
  return {
    contextWindow: ctxWin,
    compactionThreshold: Math.floor(ctxWin * compFrac),
    earlyCompactionThreshold: Math.floor(ctxWin * earlyFrac),
    supportsSelfSummary: supports,
  };
}

function extractUsageExtras(rawUsage) {
  var cacheRead = 0;
  var cacheWrite = 0;
  if (rawUsage && typeof rawUsage === "object") {
    var details = rawUsage.prompt_tokens_details;
    if (details && typeof details === "object") {
      if (typeof details.cached_tokens === "number" && details.cached_tokens > 0) {
        cacheRead = details.cached_tokens;
      }
      if (typeof details.cache_creation_input_tokens === "number" && details.cache_creation_input_tokens > 0) {
        cacheWrite = details.cache_creation_input_tokens;
      }
    }
  }
  return { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

function log(line) {
  try {
    fs.appendFileSync(LOG, new Date().toISOString() + " " + line + "\n");
  } catch (e) {
    /* ignore */
  }
}

function collectIds(args) {
  var ids = [];
  var seen = Object.create(null);
  function add(s) {
    if (typeof s !== "string") return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return;
    var k = s.toLowerCase();
    if (seen[k]) return;
    seen[k] = true;
    ids.push(s);
  }
  function walk(v, depth) {
    if (depth > 5 || v == null) return;
    if (typeof v === "string") { add(v); return; }
    if (typeof v !== "object") return;
    var keys = ["conversationId", "agentId", "id", "provenanceAgentId", "botId"];
    for (var i = 0; i < keys.length; i++) {
      if (v[keys[i]] != null) walk(v[keys[i]], depth + 1);
    }
  }
  for (var i = 0; i < args.length; i++) walk(args[i], 0);
  return ids;
}

function loadAgents() {
  var raw = fs.readFileSync(BINDINGS, "utf8");
  var data = JSON.parse(raw);
  return (data && data.agents) || {};
}

function resolveBinding(args) {
  var agents;
  try {
    agents = loadAgents();
  } catch (e) {
    log("bindings unreadable: " + e.message);
    return null;
  }
  var ids = collectIds(args);
  var match = null;
  for (var i = 0; i < ids.length; i++) {
    if (agents[ids[i]]) {
      match = agents[ids[i]];
      break;
    }
  }
  if (!match && agents["*"]) match = agents["*"];
  if (!match) return null;
  var star = agents["*"];
  if (!star || star === match) return match;
  var merged = {};
  var keys = Object.keys(star);
  for (var k = 0; k < keys.length; k++) merged[keys[k]] = star[keys[k]];
  keys = Object.keys(match);
  for (var j = 0; j < keys.length; j++) merged[keys[j]] = match[keys[j]];
  return merged;
}

function requestedModelId(args) {
  var req = args && args[1];
  if (req && typeof req.modelId === "string") return req.modelId;
  if (req && req.modelId && typeof req.modelId.modelId === "string") return req.modelId.modelId;
  return "";
}

function cloneParameters(params) {
  if (!Array.isArray(params)) return [];
  return params.map(function (p) {
    if (!p || typeof p !== "object") return p;
    return { id: p.id, value: p.value };
  });
}

function setParamValue(params, id, value) {
  var out = cloneParameters(params);
  var replaced = false;
  for (var i = 0; i < out.length; i++) {
    if (out[i] && out[i].id === id) {
      out[i] = { id: id, value: value };
      replaced = true;
    }
  }
  if (!replaced) out.push({ id: id, value: value });
  return out;
}

function matchesEffortWhen(messages, patterns) {
  if (!Array.isArray(patterns) || !patterns.length) return false;
  var tail = Array.isArray(messages) ? messages.slice(-10) : [];
  var blob = JSON.stringify(tail).toLowerCase();
  for (var i = 0; i < patterns.length; i++) {
    var p = String(patterns[i]).toLowerCase();
    if (p && blob.indexOf(p) >= 0) return true;
  }
  return false;
}

function resolveParametersForTurn(binding, messages) {
  var base = cloneParameters(binding && binding.parameters);
  var effortWhen = binding && binding.effortWhen;
  if (!effortWhen || typeof effortWhen !== "object") return base;
  var keys = Object.keys(effortWhen);
  for (var k = 0; k < keys.length; k++) {
    var effort = keys[k];
    var patterns = effortWhen[effort];
    if (matchesEffortWhen(messages, patterns)) {
      log("effortWhen -> effort=" + effort + " (patterns matched in tail context)");
      return setParamValue(base, "effort", effort);
    }
  }
  return base;
}

function dumpProto(stock) {
  var proto = stock && typeof stock === "object" ? Object.getPrototypeOf(stock) : null;
  var own = stock && typeof stock === "object" ? Object.getOwnPropertyNames(stock) : [];
  var protoKeys = proto && proto !== Object.prototype ? Object.getOwnPropertyNames(proto) : [];
  fs.writeFileSync("/tmp/opengrok-proto-keys.json", JSON.stringify({
    type: typeof stock,
    ctor: stock && stock.constructor && stock.constructor.name,
    own: own,
    proto: protoKeys,
  }, null, 2));
}

function swallow(p) {
  Promise.resolve(p).catch(function () {});
  return p;
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  var bits = [];
  for (var i = 0; i < content.length; i++) {
    var p = content[i];
    if (p == null) continue;
    if (typeof p === "string") bits.push(p);
    else if (p.type === "text") bits.push(p.text || "");
    else if (p.type === "image") bits.push("[image]");
    else if (p.type === "tool-result") bits.push(typeof p.result === "string" ? p.result : JSON.stringify(p.result || p));
    else bits.push(JSON.stringify(p));
  }
  return bits.join("\n");
}

function toolParamsToJsonSchema(params) {
  if (params == null) return { type: "object", properties: {} };
  if (typeof params === "object" && params.jsonSchema && typeof params.jsonSchema === "object") {
    return params.jsonSchema;
  }
  return params;
}

function parseToolCallArgs(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw || "{}"); } catch (e) { return {}; }
  }
  return {};
}

function stringifyToolCallArgs(args) {
  if (args == null) return "{}";
  if (typeof args === "string") return args;
  try { return JSON.stringify(args); } catch (e) { return "{}"; }
}

function assistantContentToOpenAI(content) {
  var textParts = [];
  var reasoningParts = [];
  var toolCalls = [];
  if (typeof content === "string") {
    if (content) textParts.push(content);
  } else if (Array.isArray(content)) {
    for (var i = 0; i < content.length; i++) {
      var p = content[i];
      if (!p || typeof p !== "object") continue;
      if (p.type === "text") textParts.push(p.text || "");
      else if (p.type === "reasoning") reasoningParts.push(p.text || "");
      else if (p.type === "tool-call") {
        toolCalls.push({
          id: p.toolCallId || ("call_hist_" + toolCalls.length),
          type: "function",
          function: {
            name: normalizeHopToolName(p.toolName || ""),
            arguments: stringifyToolCallArgs(p.args),
          },
        });
      }
    }
  } else if (content != null) {
    textParts.push(contentToText(content));
  }
  var text = textParts.join("\n");
  if (!text && reasoningParts.length) text = reasoningParts.join("\n");
  return { text: text, toolCalls: toolCalls };
}

function toolMessageToOpenAI(m) {
  var text = "";
  var toolCallId = m.toolCallId || "";
  var content = m.content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (var i = 0; i < content.length; i++) {
      var p = content[i];
      if (!p || typeof p !== "object") continue;
      if (p.type === "tool-result") {
        if (!toolCallId && p.toolCallId) toolCallId = p.toolCallId;
        var r = p.result;
        text = typeof r === "string" ? r : JSON.stringify(r != null ? r : "");
      } else if (p.type === "text") {
        text += p.text || "";
      }
    }
  } else if (content != null) {
    text = contentToText(content);
  }
  return { role: "tool", content: text, tool_call_id: toolCallId };
}

function toOpenAIMessages(msgs) {
  if (!Array.isArray(msgs)) return [{ role: "user", content: String(msgs || "") }];
  var out = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i] || {};
    var role = m.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") role = "user";
    if (role === "tool") {
      out.push(toolMessageToOpenAI(m));
      continue;
    }
    if (role === "assistant") {
      var parsed = assistantContentToOpenAI(m.content);
      var row = { role: "assistant", content: parsed.text || null };
      if (parsed.toolCalls.length) row.tool_calls = parsed.toolCalls;
      else if (Array.isArray(m.tool_calls)) row.tool_calls = m.tool_calls;
      out.push(row);
      continue;
    }
    out.push({ role: role, content: contentToText(m.content) });
  }
  return out.length ? out : [{ role: "user", content: "" }];
}

function toOpenAITools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  var out = [];
  for (var i = 0; i < tools.length; i++) {
    var t = tools[i];
    if (!t || t.type === "provider-defined") continue;
    var fn = t.function || t;
    var name = t.name || fn.name;
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name: name,
        description: t.description || fn.description || "",
        parameters: toolParamsToJsonSchema(t.parameters || fn.parameters),
      },
    });
  }
  return out.length ? out : undefined;
}

function normalizeHopToolName(name) {
  if (!name) return "";
  var n = String(name);
  if (n === "send_message" || n === "SendMessage" || n === "Send_Message") return "SendToUser";
  return n;
}

function parseHopToolCall(c, i) {
  var fn = (c && c.function) || {};
  var args = parseToolCallArgs(fn.arguments);
  return {
    type: "tool-call",
    toolCallId: c.id || ("call_" + i),
    toolName: normalizeHopToolName(fn.name || ""),
    args: args,
  };
}

function tryParseJsonObject(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function openAiCallFromEmbedded(obj, i) {
  var args = obj.args || obj.arguments || {};
  return {
    id: obj.toolCallId || obj.tool_call_id || ("call_embed_" + i),
    function: {
      name: normalizeHopToolName(obj.toolName || obj.tool_name || ""),
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}

function extractEmbeddedStreamJson(text) {
  var reasoning = "";
  var calls = [];
  var plain = [];
  if (!text) return { text: "", reasoning: "", calls: [] };

  var i = 0;
  while (i < text.length) {
    if (text.charAt(i) === "{") {
      var depth = 0;
      var start = i;
      var inStr = false;
      var esc = false;
      for (; i < text.length; i++) {
        var ch = text.charAt(i);
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      var slice = text.slice(start, i);
      var obj = tryParseJsonObject(slice.trim());
      if (obj && obj.type === "tool-call" && (obj.toolName || obj.tool_name)) {
        calls.push(openAiCallFromEmbedded(obj, calls.length));
        continue;
      }
      if (obj && obj.type === "reasoning" && obj.text) {
        reasoning += obj.text;
        continue;
      }
      if (obj && obj.type === "text" && obj.text) {
        plain.push(obj.text);
        continue;
      }
      plain.push(slice);
      continue;
    }
    var next = text.indexOf("{", i);
    if (next === -1) {
      plain.push(text.slice(i));
      break;
    }
    plain.push(text.slice(i, next));
    i = next;
  }
  return { text: plain.join("").trim(), reasoning: reasoning, calls: calls };
}

function normalizeApiToolCalls(calls) {
  if (!Array.isArray(calls)) return [];
  for (var i = 0; i < calls.length; i++) {
    var c = calls[i];
    if (c && c.function && c.function.name) {
      c.function.name = normalizeHopToolName(c.function.name);
    }
  }
  return calls;
}

function buildAssistantResponseContent(out, text, calls) {
  var content = [];
  if (out && out.reasoning_content) {
    content.push({ type: "reasoning", text: out.reasoning_content });
  }
  if (text) {
    content.push({ type: "text", text: text });
  }
  for (var i = 0; i < calls.length; i++) {
    content.push(parseHopToolCall(calls[i], i));
  }
  return content.length ? content : "";
}

function hopFullStream(exec, hopSess, binding, compaction, ctx, invocationId, tools, options2) {
  var settled = { u: false, e: false, m: false, i: false, r: false };
  var resU, rejU, resE, rejE, resM, rejM, resI, rejI, resR, rejR;
  var usage = swallow(new Promise(function (res, rej) { resU = res; rejU = rej; }));
  var extendedUsage = swallow(new Promise(function (res, rej) { resE = res; rejE = rej; }));
  var providerMetadata = swallow(new Promise(function (res, rej) { resM = res; rejM = rej; }));
  var inv = swallow(new Promise(function (res, rej) { resI = res; rejI = rej; }));
  var response = swallow(new Promise(function (res, rej) { resR = res; rejR = rej; }));

  function failAll(err) {
    if (!settled.u) { settled.u = true; rejU(err); }
    if (!settled.e) { settled.e = true; rejE(err); }
    if (!settled.m) { settled.m = true; rejM(err); }
    if (!settled.i) { settled.i = true; rejI(err); }
    if (!settled.r) { settled.r = true; rejR(err); }
  }
  function okUsage(u) {
    if (!settled.u) { settled.u = true; resU(u); }
    if (!settled.e) {
      settled.e = true;
      resE({
        inputTokens: u.promptTokens || 0,
        outputTokens: u.completionTokens || 0,
        cacheReadTokens: u.cacheReadTokens || 0,
        cacheWriteTokens: u.cacheWriteTokens || 0,
        maxTokens: compaction.contextWindow,
      });
    }
    if (!settled.m) { settled.m = true; resM(undefined); }
    if (!settled.i) { settled.i = true; resI(invocationId || (crypto.randomUUID && crypto.randomUUID()) || "opengrok"); }
  }

  var abortListener = null;
  if (ctx && ctx.signal && !ctx.signal.aborted) {
    abortListener = function () { hopSess.abort(); };
    ctx.signal.addEventListener("abort", abortListener);
  }

  var fullStream = (async function* () {
    var debugId = "turn-" + Date.now().toString(36);
    try {
      if (ctx && ctx.signal && ctx.signal.aborted) {
        throw new Error("openai-hop-session: aborted");
      }
      var msgs = typeof exec.getMessages === "function" ? exec.getMessages() : [];
      var turn = {
        messages: toOpenAIMessages(msgs),
        tools: toOpenAITools(tools),
        max_tokens: (options2 && options2.maxTokens != null) ? options2.maxTokens : 8192,
      };
      hopSess.parameters = resolveParametersForTurn(binding, turn.messages);
      log("stream messages=" + turn.messages.length + " tools=" + ((turn.tools && turn.tools.length) || 0));
      log("[opengrok-debug] stream start " + debugId + " inMsgs=" + turn.messages.length + " tools=" + ((turn.tools && turn.tools.length) || 0) + " compaction=" + compaction.compactionThreshold + " early=" + compaction.earlyCompactionThreshold);
      var out = null;
      var useStream = hopSess.streamHop && process.env.OPENGROK_STREAM_HOP !== "0";
      if (useStream && typeof hopSess.runTurnStream === "function") {
        var queue = [];
        var waiters = [];
        var streamDone = false;
        var streamErr = null;
        function pushEv(ev) {
          queue.push(ev);
          while (waiters.length) waiters.shift()();
        }
        var streamPromise = hopSess.runTurnStream(turn, pushEv).then(function (o) {
          out = o;
          streamDone = true;
          while (waiters.length) waiters.shift()();
        }, function (e) {
          streamErr = e;
          streamDone = true;
          while (waiters.length) waiters.shift()();
        });
        while (!streamDone || queue.length) {
          if (queue.length) {
            var ev = queue.shift();
            if (ev.type === "reasoning") yield { type: "reasoning", textDelta: ev.textDelta };
            else if (ev.type === "text") yield { type: "text-delta", textDelta: ev.textDelta };
          } else if (!streamDone) {
            await new Promise(function (res) { waiters.push(res); });
          }
        }
        await streamPromise;
        if (streamErr) throw streamErr;
      } else {
        out = await hopSess.runTurn(turn);
      }
      var text = (out && out.content) || "";
      var calls = normalizeApiToolCalls((out && out.tool_calls) || []);
      var embedded = extractEmbeddedStreamJson(text);
      if (embedded.reasoning) {
        out.reasoning_content = ((out && out.reasoning_content) || "") + embedded.reasoning;
      }
      if (embedded.calls.length) {
        calls = calls.concat(embedded.calls);
        text = embedded.text;
        if ((out && out.finish_reason) === "stop") out.finish_reason = "tool_calls";
      } else if (embedded.text !== text) {
        text = embedded.text;
      }
      if (calls.length) {
        for (var tc = 0; tc < calls.length; tc++) {
          var tfn = (calls[tc] && calls[tc].function) || {};
          var rawArgs = tfn.arguments;
          var parsedArgs = parseToolCallArgs(rawArgs);
          log("[opengrok-debug] raw tool_call " + debugId + " name=" + (tfn.name || "") + " argsType=" + (typeof rawArgs) + " argsLen=" + (typeof rawArgs === "string" ? rawArgs.length : JSON.stringify(parsedArgs).length));
        }
      }
      log("stream out content=" + text.length + " reasoning=" + ((out && out.reasoning_content) || "").length + " tools=" + calls.length + " embeddedTools=" + embedded.calls.length + " finish=" + ((out && out.finish_reason) || ""));
      if (embedded.calls.length) {
        log("[opengrok-debug] embedded tool calls parsed=" + embedded.calls.length + " " + debugId);
      }
      if (!useStream && out && out.reasoning_content) {
        yield { type: "reasoning", textDelta: out.reasoning_content };
      }
      if (!useStream && text) yield { type: "text-delta", textDelta: text };
      for (var i = 0; i < calls.length; i++) {
        yield parseHopToolCall(calls[i], i);
      }
      var u = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      var ru = out && out.raw && out.raw.usage;
      if (ru) {
        u.promptTokens = ru.prompt_tokens || 0;
        u.completionTokens = ru.completion_tokens || 0;
        u.totalTokens = ru.total_tokens || 0;
        var extras = extractUsageExtras(ru);
        u.cacheReadTokens = extras.cacheReadTokens;
        u.cacheWriteTokens = extras.cacheWriteTokens;
      }
      var finish = (out && out.finish_reason) || "stop";
      if (finish === "tool_calls") finish = "tool-calls";
      var assistantContent = buildAssistantResponseContent(out, text, calls);
      var contentParts = Array.isArray(assistantContent) ? assistantContent.length : 0;
      okUsage(u);
      log("[opengrok-debug] usage resolved " + debugId);
      if (!settled.r) {
        settled.r = true;
        resR({
          id: (out && out.raw && out.raw.id) || "",
          modelId: hopSess.modelId,
          timestamp: new Date(),
          messages: [{ role: "assistant", content: assistantContent }],
          supportsSelfSummary: compaction.supportsSelfSummary,
          earlyCompactionContextTokenThreshold: compaction.earlyCompactionThreshold,
        });
        log("[opengrok-debug] response resolved " + debugId + " finishReason=" + finish + " contentParts=" + contentParts + " tools=" + calls.length);
      }
      log("[opengrok-debug] emit finish " + debugId + " finishReason=" + finish);
      yield { type: "finish", finishReason: finish, usage: u };
      log("[opengrok-debug] stream generator ended " + debugId);
    } catch (err) {
      log("stream error " + (err && err.message));
      log("[opengrok-debug] stream generator error " + debugId + " " + (err && err.message));
      failAll(err);
      yield { type: "error", error: err };
      throw err;
    } finally {
      if (abortListener && ctx && ctx.signal) {
        ctx.signal.removeEventListener("abort", abortListener);
      }
    }
  })();

  return {
    fullStream: fullStream,
    usage: usage,
    extendedUsage: extendedUsage,
    providerMetadata: providerMetadata,
    invocationId: inv,
    response: response,
  };
}

function wrapExecutor(exec, hopSess, binding, compaction) {
  return new Proxy(exec, {
    get: function (target, prop, receiver) {
      if (prop === "stream") {
        return function (ctx, invocationId, tools, options2) {
          return hopFullStream(target, hopSess, binding, compaction, ctx, invocationId, tools, options2);
        };
      }
      var val = Reflect.get(target, prop, receiver);
      if (typeof val === "function") return val.bind(target);
      return val;
    },
  });
}

function wrapPromptSession(inner, hopSess, binding, compaction, middleware) {
  return {
    getExecutor: function (state) {
      var raw = inner.getExecutor(state);
      var hopExec = wrapExecutor(raw, hopSess, binding, compaction);
      return middleware ? middleware(hopExec) : hopExec;
    },
    getModelId: function () {
      return binding.modelId;
    },
  };
}

function wrapProvider(stockProvider, hopSess, binding, compaction) {
  return {
    opengrok: true,
    modelId: binding.modelId,
    getSession: function (middleware) {
      var inner = stockProvider.getSession(undefined);
      return wrapPromptSession(inner, hopSess, binding, compaction, middleware);
    },
    getProviderName: function () {
      return typeof stockProvider.getProviderName === "function" ? stockProvider.getProviderName() : "proto";
    },
    getModelId: function () {
      return binding.modelId;
    },
    getThinkingDetails: function () {
      return typeof stockProvider.getThinkingDetails === "function" ? stockProvider.getThinkingDetails() : undefined;
    },
  };
}

function wrapBareHop(hopSess) {
  hopSess.getSession = function () { return hopSess; };
  hopSess.getProviderName = function () { return "proto"; };
  hopSess.getModelId = function () { return hopSess.modelId; };
  hopSess.getThinkingDetails = function () { return undefined; };
  return hopSess;
}

function wrapSession(stockFn, args) {
  var arr = Array.prototype.slice.call(args);
  if (process.env.OPENGROK_PROBE_PROTO === "1") {
    var probed = stockFn.apply(null, arr);
    try { dumpProto(probed); } catch (e) { log("probe write failed: " + e.message); }
    return probed;
  }
  var binding = resolveBinding(arr);
  if (!binding || !binding.hopBaseUrl || !binding.modelId) {
    var err = new Error("opengrok: no model binding for this turn (set agents['*'] or a matching agent id in model-bindings.json)");
    log(err.message);
    throw err;
  }
  var requested = requestedModelId(arr);
  log("route " + binding.modelId + " -> " + binding.hopBaseUrl + (requested ? " requested=" + requested : ""));
  var hopSess = hop.createOpenAiHopSession({
    modelId: binding.modelId,
    baseUrl: binding.hopBaseUrl,
    maxMode: binding.maxMode === true,
    parameters: Array.isArray(binding.parameters) ? binding.parameters : [],
    requestKind: "main",
  });
  var compaction = compactionConfig(binding);
  log("compaction ctx=" + compaction.contextWindow + " threshold=" + compaction.compactionThreshold + " early=" + compaction.earlyCompactionThreshold + " selfSummary=" + compaction.supportsSelfSummary);
  var stock = stockFn.apply(null, arr);
  if (stock && typeof stock.getSession === "function") {
    return wrapProvider(stock, hopSess, binding, compaction);
  }
  return wrapBareHop(hopSess);
}

module.exports = {
  wrapSession: wrapSession,
  resolveBinding: resolveBinding,
  collectIds: collectIds,
  completionsUrl: hop.completionsUrl,
  _testHooks: {
    extractEmbeddedStreamJson: extractEmbeddedStreamJson,
    buildAssistantResponseContent: buildAssistantResponseContent,
    toOpenAIMessages: toOpenAIMessages,
    parseHopToolCall: parseHopToolCall,
    resolveParametersForTurn: resolveParametersForTurn,
    compactionConfig: compactionConfig,
    extractUsageExtras: extractUsageExtras,
  },
};
