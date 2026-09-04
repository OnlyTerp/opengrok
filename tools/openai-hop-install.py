#!/usr/bin/env python3
"""openai-hop-install — install the opengrok hop session into a BUNDLED Grok Bot
cloud host (works on every sand-host layout shipped to date).

THE ACTUAL GAP (issues #3/5/8/10): stock cloud hosts are a single-file webpack
bundle (`/home/box/sand-host/host-main.cjs`, ~25 MB) with NO
`openai-hop-session.cjs`, NO `hopBaseUrl`, NO `model-bindings` symbols.
`apply-box-patch.py` anchors intentionally do NOT match that bundle — patching
a sealed 25 MB upstream bundle was never the reliable path.

This installer makes the bundle USE the shipped, self-contained hop session:
it guards the built-in OpenAI session construction with a lookup into
`/home/box/sand-data/model-bindings.json`; when the conversation's agent has a
binding with `hopBaseUrl`, the host routes that conversation through the
shipped hop session. The hop file is loaded at request time from disk via
`new Function` (bundled builds cannot require() loose files) — hot-reload
works by bounce.

What it does (anchored, idempotent, backs up first):
  1. Requires `openai-hop-session.cjs` + `provider-maps.cjs` already in
     /home/box/sand-data/ (copy from box/ first — the tool prints the curl).
  2. Locates the built-in session construction seam (`new e("openai_session"`)
     and rewrites that single assignment into guard + fallback.
  3. Syntax-checks before AND after; aborts on anchor count != 1.

Usage (run ON the box):
  python3 openai-hop-install.py                   # apply with defaults
  python3 openai-hop-install.py --dry-run         # show what would change
  python3 openai-hop-install.py --check-target    # recon: symbols + anchors
"""
import argparse, hashlib, os, re, shutil, subprocess, sys, time

DEFAULT_HOST = "/home/box/sand-host/host-main.cjs"
DEFAULT_DATA = "/home/box/sand-data"
MARK_BEGIN = "/*OPENGROK-HOP-INJECT BEGIN*/"
MARK_END = "/*OPENGROK-HOP-INJECT END*/"

JS_INJECT = """%(BEGIN)s
try {
  var __ogPath = require("path");
  var __ogFs = require("fs");
  var __ogBindPath = __ogPath.join(%(dataDir)s, "model-bindings.json");
  var __ogAgentId = (host && typeof host.getConversationId === "function") ? host.getConversationId() : void 0;
  var __ogEntry = null;
  if (__ogAgentId && __ogFs.existsSync(__ogBindPath)) {
    try {
      var __ogB = JSON.parse(__ogFs.readFileSync(__ogBindPath, "utf8"));
      var __ogAgents = (__ogB && __ogB.agents) ? __ogB.agents : {};
      __ogEntry = __ogAgents[__ogAgentId] || null;
      if (!__ogEntry && host.isSubagentRunner && host.subagentTranscriptId) {
        __ogEntry = __ogAgents[host.subagentTranscriptId] || null;
        if (!__ogEntry) __ogEntry = __ogAgents[__ogAgentId] || null;
      }
    } catch (__ogE) {}
  }
  if (__ogEntry && __ogEntry.hopBaseUrl) {
    var LF = String.fromCharCode(10); var __ogMapsSrc = __ogFs.readFileSync(%(mapsPath)s, "utf8");
    if (__ogMapsSrc.charCodeAt(0) === 35 && __ogMapsSrc.charCodeAt(1) === 33) __ogMapsSrc = __ogMapsSrc.slice(__ogMapsSrc.indexOf(LF) + 1);
    var __ogHopSrc = __ogFs.readFileSync(%(hopPath)s, "utf8");
    if (__ogHopSrc.charCodeAt(0) === 35 && __ogHopSrc.charCodeAt(1) === 33) __ogHopSrc = __ogHopSrc.slice(__ogHopSrc.indexOf(LF) + 1);
    var __ogMapsMod = { exports: {} };
    new Function("module", "exports", __ogMapsSrc)(__ogMapsMod, __ogMapsMod.exports);
    var __ogMaps = __ogMapsMod.exports;
    var __ogHopMod = { exports: {} };
    new Function("module", "exports", "require", __ogHopSrc)(__ogHopMod, __ogHopMod.exports, function (n) {
      if (n === "./provider-maps.cjs") return __ogMaps;
      return require(n);
    });
    var __ogFactory = __ogHopMod.exports.createOpenAiHopSession;
    var __ogParams = Array.isArray(__ogEntry.parameters) ? __ogEntry.parameters : [];
    var __ogMax = __ogEntry.maxMode === true;
    var __ogSession = __ogFactory({
      baseUrl: __ogEntry.hopBaseUrl,
      modelId: __ogEntry.modelId || "unknown",
      agentId: __ogAgentId,
      provenanceAgentId: __ogAgentId,
      requestKind: "main",
      maxMode: __ogMax,
      parameters: __ogParams
    });
        var __ogWrap = Object.create(__ogSession);
    __ogWrap.getExecutor = function (state) {
      return __ogSession.getExecutor(state);
    };
    return __ogWrap;
  }
} catch (__ogFatal) {}
%(END)s
"""

def die(msg, hint=""):
    print(f"ERROR: {msg}", file=sys.stderr)
    if hint:
        print(hint, file=sys.stderr)
    sys.exit(1)

def read(p):
    with open(p, encoding="utf-8", errors="surrogateescape") as f:
        return f.read()

def write(p, s):
    with open(p, "w", encoding="utf-8", errors="surrogateescape", newline="") as f:
        f.write(s)

