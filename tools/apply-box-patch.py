#!/usr/bin/env python3
"""apply-box-patch — install the binding consumer into a *private* OpenAI-hop host.

Stock Grok Bot 0.30 cloud hosts do not contain this lane (issues #3, #5):
`createOpenAiHopSession`, `resolvedOpenaiBaseUrl`, and `openai-hop-session.cjs`
are all absent. If census shows those symbols missing, stop and use
`tools/install-stock-box.py` instead. See docs/STOCK-HOST.md.

This script remains for hosts that already have the private OpenAI hop session.
It is anchored and fails closed when those anchors drift.
"""
import argparse, json, os, re, shutil, subprocess, sys, time

def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)

def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()

def write(p, s):
    with open(p, "w", encoding="utf-8") as f:
        f.write(s)

def check_anchor(text, anchor, label):
    n = text.count(anchor)
    if n != 1:
        die(f"anchor '{label}' count={n} (expected 1) — upstream bundle changed; refusing to half-patch")

def node_check(path):
    r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    if r.returncode != 0:
        die(f"node --check {path} failed:\n{r.stderr}")
    print(f"  ok: node --check {path}")

def patch_host(ht):
    h0 = ht
    old = "let resolvedTopLevelModelId = host.subagentModelId;\n        let resolvedOpenaiBaseUrl = void 0;"
    new = old + "\n        let resolvedTopLevelMaxMode = void 0;\n        let resolvedTopLevelParameters = void 0;"
    if old in ht and "let resolvedTopLevelMaxMode = void 0;" not in ht:
        check_anchor(ht, old, "1a")
        ht = ht.replace(old, new)
    old = "resolvedTopLevelModelId = __entry.modelId;"
    new = """resolvedTopLevelModelId = __entry.modelId;
                  if (typeof __entry.maxMode === "boolean") {
                    resolvedTopLevelMaxMode = __entry.maxMode;
                  }
                  if (Array.isArray(__entry.parameters)) {
                    resolvedTopLevelParameters = __entry.parameters;
                  }"""
    if old in ht and 'typeof __entry.maxMode === "boolean"' not in ht:
        check_anchor(ht, old, "1b")
        ht = ht.replace(old, new)
    main_spread = """...resolvedOpenaiBaseUrl != null ? { openaiBaseUrl: resolvedOpenaiBaseUrl, provenanceAgentId: host.getConversationId(), skipLabeling: true } : {},"""
    main_repl = """...resolvedOpenaiBaseUrl != null ? { openaiBaseUrl: resolvedOpenaiBaseUrl, provenanceAgentId: host.getConversationId() } : {},
          ...resolvedOpenaiBaseUrl != null && resolvedTopLevelParameters != null ? { parameters: resolvedTopLevelParameters } : {},
          ...resolvedOpenaiBaseUrl != null && resolvedTopLevelMaxMode != null ? { maxMode: resolvedTopLevelMaxMode } : {},"""
    n = ht.count(main_spread)
    if n == 1:
        pass
    elif n == 2:
        idx = ht.find(main_spread)
        while idx != -1:
            after = ht[idx+len(main_spread): idx+len(main_spread)+80]
            if "isSummarizationSession: true" in after:
                idx = ht.find(main_spread, idx+1)
                continue
            ht = ht[:idx] + main_repl + ht[idx+len(main_spread):]
            break
        if ht == h0:
            die("1c did not change anything")
    else:
        die(f"anchor 1c count={n} (expected 1 or 2: main + summarization spreads)")
    old = """requestKind: sessionOptions.isSummarizationSession ? "summarization" : "main"
          });"""
    new = """requestKind: sessionOptions.isSummarizationSession ? "summarization" : "main",
            maxMode: sessionOptions.maxMode === true,
            parameters: Array.isArray(sessionOptions.parameters) ? sessionOptions.parameters : void 0
          });"""
    if old in ht:
        check_anchor(ht, old, "2")
        ht = ht.replace(old, new)
    return ht

