#!/usr/bin/env python3
"""apply-box-patch — install the binding consumer into a stock Grok Bot cloud host.

THE MISSING STEP (opengrok#1): saving a binding and pushing model-bindings.json
to the box is NOT enough. Stock `sand-host/host-main.cjs` has zero
`hopBaseUrl` / `model-bindings.json` symbols — it never reads bindings, so a
saved hop binding is silently ignored and the agent falls back to its original
model. This tool applies the surgical, anchored patch that makes the live host
consume bindings and route normal chat turns through the configured hop.

Run ON the box (as the box user, from /home/box/sand-data once you have a
shell), or point --host/--hop/--bindings at the files if paths differ:

    python3 apply-box-patch.py --host /home/box/sand-host/host-main.cjs \
                               --hop  /home/box/sand-data/openai-hop-session.cjs \
                               --bindings /home/box/sand-data/model-bindings.json \
                               --maps /home/box/sand-data/provider-maps.cjs

Idempotent: safe to re-run; anchors are asserted (count==1) so a changed
upstream bundle fails loudly instead of silently half-patching.

What it does (all anchored, byte-surgical — never a blind sed):
  HOST patch 1a/1b/1c — read maxMode + parameters off the binding entry and
      carry them into the main session options (drops the dead skipLabeling
      spread on the MAIN lane; the summarization lane is left untouched).
  HOST patch 2      — forward maxMode/parameters into createOpenAiHopSession.
  HOP  patch 3a/3a2 — createOpenAiHopSession + executor accept maxMode/parameters.
  HOP  patch 3c     — require provider-maps.cjs and call applyProviderReasoningControls
      right before building the completions URL (localQwen lane excluded).
  Writes provider-maps.cjs next to the hop if missing (from --maps).
  Backs everything up first (timestamped dir), syntax-checks before AND after.

After applying: bounce the host process (NOT a raw kill — supervisor-safe),
then verify a normal chat turn hits the hop port. See docs/CLOUD-HOST.md.
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
    # 1a: declare resolved maxMode/parameters
    old = "let resolvedTopLevelModelId = host.subagentModelId;\n        let resolvedOpenaiBaseUrl = void 0;"
    new = old + "\n        let resolvedTopLevelMaxMode = void 0;\n        let resolvedTopLevelParameters = void 0;"
    if old in ht and "let resolvedTopLevelMaxMode = void 0;" not in ht:
        check_anchor(ht, old, "1a")
        ht = ht.replace(old, new)
    # else: already patched
    # 1b: read maxMode/parameters off the binding entry
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
    # else: already patched
    # 1c: carry into the MAIN sessionOptions spread (skip the summarization one)
    main_spread = """...resolvedOpenaiBaseUrl != null ? { openaiBaseUrl: resolvedOpenaiBaseUrl, provenanceAgentId: host.getConversationId(), skipLabeling: true } : {},"""
    main_repl = """...resolvedOpenaiBaseUrl != null ? { openaiBaseUrl: resolvedOpenaiBaseUrl, provenanceAgentId: host.getConversationId() } : {},
          ...resolvedOpenaiBaseUrl != null && resolvedTopLevelParameters != null ? { parameters: resolvedTopLevelParameters } : {},
          ...resolvedOpenaiBaseUrl != null && resolvedTopLevelMaxMode != null ? { maxMode: resolvedTopLevelMaxMode } : {},"""
    n = ht.count(main_spread)
    if n == 1:
        # already patched (main spread replaced; only summarization one remains)
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
    # 2: forward into createOpenAiHopSession
    old = """requestKind: sessionOptions.isSummarizationSession ? "summarization" : "main"
          });"""
    new = """requestKind: sessionOptions.isSummarizationSession ? "summarization" : "main",
            maxMode: sessionOptions.maxMode === true,
            parameters: Array.isArray(sessionOptions.parameters) ? sessionOptions.parameters : void 0
          });"""
    if old in ht:
        check_anchor(ht, old, "2")
        ht = ht.replace(old, new)
    # else: already patched (anchor 2 replaced on a previous run)
    return ht

def patch_hop(ht, maps_path):
    h0 = ht
    # 3a: createOpenAiHopSession accepts maxMode/parameters
    old = "const requestKind = opts && opts.requestKind;\n  return {"
    new = """const requestKind = opts && opts.requestKind;
  const maxMode = (opts && opts.maxMode) === true;
  const parameters = Array.isArray(opts && opts.parameters) ? opts.parameters : [];
  return {"""
    if old in ht:
        check_anchor(ht, old, "3a")
        ht = ht.replace(old, new)
    # else: already patched
    # 3a2: executor ctor fields
    old = "this.allowTestVisibleRecovery = opts.allowTestVisibleRecovery === true;"
    new = old + "\n    this.maxMode = opts.maxMode === true;\n    this.parameters = Array.isArray(opts.parameters) ? opts.parameters : [];"
    if old in ht and "this.maxMode = opts.maxMode === true;" not in ht:
        check_anchor(ht, old, "3a2")
        ht = ht.replace(old, new)
    # else: already patched
    # 3c: require map + apply in stream
    if "applyProviderReasoningControls" not in ht:
        old = 'const fs = require("fs");'
        new = 'const fs = require("fs");\nconst {{ applyProviderReasoningControls }} = require({});'.format(json.dumps(maps_path))
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
    ap = argparse.ArgumentParser(description="Install the binding consumer into a stock Grok Bot cloud host.")
    ap.add_argument("--host", default="/home/box/sand-host/host-main.cjs", help="path to live host-main.cjs")
    ap.add_argument("--hop", default="/home/box/sand-data/openai-hop-session.cjs", help="path to openai-hop-session.cjs")
    ap.add_argument("--bindings", default="/home/box/sand-data/model-bindings.json", help="path to model-bindings.json")
    ap.add_argument("--maps", default="/home/box/sand-data/provider-maps.cjs", help="path to provider-maps.cjs (written if missing)")
    ap.add_argument("--dry-run", action="store_true", help="print what would change without writing")
    args = ap.parse_args()

    for p, label in ((args.host, "host"), (args.hop, "hop")):
        if not os.path.exists(p):
            die(f"{label} not found: {p}")
    ht = read(args.host)
    hp = read(args.hop)

    print("== checks ==")
    node_check(args.host)
    node_check(args.hop)

    print("== patching ==")
    new_ht = patch_host(ht)
    maps_path = os.path.dirname(args.hop).replace("\\", "/") + "/provider-maps.cjs"
    new_hp = patch_hop(hp, maps_path)
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

    # provider-maps.cjs must exist next to the hop
    maps_dir = maps_path
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
  3. Confirm the hop port sees the request (tcpdump/journal on the box, or the
     hop's own access log). The picker's direct probe does NOT prove routing.
""")

if __name__ == "__main__":
    main()