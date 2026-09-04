#!/usr/bin/env node
"use strict";
/**
 * box/test/test-hop-install.cjs — validates tools/openai-hop-install.py end-to-end:
 *   1. patches a synthetic bundled host (exact seam shape of audited sand-host builds)
 *   2. POSITIVE: a matching hop binding routes the turn through the REAL hop session
 *      (mock upstream sees a compliant OpenAI POST: modelId, messages, effort/thinking knobs)
 *   3. NEGATIVE: an empty binding table falls back to the built-in session
 *   4. idempotence: re-run reports "already patched" and does not double-inject
 *   5. anchor-mismatch: a foreign bundle shape aborts with count, refusing to half-patch
 *
 * Requires python on PATH. Runs the installer with --host/--data pointed at test dirs.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");

const REPO = path.resolve(__dirname, "..", "..");
const INSTALLER = path.join(REPO, "tools", "openai-hop-install.py");
const HOP = path.join(REPO, "box", "openai-hop-session.cjs");
const MAPS = path.join(REPO, "tools", "provider-maps.cjs");

let passed = 0, failed = 0;
function pass(n) { passed++; console.log("PASS " + n); }
function fail(n, e) { failed++; console.log("FAIL " + n + (e ? " :: " + e : "")); }

const AGENT_ID = "11111111-2222-4333-8444-555555555555";

const HOST_TEMPLATE = `"use strict";
var __webpack_exports__ = {};
(() => {
  var host = {
    getConversationId: () => "@AGENT@",
    isSubagentRunner: false
  };
  var buildSession = () => {
    const sessionOptions = {};
    const s = new e("openai_session", sessionOptions, host);
    return s;
  };
  return buildSession();
})();
`.replace("@AGENT@", AGENT_ID);

function freshEnv(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oginstall-" + tag + "-"));
  const hostPath = path.join(dir, "host-main.cjs");
  fs.writeFileSync(hostPath, HOST_TEMPLATE);
  const dataDir = path.join(dir, "sand-data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(HOP, path.join(dataDir, "openai-hop-session.cjs"));
  fs.copyFileSync(MAPS, path.join(dataDir, "provider-maps.cjs"));
  return { dir, hostPath, dataDir };
}

function runInstaller(cmd, hostPath, dataDir) {
  return spawnSync("python", [INSTALLER, ...cmd, "--host", hostPath, "--data", dataDir],
    { encoding: "utf8", timeout: 120000 });
}

function mockHopServer() {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url, body: JSON.parse(body || "{}") });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"hop"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port }));
  });
}

function loadPatchedHost(hostPath, mockPort) {
  const src = fs.readFileSync(hostPath, "utf8");
  const ctx = vm.createContext({
    require, console, Symbol, JSON, Object, Array, Promise, Error, TypeError,
    process, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, TextDecoder, Buffer,
    Date, Math, Number, String, Boolean, RegExp, Map, Set, isNaN, parseInt, parseFloat, Infinity, NaN, undefined, Proxy, Reflect, Function, ArrayBuffer, Uint8Array, DataView, crypto,
    e: function () { return { builtin: true }; },
  });
  const result = vm.runInContext(src, ctx, { filename: path.basename(hostPath) });
  return result;
}

(async () => {
  // ---- 1. POSITIVE: binding present -> turn routes through the hop ----
  const t1 = freshEnv("pos");
  const { srv, seen, port } = await mockHopServer();
  fs.writeFileSync(path.join(t1.dataDir, "model-bindings.json"), JSON.stringify({
    agents: { [AGENT_ID]: {
      name: "alpha", modelId: "glm-5.3", provider: "glm-coding-plan",
      hopBaseUrl: `http://127.0.0.1:${port}/v1`, maxMode: false,
      parameters: [{ id: "effort", value: "high" }]
    } }
  }, null, 1));
  let r = runInstaller([], t1.hostPath, t1.dataDir);
  if (r.status !== 0 || /OPENGROK-HOP-INJECT BEGIN/.test(fs.readFileSync(t1.hostPath, "utf8")) === false) {
    fail("install:positive-applies", r.stderr.trim().split("\n").pop());
  } else {
    pass("install:positive-applies");
    const session = loadPatchedHost(t1.hostPath, port);
    let routed = false, wire = null;
    if (session && typeof session.getExecutor === "function" && !session.builtin) {
      routed = true;
      const exec = session.getExecutor({ messages: [
        { role: "system", content: "sys" }, { role: "user", content: "hello" }
      ] });
      const run = exec.stream();
      for await (const ev of run.fullStream) { /* drain */ }
      await new Promise((res) => setTimeout(res, 250));
      wire = seen.find((x) => x.url && x.url.includes("/chat/completions"));
    }
    if (routed && wire) {
      pass("install:routed-through-hop");
      if (wire.body.model === "glm-5.3" && Array.isArray(wire.body.messages) && wire.body.messages.length >= 2
          && (wire.body.reasoning_effort === "high" || wire.body.thinking !== undefined)) {
        pass("install:wire-shape-compliant (modelId+messages+knobs)");
      } else {
        fail("install:wire-shape-compliant", JSON.stringify(wire.body).slice(0, 200));
      }
    } else {
      fail("install:routed-through-hop", seen.length ? JSON.stringify(seen).slice(0, 150) : "no POST");
    }
  }
  srv.close();

  // ---- 2. NEGATIVE: no binding -> falls back to built-in ----
  const t2 = freshEnv("neg");
  fs.writeFileSync(path.join(t2.dataDir, "model-bindings.json"), JSON.stringify({ agents: {} }, null, 1));
  r = runInstaller([], t2.hostPath, t2.dataDir);
  const patched2 = /OPENGROK-HOP-INJECT BEGIN/.test(fs.readFileSync(t2.hostPath, "utf8"));
  if (r.status !== 0 || !patched2) { fail("install:negative-patch-applied", r.stderr.trim()); }
  else {
    const session = loadPatchedHost(t2.hostPath, 1);
    if (session && session.builtin) pass("install:negative-fallback-builtin");
    else fail("install:negative-fallback-builtin", "expected builtin session");
  }

  // ---- 3. IDEMPOTENCE: second run must no-op ----
  const before = fs.readFileSync(t1.hostPath, "utf8");
  r = runInstaller([], t1.hostPath, t1.dataDir);
  const after = fs.readFileSync(t1.hostPath, "utf8");
  if (r.status !== 0 || !/already patched/i.test(r.stdout) || before !== after) {
    fail("install:idempotent-re-run-noop", (r.stderr || "stdout/body mismatch").trim().split("\n").pop());
  } else pass("install:idempotent-re-run-noop");

  // ---- 4. ANCHOR-MISMATCH: altered seam aborts without writing ----
  const t3 = freshEnv("mismatch");
  fs.writeFileSync(t3.hostPath, HOST_TEMPLATE.replace('new e("openai_session"', 'new z("openai_session_x"'));
  r = runInstaller(["--dry-run"], t3.hostPath, t3.dataDir);
  if (r.status !== 0 && /refusing to touch|anchor count/i.test(r.stdout + r.stderr)) {
    pass("install:anchor-mismatch-aborts-loudly");
  } else fail("install:anchor-mismatch-aborts-loudly", JSON.stringify({ status: r.status, out: r.stdout.slice(-160) }));

  // ---- 5. PATCHES MADE: no-backup-of-missing-bindings crash ----
  // (bindings file absent entirely; installer must still patch)
  const t4 = freshEnv("nobind");
  r = runInstaller([], t4.hostPath, t4.dataDir);
  if (r.status === 0) pass("install:missing-bindings-file-ok");
  else fail("install:missing-bindings-file-ok", r.stderr.trim().split("\n").pop());

  console.log(`\nResults: ${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS-THREW:", e && (e.stack || e.message)); process.exit(1); });