def node_check(path):
    r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    if r.returncode != 0:
        die(f"node --check {path} failed:\n{r.stderr[-800:]}")
    print(f"  ok: node --check {path}")

SEAM_ANCHOR = 'new e("openai_session"'

def build_js(data_dir, hop_path, maps_path, model_id_expr):
    return JS_INJECT % {
        "BEGIN": MARK_BEGIN, "END": MARK_END,
        "dataDir": json_repr(data_dir),
        "hopPath": json_repr(hop_path),
        "mapsPath": json_repr(maps_path),
        "modelId": model_id_expr,
    }

def json_repr(s):
    import json
    return json.dumps(s)

def check_target(host_path, data_dir):
    txt = read(host_path)
    import hashlib
    sha = hashlib.sha256(txt.encode("utf-8", errors="surrogateescape")).hexdigest()
    print("== target recon ==")
    print(f"  host: {host_path}  ({os.path.getsize(host_path)} bytes, sha256 {sha[:12]}…)")
    for sym in ('"openai_session"', "hopBaseUrl", "model-bindings", "createOpenAiHopSession"):
        print(f"  symbol {sym!r}: {txt.count(sym)}")
    print(f"  seam {SEAM_ANCHOR!r}: {txt.count(SEAM_ANCHOR)}")
    for p in (os.path.join(data_dir, "openai-hop-session.cjs"), os.path.join(data_dir, "provider-maps.cjs")):
        print(f"  {'PRESENT' if os.path.exists(p) else 'MISSING'}: {p}")
    return 0 if txt.count(SEAM_ANCHOR) == 1 else 2

def main():
    ap = argparse.ArgumentParser(description="Install the shipped hop session into a bundled Grok Bot cloud host.")
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--data", default=DEFAULT_DATA)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check-target", action="store_true")
    args = ap.parse_args()

    hop_path = os.path.join(args.data, "openai-hop-session.cjs")
    maps_path = os.path.join(args.data, "provider-maps.cjs")

    if not os.path.exists(args.host):
        die(f"host not found: {args.host}")
    missing = [p for p in (hop_path, maps_path) if not os.path.exists(p)]
    if missing and not args.check_target:
        die(f"missing required files: {missing}", (
            "copy them from the repo first:"
            "\n  curl -fsSL https://raw.githubusercontent.com/OnlyTerp/opengrok/main/box/openai-hop-session.cjs -o " + hop_path +
            "\n  curl -fsSL https://raw.githubusercontent.com/OnlyTerp/opengrok/main/tools/provider-maps.cjs -o " + maps_path))

    if args.check_target:
        sys.exit(check_target(args.host, args.data))

    print("== checks ==")
    node_check(args.host)

    ht = read(args.host)
    if MARK_BEGIN in ht:
        print("  already patched (OPENGROK-HOP-INJECT block present) — no changes")
        return
    n = ht.count(SEAM_ANCHOR)
    if n != 1:
        die(f"seam anchor count={n} (expected 1) — upstream bundle changed; refusing to touch",
            "run --check-target for recon output")
    idx = ht.find(SEAM_ANCHOR)
    stmt_start = ht.rfind("=", 0, idx)
    if stmt_start == -1 or idx - stmt_start > 300:
        die("could not locate the assignment left of the seam — refusing to touch")
    stmt_end = ht.find(";", idx)
    if stmt_end == -1 or stmt_end - idx > 1500:
        die("could not locate the statement end right of the seam — refusing to touch")

    # indentation of the statement's line = indent of the guard we generate
    line_start = ht.rfind("\n", 0, stmt_start) + 1
    indent = re.match(r"[ \t]*", ht[line_start:stmt_start]).group(0)

    original_stmt = ht[stmt_start:stmt_end + 1]
    guard = build_js(args.data, hop_path, maps_path, "__ogEntry.modelId")
    # Guard AFTER the original assignment: wrap session when a hop binding exists.
    guarded = (
        original_stmt + "\n" + indent + MARK_BEGIN + "\n" + indent +
        guard.replace(MARK_BEGIN + "\n", "").replace(MARK_END + "\n", "")
        .replace("\n", "\n" + indent).rstrip() + "\n" + indent + MARK_END
    )
    # sanity: guard must syntactically balance (checks done by node after write)
    new_ht = ht[:stmt_start] + guarded + ht[stmt_end + 1:]
    if new_ht.count(SEAM_ANCHOR) != 1:
        die("post-patch anchor count changed — internal safety trip")

    if args.dry_run:
        print("== dry-run: would write ==")
        print(f"  host: {args.host} — seam ({len(original_stmt)} bytes) -> guarded hop branch ({len(guarded)} bytes)")
        print("  NOTE: this tool SHIPS A PATCHER, NOT A BUNDLE — it edits the host ON THE BOX.")
        return

    stamp = time.strftime("%Y%m%dT%H%M%SZ")
    bk = os.path.join(os.path.dirname(args.host), f"opengrok-inject-backups-{stamp}")
    os.makedirs(bk, exist_ok=True)
    shutil.copy2(args.host, os.path.join(bk, "host-main.cjs.bak"))
    print(f"  backups -> {bk}")

    write(args.host, new_ht)
    print(f"  [host] {args.host} patched")
    print("== syntax check after patch ==")
    node_check(args.host)

    print("""
DONE. Next steps:
  1. Bounce the host process (supervisor-safe, NOT a raw kill).
  2. Send a normal message in the bound Bot conversation.
  3. Confirm the hop port sees the request (tcpdump/journal, or live-metrics.jsonl
     rows appearing per turn). A picker probe does NOT prove routing.
""")

if __name__ == "__main__":
    main()