def patch_hop(ht):
    old = "const requestKind = opts && opts.requestKind;\n  return {"
    new = """const requestKind = opts && opts.requestKind;
  const maxMode = (opts && opts.maxMode) === true;
  const parameters = Array.isArray(opts && opts.parameters) ? opts.parameters : [];
  return {"""
    if old in ht:
        check_anchor(ht, old, "3a")
        ht = ht.replace(old, new)
    old = "this.allowTestVisibleRecovery = opts.allowTestVisibleRecovery === true;"
    new = old + "\n    this.maxMode = opts.maxMode === true;\n    this.parameters = Array.isArray(opts.parameters) ? opts.parameters : [];"
    if old in ht and "this.maxMode = opts.maxMode === true;" not in ht:
        check_anchor(ht, old, "3a2")
        ht = ht.replace(old, new)
    if "applyProviderReasoningControls" not in ht:
        old = 'const fs = require("fs");'
        new = 'const fs = require("fs");\nconst { applyProviderReasoningControls } = require("/home/box/sand-data/provider-maps.cjs");'
        check_anchor(ht, old, "3c-require")
        ht = ht.replace(old, new)
        old = "      const url = completionsUrl(self.baseUrl);"
        new = """      if (!localQwen) {
        applyProviderReasoningControls(body, { modelId: modelId, baseUrl: self.baseUrl, maxMode: self.maxMode, parameters: self.parameters });
      }
      const url = completionsUrl(self.baseUrl);"""
        check_anchor(ht, old, "3c-apply")
        ht = ht.replace(old, new)
    return ht

def main():
    ap = argparse.ArgumentParser(description="Patch a private OpenAI-hop Grok Bot host. Stock hosts: install-stock-box.py")
    ap.add_argument("--host", default="/home/box/sand-host/host-main.cjs")
    ap.add_argument("--hop", default="/home/box/sand-data/openai-hop-session.cjs")
    ap.add_argument("--bindings", default="/home/box/sand-data/model-bindings.json")
    ap.add_argument("--maps", default="/home/box/sand-data/provider-maps.cjs")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.host):
        die(f"host not found: {args.host}")
    ht = read(args.host)
    if "createOpenAiHopSession" not in ht or "resolvedOpenaiBaseUrl" not in ht:
        die(
            "this is a stock host (no createOpenAiHopSession / resolvedOpenaiBaseUrl). "
            "apply-box-patch.py cannot install on it. Use tools/install-stock-box.py. "
            "See docs/STOCK-HOST.md (issues #3, #5)."
        )
    if not os.path.exists(args.hop):
        die(f"hop not found: {args.hop}")
    hp = read(args.hop)

    print("== checks ==")
    node_check(args.host)
    node_check(args.hop)

    print("== patching ==")
    new_ht = patch_host(ht)
    new_hp = patch_hop(hp)
    if new_ht == ht and new_hp == hp:
        print("  no changes needed (already patched)")

    if args.dry_run:
        print("== dry-run: would write ==")
        print(f"  host: {'CHANGED' if new_ht != ht else 'noop'}")
        print(f"  hop:  {'CHANGED' if new_hp != hp else 'noop'}")
        return

    stamp = time.strftime("%Y%m%dT%H%M%SZ")
    bk = os.path.join(os.path.dirname(args.hop), f"harness-shim-backups-{stamp}")
    os.makedirs(bk, exist_ok=True)
    for p, name in ((args.host, "host-main.cjs.bak"), (args.hop, "openai-hop-session.cjs.bak")):
        shutil.copy2(p, os.path.join(bk, name))
    if os.path.exists(args.bindings):
        shutil.copy2(args.bindings, os.path.join(bk, "model-bindings.json.bak"))
    print(f"  backups -> {bk}")

    if new_ht != ht:
        write(args.host, new_ht)
        print(f"  [host] {args.host} patched")
    if new_hp != hp:
        write(args.hop, new_hp)
        print(f"  [hop]  {args.hop} patched")

    maps_dir = os.path.join(os.path.dirname(args.hop), "provider-maps.cjs")
    if not os.path.exists(maps_dir) and os.path.exists(args.maps):
        shutil.copy2(args.maps, maps_dir)
        print(f"  [maps] {maps_dir} written")
    elif not os.path.exists(maps_dir):
        die("provider-maps.cjs missing on box — upload it (or pass --maps) before bouncing")

    print("== syntax check after patch ==")
    node_check(args.host)
    node_check(args.hop)

    print("""
DONE. Next steps (see docs/CLOUD-HOST.md):
  1. Bounce the host process (supervisor-safe, NOT a raw kill).
  2. Send a normal message in the bound Bot conversation.
  3. Confirm the hop port sees the request.
""")

if __name__ == "__main__":
    main()
