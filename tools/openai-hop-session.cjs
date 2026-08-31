"use strict";
/*
 * OpenAI hop session. This file was documented as shipping on the box and
 * never existed in the public repo (issues #1, #3, #5).
 *
 * Hosts that already had a private copy can keep using apply-box-patch.py.
 * Stock hosts load this via opengrok-runtime.cjs after wrap_proto_session.py.
 */
var http = require("http");
var https = require("https");
var path = require("path");
var { URL } = require("url");

function completionsUrl(baseUrl) {
  var b = String(baseUrl || "").replace(/\/+$/, "");
  if (!b) throw new Error("openai-hop-session: missing baseUrl");
  if (/\/chat\/completions$/i.test(b)) return b;
  if (/\/v1$/i.test(b)) return b + "/chat/completions";
  return b + "/v1/chat/completions";
}

function loadMaps() {
  var candidates = [
    "/home/box/sand-data/provider-maps.cjs",
    path.join(__dirname, "provider-maps.cjs"),
  ];
  for (var i = 0; i < candidates.length; i++) {
    try {
      return require(candidates[i]);
    } catch (e) {
      /* try next */
    }
  }
  return null;
}

function applyMaps(body, ctx) {
  var maps = loadMaps();
  if (!maps || typeof maps.applyProviderReasoningControls !== "function") return;
  var localQwen = false;
  if (!localQwen) {
    maps.applyProviderReasoningControls(body, ctx);
  }
}

function postJson(urlStr, body, headers, timeoutMs, session) {
  return new Promise(function (resolve, reject) {
    var u = new URL(urlStr);
    var lib = u.protocol === "https:" ? https : http;
    var payload = Buffer.from(JSON.stringify(body), "utf8");
    var hdrs = Object.assign({
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
      "Accept": "application/json",
    }, headers || {});
    var req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: hdrs,
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var raw = Buffer.concat(chunks).toString("utf8");
        var json = null;
        try { json = JSON.parse(raw); } catch (e) { json = null; }
        resolve({ status: res.statusCode, raw: raw, json: json });
      });
    });
    if (session) session._activeReq = req;
    req.setTimeout(timeoutMs || 180000, function () {
      req.destroy();
      reject(new Error("openai-hop-session: upstream timeout"));
    });
    req.on("error", function (err) {
      if (session && session._activeReq === req) session._activeReq = null;
      if (err && (err.code === "ECONNRESET" || err.message === "aborted")) {
        reject(new Error("openai-hop-session: aborted"));
        return;
      }
      reject(err);
    });
    req.on("close", function () {
      if (session && session._activeReq === req) session._activeReq = null;
    });
    req.write(payload);
    req.end();
  });
}

function coerceContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(function (p) {
      if (typeof p === "string") return p;
      if (p && p.type === "text") return p.text || "";
      return "";
    }).join("");
  }
  return String(content);
}

function OpenAiHopSession(opts) {
  opts = opts || {};
  this.requestKind = opts.requestKind;
  this.maxMode = opts.maxMode === true;
  this.parameters = Array.isArray(opts.parameters) ? opts.parameters : [];
  this.modelId = opts.modelId || opts.model;
  this.baseUrl = opts.baseUrl || opts.openaiBaseUrl || opts.hopBaseUrl;
  this.apiKey = opts.apiKey || process.env.API_SERVER_KEY || "";
  this.allowTestVisibleRecovery = opts.allowTestVisibleRecovery === true;
  this._turnGen = 0;
  this._cancelNext = false;
  this._activeReq = null;
  this.opengrok = true;
}

OpenAiHopSession.prototype.abort = function abort() {
  this._turnGen++;
  if (this._activeReq) {
    this._activeReq.destroy();
    this._activeReq = null;
  } else {
    this._cancelNext = true;
  }
};

OpenAiHopSession.prototype.getThinkingDetails = function getThinkingDetails() {
  return undefined;
};

OpenAiHopSession.prototype._headers = function _headers() {
  var h = {};
  if (this.apiKey) h.Authorization = "Bearer " + this.apiKey;
  return h;
};

OpenAiHopSession.prototype._body = function _body(turn) {
  turn = turn || {};
  var messages = turn.messages;
  if (!Array.isArray(messages)) messages = [{ role: "user", content: String(turn.content || turn.prompt || "") }];
  var body = {
    model: this.modelId,
    messages: messages,
    stream: false,
  };
  if (Array.isArray(turn.tools) && turn.tools.length) body.tools = turn.tools;
  body.max_tokens = turn.max_tokens != null ? turn.max_tokens : 8192;
  applyMaps(body, {
    modelId: this.modelId,
    baseUrl: this.baseUrl,
    maxMode: this.maxMode,
    parameters: this.parameters,
  });
  return body;
};

OpenAiHopSession.prototype.runTurn = function runTurn(turn) {
  if (this._cancelNext) {
    this._cancelNext = false;
    return Promise.reject(new Error("openai-hop-session: aborted"));
  }
  var self = this;
  var gen = this._turnGen;
  var body = this._body(turn);
  var url = completionsUrl(this.baseUrl);
  return postJson(url, body, this._headers(), 180000, this).then(function (res) {
    if (self._turnGen !== gen) throw new Error("openai-hop-session: aborted");
    if (res.status < 200 || res.status >= 300) {
      var msg = "openai-hop-session: HTTP " + res.status;
      if (res.raw) msg += " " + res.raw.slice(0, 300);
      throw new Error(msg);
    }
    var choice = res.json && res.json.choices && res.json.choices[0];
    var message = (choice && choice.message) || {};
    return {
      content: coerceContent(message.content),
      reasoning_content: message.reasoning_content || "",
      tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      finish_reason: choice && choice.finish_reason,
      raw: res.json,
    };
  });
};

OpenAiHopSession.prototype.stream = function stream(turn, handlers) {
  handlers = handlers || {};
  return this.runTurn(turn).then(function (out) {
    if (typeof handlers.onText === "function" && out.content) handlers.onText(out.content);
    if (typeof handlers.onDone === "function") handlers.onDone(out);
    return out;
  }, function (err) {
    if (typeof handlers.onError === "function") handlers.onError(err);
    throw err;
  });
};

function createOpenAiHopSession(opts) {
  var requestKind = opts && opts.requestKind;
  var maxMode = (opts && opts.maxMode) === true;
  var parameters = Array.isArray(opts && opts.parameters) ? opts.parameters : [];
  return new OpenAiHopSession({
    requestKind: requestKind,
    maxMode: maxMode,
    parameters: parameters,
    modelId: opts && (opts.modelId || opts.model),
    baseUrl: opts && (opts.baseUrl || opts.openaiBaseUrl || opts.hopBaseUrl),
    apiKey: opts && opts.apiKey,
    allowTestVisibleRecovery: opts && opts.allowTestVisibleRecovery === true,
  });
}

module.exports = {
  createOpenAiHopSession: createOpenAiHopSession,
  completionsUrl: completionsUrl,
  OpenAiHopSession: OpenAiHopSession,
};
