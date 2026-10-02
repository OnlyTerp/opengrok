#!/usr/bin/env python3
"""glass-inject.py — update-proof LiquidGlass HUD injection for Grok Bot's app.asar.

Why this exists: Grok Bot updates silently replace resources/app.asar with a stock
build (renderer entry hash changes every release), wiping any in-app overlay. This
tool re-applies the injection idempotently and can watch + auto-heal after updates.

What it changes in the asar (and nothing else):
  1. dist/renderer/index.html  — extend CSP connect-src with 127.0.0.1/localhost
                                 (the HUD relays to http://127.0.0.1:8799) and add
                                 <!--GROKBOT_LIQUIDGLASS_IN_APP_INJECTED--> +
                                 <script defer src="./assets/gb-liquidglass.js">
  2. dist/renderer/assets/gb-liquidglass.js  — the HUD itself (new stable-named file)

Update-proof by construction: the only anchors are stable names (index.html,
</body>, the CSP connect-src directive), never the hashed entry bundle. Every
anchor mismatch fails loud with exit 1 — never a silent partial patch.

Usage:
  python tools/glass-inject.py --check          # 0 = injected, 3 = stock, 1 = error
  python tools/glass-inject.py --apply [--close] [--hud PATH] [--asar PATH]
  python tools/glass-inject.py --watch [--auto-relaunch]   # auto-heal loop
  macOS (Darwin): the asar lives at /Applications/Grok Bot.app/Contents/
  Resources/app.asar and the Electron asar-integrity hash is carried in
  Contents/Info.plist ElectronAsarIntegrity (not in the binary). Editing
  sealed files (app.asar, Info.plist) forfeits the vendor Developer ID
  signature; the tool re-seals the bundle ad-hoc (codesign --force --sign -,
  entitlements + hardened runtime preserved per target) and strips quarantine
  so Gatekeeper does not kill the ad-hoc build. A vendor update restores the
  real signature and wipes the injection — re-run --apply to re-inject.
"""

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)

MARKER_HTML = "<!--GROKBOT_LIQUIDGLASS_IN_APP_INJECTED-->"
MARKER_JS = "/*GROKBOT_LIQUIDGLASS_IN_APP_INJECTED*/"
LEGACY_SCRIPT_TAG = '<script defer src="./assets/gb-liquidglass.js"></script>'
CSP_CONNECT_ANCHOR = "connect-src 'self' ws: sand-media:"
CSP_CONNECT_EXTRA = " http://127.0.0.1:* http://localhost:*"

IS_DARWIN = sys.platform == "darwin"
DEFAULT_APP_MAC = "/Applications/Grok Bot.app"
DEFAULT_ASAR = (os.path.join(DEFAULT_APP_MAC, "Contents", "Resources", "app.asar")
                if IS_DARWIN else
                r"C:\Users\User\AppData\Local\Programs\Grok Bot\resources\app.asar")
DEFAULT_EXE = (os.path.join(DEFAULT_APP_MAC, "Contents", "MacOS", "Grok Bot")
               if IS_DARWIN else
               r"C:\Users\User\AppData\Local\Programs\Grok Bot.exe")
MACHINE_HUD = (os.path.expanduser("~/.grokbot/grokbot-liquidglass.js")
               if IS_DARWIN else r"C:\Users\User\.grokbot\grokbot-liquidglass.js")
REPO_HUD = os.path.join(REPO_ROOT, "box", "hud", "liquidglass.js")

# Electron embedded-asar-integrity block inside the exe (fuse). The app FATALs
# at boot when sha256(header JSON) != this value — proven against stock bytes.
EXE_INTEGRITY_RE = re.compile(
    rb'\[\{"file":"resources\\\\app\.asar","alg":"SHA256","value":"([0-9a-f]{64})"\}\]')

EXIT_OK = 0
EXIT_ERR = 1
EXIT_STOCK = 3


def log(msg):
    print(f"[glass-inject] {msg}", flush=True)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def state_dir():
    d = (os.path.expanduser("~/.grokbot") if IS_DARWIN
         else r"C:\Users\User\.grokbot")
    if os.path.isdir(d):
        return d
    d = os.path.join(os.environ.get("TEMP", "/tmp"), "opengrok-glass")
    os.makedirs(d, exist_ok=True)
    return d


def resolve_hud(explicit):
    """HUD source: --hud > LG_SRC env > machine master > repo sanitized copy."""
    for cand in (explicit, os.environ.get("LG_SRC"), MACHINE_HUD, REPO_HUD):
        if cand and os.path.isfile(cand):
            return os.path.abspath(cand)
    raise SystemExit("glass-inject: no HUD source found (tried --hud, LG_SRC, "
                     f"{MACHINE_HUD}, {REPO_HUD})")


def app_running():
    if IS_DARWIN:
        return subprocess.run(["pgrep", "-x", "Grok Bot"],
                              capture_output=True).returncode == 0
    try:
        out = subprocess.run(
            ["cmd", "/c", "tasklist", "/fo", "csv", "/nh"],
            capture_output=True, text=True, timeout=30,
        ).stdout
    except Exception as e:
        raise SystemExit(f"glass-inject: tasklist failed: {e}")
    return any(line.lower().startswith('"grok bot.exe"') for line in out.splitlines())


def close_app():
    """Graceful close — osascript quit on macOS, WM_CLOSE ritual on Windows."""
    if IS_DARWIN:
        subprocess.run(["osascript", "-e", 'quit app "Grok Bot"'],
                       capture_output=True, text=True, timeout=30)
    else:
        ps = ("Get-Process | Where-Object { $_.ProcessName -like '*Grok Bot*' } | "
              "ForEach-Object { $_.CloseMainWindow() | Out-Null }")
        subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                       capture_output=True, text=True, timeout=60)
    for _ in range(20):
        if not app_running():
            log("app closed gracefully")
            return
        time.sleep(1)
    raise SystemExit("glass-inject: Grok Bot still running after graceful close — "
                     "refusing to swap app.asar under a live app (close it and re-run)")


def launch_app(exe=DEFAULT_EXE):
    if IS_DARWIN:
        subprocess.Popen(["open", "-a", DEFAULT_APP_MAC])
        log("Grok Bot relaunched")
        return
    if not os.path.isfile(exe):
        log(f"WARN: cannot relaunch, missing {exe}")
        return
    subprocess.Popen(["cmd", "/c", "start", "", exe], shell=False)
    log("Grok Bot relaunched")


def run_asar(*args):
    """Run @electron/asar via npx (the proven toolchain).

    Windows: npx is a .cmd shim — CreateProcess can't exec it bare, so run the
    quoted command line through cmd.exe. macOS: exec npx directly.
    """
    if IS_DARWIN:
        r = subprocess.run(["npx", "--yes", "@electron/asar", *args],
                           capture_output=True, text=True, timeout=600)
    else:
        cmd = subprocess.list2cmdline(["npx", "--yes", "@electron/asar", *args])
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise SystemExit(f"glass-inject: asar {args[0]} failed:\n{r.stderr[-2000:]}")
    return r.stdout


def asar_header_hash(asar_path):
    """sha256 of the JSON header bytes — the exact payload the exe integrity
    block covers (proven: stock header JSON hashes to the value baked into
    Grok Bot.exe)."""
    with open(asar_path, "rb") as f:
        raw = f.read(16)
        json_len = struct.unpack("<IIII", raw)[3]
        return hashlib.sha256(f.read(json_len)).hexdigest()


def patch_exe_integrity(exe_path, asar_path):
    """Sync the exe's embedded asar-integrity value to the current asar header.

    Same-length hex swap (in-place); no-op when already in sync. Boot otherwise
    dies with: FATAL: asar_util.cc:143] Integrity check failed for asar archive.
    """
    want = asar_header_hash(asar_path)
    with open(exe_path, "rb") as f:
        blob = f.read()
    matches = list(EXE_INTEGRITY_RE.finditer(blob))
    if len(matches) != 1:
        raise SystemExit(f"glass-inject: exe integrity block count = {len(matches)} "
                         "!= 1 — layout changed (fail-loud)")
    have = matches[0].group(1).decode()
    if have == want:
        log(f"exe integrity already in sync ({want[:12]}…)")
        return want
    # one-time backup per exe build
    bk = os.path.join(state_dir(), f"GrokBot.exe.pre-glass-{sha256_file(exe_path)[:8]}")
    if not os.path.exists(bk):
        shutil.copy2(exe_path, bk)
        log(f"exe backup -> {bk}")
    patched = blob[:matches[0].start(1)] + want.encode() + blob[matches[0].end(1):]
    tmp = exe_path + ".glass-tmp"
    with open(tmp, "wb") as f:
        f.write(patched)
    os.replace(tmp, exe_path)
    log(f"exe integrity patched ({have[:12]}… -> {want[:12]}…)")
    return want

# --- macOS: Info.plist integrity carrier + ad-hoc re-seal -------------------

def read_plist_integrity_hash(plist_path=None):
    """Current ElectronAsarIntegrity hash from the bundle's Info.plist (the
    macOS carrier of the asar-integrity fuse; Windows bakes the same value
    into the exe)."""
    p = plist_path or os.path.join(DEFAULT_APP_MAC, "Contents", "Info.plist")
    with open(p, "rb") as f:
        node = plistlib.load(f).get("ElectronAsarIntegrity", {}).get(
            "Resources/app.asar", {})
    return node.get("hash", "MISSING")


def patch_plist_integrity(plist_path, asar_path):
    """Sync Info.plist ElectronAsarIntegrity to the current asar header hash.

    Editing Info.plist breaks the Apple seal, so the caller MUST ad-hoc
    re-sign the bundle afterwards. Returns the backup path (one per build).
    """
    want = asar_header_hash(asar_path)
    with open(plist_path, "rb") as f:
        pl = plistlib.load(f)
    node = pl.get("ElectronAsarIntegrity", {}).get("Resources/app.asar")
    if not node or "hash" not in node:
        raise SystemExit("glass-inject: ElectronAsarIntegrity missing in "
                         "Info.plist — layout changed (fail-loud)")
    bk = os.path.join(state_dir(),
                      f"Info.plist.pre-glass-{sha256_file(plist_path)[:8]}")
    if node["hash"] != want:
        if not os.path.exists(bk):
            shutil.copy2(plist_path, bk)
            log(f"Info.plist backup -> {bk}")
        node["hash"] = want
        tmp = plist_path + ".glass-tmp"
        with open(tmp, "wb") as f:
            plistlib.dump(pl, f, fmt=plistlib.FMT_BINARY)
        os.replace(tmp, plist_path)
        log(f"plist integrity patched ({want[:12]}…)")
    return bk


def _nested_code(bundle):
    """All nested code bundles (apps/frameworks/xpc), depth-first."""
    out = []
    for sub in ("Frameworks", "XPCServices", "Helpers"):
        d = os.path.join(bundle, "Contents", sub)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            full = os.path.join(d, name)
            if name.endswith((".app", ".framework", ".xpc")):
                out.append(full)
                out.extend(_nested_code(full))
    return out


MACHO_MAGICS = (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf",
                b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe",
                b"\xca\xfe\xba\xbe")


def _macho_leaves(bundle):
    """Loose Mach-O files under the bundle OUTSIDE any nested code bundle
    (nested .app/.framework/.xpc subtrees are skipped — their seal covers
    them, and on this build their internals stay vendor-signed: Electron
    Framework Helpers/* and Libraries/*.dylib still carry Team DCNK4UB866
    after a re-seal, which boots fine once library validation is off).
    What this DOES catch: the main executable and the app.asar.unpacked
    native .node modules — the latter are dlopen'd by the app process and
    are the leaves that must not keep a Team ID mismatch against the
    ad-hoc-signed main (belt-and-suspenders alongside dropping the
    hardened runtime, which is the decisive library-validation fix)."""
    out = []
    skip = set()
    for b in _nested_code(bundle):
        skip.add(b)
        for dirpath, _, _ in os.walk(b):
            skip.add(dirpath)
    for dirpath, _, filenames in os.walk(bundle):
        if dirpath in skip:
            continue
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            try:
                with open(full, "rb") as f:
                    if f.read(4) in MACHO_MAGICS:
                        out.append(full)
            except OSError:
                pass
    return sorted(out)


def _adhoc_sign_one(target, quiet=False):
    """Ad-hoc re-sign one target, preserving entitlements. NEVER adds
    --options=runtime: the hardened runtime exists for notarized Developer
    ID builds; on an ad-hoc build its library validation kills the app at
    dyld time ("mapping process and mapped file (non-platform) have
    different Team IDs") — proven on macOS 26.5.1 arm64."""
    ent_file = _entitlements_file_for(target)
    if ent_file is None:
        ent = subprocess.run(["codesign", "-d", "--entitlements", ":-", target],
                             capture_output=True, text=True).stdout
        if "<?xml" in ent[:200]:  # preserve entitlements when present
            with tempfile.NamedTemporaryFile("w", suffix=".entitlements",
                                             delete=False) as f:
                f.write(ent)
            ent_file = f.name
    cmd = ["codesign", "--force", "--sign", "-", "--timestamp=none"]
    if ent_file:
        cmd += ["--entitlements", ent_file]
    cmd.append(target)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"glass-inject: ad-hoc codesign failed for {target}:\n"
                         f"{r.stderr[-800:]}")
    if not quiet:
        log(f"ad-hoc signed: {target}")

VENDOR_MAIN_ENTITLEMENTS = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "entitlements",
    "grokbot-main-vendor.entitlements")


def _entitlements_file_for(target):
    """The main executable's vendor entitlements (apple-events/JIT/audio/
    camera) were captured from the pristine Developer ID build — a manual
    sign once stripped them and a 'preserve current' pass made that loss
    permanent. Restore them explicitly; other targets keep their current
    entitlements."""
    main_exe = os.path.join(DEFAULT_APP_MAC, "Contents", "MacOS", "Grok Bot")
    if os.path.abspath(target) == os.path.abspath(main_exe):
        if os.path.isfile(VENDOR_MAIN_ENTITLEMENTS):
            return VENDOR_MAIN_ENTITLEMENTS
        log("WARN: vendor main entitlements file missing — keeping current")
    return None


def adhoc_resign(app_bundle):
    """Re-seal the bundle ad-hoc: loose Mach-O leaves first, then nested code
    bundles deepest-first, then the root — preserving entitlements, dropping
    the hardened runtime (lethal library validation on ad-hoc builds). The
    vendor Developer ID signature cannot be reproduced locally — ad-hoc is
    the only in-place option after touching sealed resources (app.asar,
    Info.plist)."""

    leaves = _macho_leaves(app_bundle)
    if not leaves:
        raise SystemExit("glass-inject: no Mach-O leaves found in bundle — "
                         "layout changed (fail-loud)")
    log(f"ad-hoc signing {len(leaves)} loose Mach-O leaves")
    for t in leaves:
        _adhoc_sign_one(t, quiet=True)
    targets = sorted(set(_nested_code(app_bundle)),
                     key=lambda p: -p.count("/"))
    if not targets:
        raise SystemExit("glass-inject: no nested code found in bundle — "
                         "layout changed (fail-loud)")
    for t in targets:
        _adhoc_sign_one(t)
    _adhoc_sign_one(app_bundle)




def verify_signature(app_bundle):
    r = subprocess.run(["codesign", "--verify", "--deep", "--strict",
                        "--verbose=2", app_bundle],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("glass-inject: codesign --verify --deep --strict "
                         f"FAILED:\n{r.stdout}\n{r.stderr}")
    log("codesign --verify --deep --strict: OK")


def strip_quarantine(app_bundle):
    """Ad-hoc + com.apple.quarantine = Gatekeeper kill at launch — strip it."""
    subprocess.run(["xattr", "-dr", "com.apple.quarantine", app_bundle],
                   capture_output=True)


def restore_pair(asar_path, asar_bk, plist_bk):
    """Restore the same-run backup PAIR (asar + Info.plist) captured at the
    start of this apply, then ad-hoc re-seal. Never guesses a backup by glob
    (an old stock asar paired with a newer plist passes codesign but aborts
    Electron at boot). Asserts asar-header-hash == plist integrity hash after
    the restore — a mismatched pair fails loud instead of bricking boot.
    Full vendor-signature restoration requires reinstalling the app."""
    if not (asar_bk and os.path.isfile(asar_bk)):
        raise SystemExit(f"glass-inject: rollback impossible — backup asar "
                         f"missing: {asar_bk}")
    shutil.copy2(asar_bk, asar_path)
    log(f"restored asar <- {asar_bk}")
    if IS_DARWIN:
        if not (plist_bk and os.path.isfile(plist_bk)):
            raise SystemExit(f"glass-inject: rollback impossible — backup "
                             f"Info.plist missing: {plist_bk}")
        shutil.copy2(plist_bk,
                     os.path.join(DEFAULT_APP_MAC, "Contents", "Info.plist"))
        log(f"restored Info.plist <- {plist_bk}")
        if asar_header_hash(asar_path) != read_plist_integrity_hash():
            raise SystemExit("glass-inject: restored pair has mismatched "
                             "integrity hashes — refusing to re-seal "
                             "(fail-loud; do NOT launch)")
        adhoc_resign(DEFAULT_APP_MAC)
        verify_signature(DEFAULT_APP_MAC)
        strip_quarantine(DEFAULT_APP_MAC)


def unpacked_on_disk(asar_path):
    """The install's real unpacked-file set (resources/app.asar.unpacked/**).

    These files MUST stay `unpacked: true` in the repacked asar — inlining them
    kills main-process boot (native .node modules cannot load from asar). The
    install dir is authoritative and survives updates alongside the asar.
    """
    root = asar_path + ".unpacked"
    if not os.path.isdir(root):
        return []
    out = []
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            out.append(os.path.relpath(full, root).replace(os.sep, "/"))
    return sorted(out)


def unpacked_flags_in(asar_path):
    """Exact set of unpacked member paths from the asar header (used for the
    strict packed-artifact verification — a count alone can hide swaps)."""
    with open(asar_path, "rb") as f:
        raw = f.read(16)
        json_len = struct.unpack("<IIII", raw)[3]
        header = json.loads(f.read(json_len).decode("utf-8", "replace"))
    out = set()

    def walk(node, path=""):
        for name, v in node.get("files", {}).items():
            fp = (path + "/" + name).lstrip("/")
            if "files" in v:
                walk(v, fp)
            elif v.get("unpacked"):
                out.add(fp)

    walk(header)
    return out


def derive_unpack_plan(work, unp):
    """Map the unpacked set onto pack options for @electron/asar 4.3.1, all
    verified by argv-exact probes against the real Grok Bot tree:
      - repeated --unpack-dir / --unpack flags are last-wins, NOT cumulative
      - "{a,b}" brace patterns are mangled by the CLI (only the first
        alternative ever matches) — never emit braces
      - minimatch extglob "+(a|b)" passes through intact and works, including
        extensionless names, but ONLY with slash-free alternatives (a "|"
        alternative containing "/" matches nothing)
      - --unpack-dir patterns are matched against slash-relative dir paths
        (startsWith OR minimatch); --unpack is basename/matchBase

    Strategy: express ALL maximal fully-unpacked dirs as one extglob dir
    pattern "prefix/+(s1|s2|…)" (deepest common parent + slash-free suffixes),
    and ALL stray files as one extglob basename glob "+(b1|b2|…)". Ambiguity
    fails loud (never guess a wrong set).

    Returns (dir_pattern_or_None, file_glob_or_None).
    """
    all_files = []
    for dirpath, _, filenames in os.walk(work):
        for fn in filenames:
            all_files.append(os.path.relpath(os.path.join(dirpath, fn), work).replace(os.sep, "/"))
    unp_set = set(unp)

    # maximal directories whose subtree is entirely unpacked (a deeper group
    # must not block its parent — the parent covers strictly more)
    candidates = set()
    for rel in unp_set:
        parts = rel.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            prefix = "/".join(parts[:i])
            subtree = {f for f in all_files if f.startswith(prefix + "/")}
            if subtree and subtree <= unp_set:
                candidates.add(prefix)
    dirs = [p for p in candidates
            if not any(p != q and p.startswith(q + "/") for q in candidates)]
    covered = {f for d in dirs for f in all_files if f.startswith(d + "/")}
    leftovers = sorted(unp_set - covered)

    dir_pat = None
    if dirs:
        if len(dirs) == 1:
            dir_pat = dirs[0]
        else:
            # common-parent form "parent/+(s1|s2|…)" — the verified-working
            # shape (probe: dist/+(deps|native) → exact 26/26). Alternatives
            # must be slash-free single segments; multi-segment diverging
            # paths can't be expressed without braces → fail loud.
            parts = [d.split("/") for d in dirs]
            n = 0
            while n < len(parts[0]) and all(p[n] == parts[0][n] for p in parts[1:]):
                n += 1
            prefix = parts[0][:n]
            suffixes = ["/".join(p[n:]) for p in parts]
            if not prefix or any("/" in s for s in suffixes):
                raise SystemExit(
                    f"glass-inject: unpacked dirs {dirs} share no usable "
                    "slash-free extglob grouping (fail-loud)")
            dir_pat = "/".join(prefix) + "/+(" + "|".join(suffixes) + ")"

    glob = None
    if leftovers:
        # matchBase matching: a stray is expressible only if its basename is
        # unique across the whole tree
        base_count = {}
        for f in all_files:
            b = f.rsplit("/", 1)[-1]
            base_count[b] = base_count.get(b, 0) + 1
        for rel in leftovers:
            b = rel.rsplit("/", 1)[-1]
            if base_count.get(b, 0) != 1:
                raise SystemExit(f"glass-inject: unpacked file {rel} has ambiguous "
                                 "basename — cannot express pack options (fail-loud)")
        glob = "+(" + "|".join(rel.rsplit("/", 1)[-1] for rel in leftovers) + ")"
    return dir_pat, glob


def read_extracted_html(work):
    p = os.path.join(work, "dist", "renderer", "index.html")
    if not os.path.isfile(p):
        raise SystemExit(f"glass-inject: dist/renderer/index.html not found in asar — "
                         "layout changed, needs a human look (fail-loud by design)")
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def find_entry_js(work, html):
    """The renderer entry bundle, discovered from index.html's module script tag.

    The hash in the filename changes every release — reading the reference is
    the update-proof part (the proven injects hard-coded it and died on rename).
    """
    m = re.search(r'src="\./(assets/index-[^"]+\.js)"', html)
    if not m:
        raise SystemExit("glass-inject: renderer entry script not found in index.html "
                         "(fail-loud by design)")
    p = os.path.join(work, "dist", "renderer", m.group(1).replace("/", os.sep))
    if not os.path.isfile(p):
        raise SystemExit(f"glass-inject: entry bundle missing from asar: {m.group(1)}")
    return p


def patch_html(html):
    """CSP only (plus legacy injected-tag cleanup from earlier loader experiments).

    The HUD relays to http://127.0.0.1:8799; stock CSP connect-src blocks that.
    This is exactly the edit the known-good app.asar.liquidglass carried.
    """
    # strip legacy injected tag block (marker line + its script tag), if any
    html = re.sub(r"[ \t]*" + re.escape(MARKER_HTML) + r"\s*\n(\s*<script[^>]*gb-liquidglass\.js[^>]*></script>\s*\n)?", "", html)

    if CSP_CONNECT_ANCHOR not in html:
        if "http://127.0.0.1:*" in html:
            pass  # already extended on a previous pass
        else:
            raise SystemExit("glass-inject: CSP connect-src anchor not found and not "
                             "already extended — layout changed (fail-loud by design)")
    elif "http://127.0.0.1:*" not in html:
        html = html.replace(
            CSP_CONNECT_ANCHOR, CSP_CONNECT_ANCHOR + CSP_CONNECT_EXTRA, 1)
        if html.count("http://127.0.0.1:*") != 1:
            raise SystemExit("glass-inject: CSP patch applied != 1 time (fail-loud)")
    return html


def patch_entry(entry_path, hud_src):
    """Idempotent strip-then-append of the HUD at the end of the entry bundle —
    the proven injection shape (a new asar member broke renderer loading; a
    bundle tail append is what the known-good build used)."""
    with open(entry_path, "r", encoding="utf-8") as f:
        text = f.read()
    idx = text.find(MARKER_JS)
    if idx >= 0:
        text = text[:idx].rstrip()
    # the HUD master carries the marker in its own header — drop it so the
    # spliced bundle has exactly one marker (the block start)
    hud_body = hud_src.replace(MARKER_JS, "", 1).lstrip()
    text = text + "\n" + MARKER_JS + "\n" + hud_body + "\n"
    if text.count(MARKER_JS) != 1:
        raise SystemExit("glass-inject: entry splice marker count != 1 (fail-loud)")
    with open(entry_path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return entry_path


def is_patched(work, html):
    entry = find_entry_js(work, html)
    with open(entry, "r", encoding="utf-8") as f:
        return f.read().count(MARKER_JS) == 1


def inspect(asar_path, work):
    """Extract + report injection state. Returns (state, html, work)."""
    if os.path.isdir(work):
        shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)
    run_asar("extract", asar_path, work)
    html = read_extracted_html(work)
    state = "injected" if is_patched(work, html) else "stock"
    return state, html, work


def check(asar_path, hud_path, work):
    state, html, work = inspect(asar_path, work)
    entry = find_entry_js(work, html)
    log(f"asar: {asar_path}")
    log(f"sha256: {sha256_file(asar_path)[:16]}…  size: {os.path.getsize(asar_path)}")
    log(f"renderer entry: {os.path.relpath(entry, work)}")
    log(f"HUD source: {hud_path}")
    log(f"CSP extended: {'http://127.0.0.1:*' in html}")
    if IS_DARWIN:
        plist_val = read_plist_integrity_hash()
        hdr = asar_header_hash(asar_path)
        log(f"plist integrity: {plist_val[:12]}… (asar header: {hdr[:12]}…)")
        log(f"integrity in sync: {plist_val == hdr}")
        sig = subprocess.run(["codesign", "-dv", "--verbose=2", DEFAULT_APP_MAC],
                             capture_output=True, text=True).stderr
        authority = ("Developer ID" if "Developer ID Application" in sig
                     else "ad-hoc" if "Signature=adhoc" in sig else "unknown")
        log(f"bundle signature: {authority}")
    elif os.path.isfile(DEFAULT_EXE):
        with open(DEFAULT_EXE, "rb") as f:
            m = EXE_INTEGRITY_RE.search(f.read())
        exe_val = m.group(1).decode() if m else "MISSING"
        log(f"exe integrity: {exe_val[:12]}… (asar header: {asar_header_hash(asar_path)[:12]}…)")
        log(f"integrity in sync: {exe_val == asar_header_hash(asar_path)}")
    log(f"state: {state}")
    return EXIT_OK if state == "injected" else EXIT_STOCK


def apply(asar_path, hud_path, work, close_first):
    if app_running():
        if not close_first:
            raise SystemExit("glass-inject: Grok Bot is running — re-run with --close "
                             "to close it gracefully and continue")
        close_app()
    state, html, work = inspect(asar_path, work)
    if state == "injected":
        log("already injected — re-applying against current HUD (idempotent)")

    with open(hud_path, "r", encoding="utf-8") as f:
        hud_src = f.read()
    if "__grokbotLiquidGlassInjected" not in hud_src:
        raise SystemExit(f"glass-inject: {hud_path} does not look like the LiquidGlass "
                         "HUD (missing __grokbotLiquidGlassInjected guard) — refusing")

    html = patch_html(html)
    with open(os.path.join(work, "dist", "renderer", "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    entry = find_entry_js(work, html)
    patch_entry(entry, hud_src)
    log(f"spliced HUD into {os.path.relpath(entry, work)}")

    # preserve the install's unpacked native modules (else main-process boot dies)
    unp = unpacked_on_disk(asar_path)
    packed = os.path.join(state_dir(), "app.asar.glassbuild")
    if os.path.exists(packed):
        os.remove(packed)
    shutil.rmtree(packed + ".unpacked", ignore_errors=True)
    # @electron/asar >= 4 parses options only AFTER both positionals — an
    # option between <dir> and <output> is silently misparsed as the output
    # path (verified against 4.3.1; older Windows toolchains tolerated it)
    pack_args = ["pack", work, packed]
    if unp:
        dir_pat, glob = derive_unpack_plan(work, unp)
        if dir_pat:
            pack_args += ["--unpack-dir", dir_pat]
        if glob:
            pack_args += ["--unpack", glob]
        log(f"preserving {len(unp)} unpacked files: dir={dir_pat} files={glob}")
    run_asar(*pack_args)

    # verify the packed artifact before it goes anywhere near the install
    vwork = os.path.join(state_dir(), "verify-extract")
    vstate, vhtml, _ = inspect(packed, vwork)
    if vstate != "injected":
        raise SystemExit("glass-inject: packed asar failed verification (fail-loud)")
    if unp:
        want = set(unp)
        have = unpacked_flags_in(packed)
        if have != want:
            raise SystemExit(f"glass-inject: packed asar unpacked-set mismatch "
                             f"(lost {sorted(want - have)}, extra {sorted(have - want)}) "
                             "— fail-loud")
    log(f"packed + verified: {os.path.getsize(packed)} bytes sha {sha256_file(packed)[:12]}…")

    # --- guarded mutation: same-run backup PAIR, swap, integrity, re-seal ---
    # Every apply (including over an injected state) snapshots BOTH sealed
    # files as a timestamped pair; rollback restores exactly that pair and
    # re-asserts asar-header-hash == plist hash before re-sealing, so a
    # restore can never mix an old asar with a newer plist (codesign would
    # pass while Electron aborts at boot).
    stamp = time.strftime("%Y%m%d-%H%M%S")
    pair_asar_bk = os.path.join(state_dir(), f"app.asar.pre-glass-{stamp}")
    shutil.copy2(asar_path, pair_asar_bk)
    if IS_DARWIN:
        pair_plist_bk = os.path.join(state_dir(), f"Info.plist.pre-glass-{stamp}")
        shutil.copy2(os.path.join(DEFAULT_APP_MAC, "Contents", "Info.plist"),
                     pair_plist_bk)
        log(f"backup pair -> {pair_asar_bk} + {pair_plist_bk}")
    else:
        pair_plist_bk = None
        log(f"backup -> {pair_asar_bk}")

    def _rollback():
        restore_pair(asar_path, pair_asar_bk, pair_plist_bk)

    try:
        os.replace(packed, asar_path)
        post = sha256_file(asar_path)
        log(f"swapped in place — live sha {post[:16]}…")

        # post-swap verify: the file on disk really is the verified build
        p2 = os.path.join(state_dir(), "verify-post")
        pstate, _, _ = inspect(asar_path, p2)
        if pstate != "injected":
            raise SystemExit("glass-inject: POST-SWAP VERIFY FAILED")

        # Electron embedded-asar-integrity: macOS carries it in Info.plist (a
        # sealed file — the bundle is re-sealed ad-hoc after patching);
        # Windows embeds it in the exe.
        if IS_DARWIN:
            info_plist = os.path.join(DEFAULT_APP_MAC, "Contents", "Info.plist")
            patch_plist_integrity(info_plist, asar_path)
            if asar_header_hash(asar_path) != read_plist_integrity_hash():
                raise SystemExit("glass-inject: plist/asar hash drift after "
                                 "swap (fail-loud)")
            adhoc_resign(DEFAULT_APP_MAC)
            verify_signature(DEFAULT_APP_MAC)
            strip_quarantine(DEFAULT_APP_MAC)
            log("bundle re-sealed ad-hoc + codesign verify OK — ready to boot")
        elif os.path.isfile(DEFAULT_EXE):
            want = patch_exe_integrity(DEFAULT_EXE, asar_path)
            if asar_header_hash(asar_path) != want:
                raise SystemExit("glass-inject: header hash drift after swap "
                                 "(fail-loud)")
            log("exe integrity verified in sync — ready to boot")
        else:
            log(f"WARN: exe not found at {DEFAULT_EXE} — skipped integrity sync")
    except SystemExit:
        log("apply failed after mutation — restoring backup pair")
        _rollback()
        raise
    except Exception as e:
        log(f"apply error ({type(e).__name__}: {e}) — restoring backup pair")
        _rollback()
        raise
    return EXIT_OK


def watch(asar_path, hud_path, work, auto_relaunch, interval=30):
    log(f"watching {asar_path} every {interval}s (auto-relaunch={auto_relaunch})")
    last_state = None
    while True:
        try:
            if app_running():
                state, _, _ = inspect(asar_path, work)
                if state != "injected":
                    if not auto_relaunch:
                        if last_state != "stock-running":
                            log("stock detected while app RUNNING — waiting for exit "
                                "(use --auto-relaunch to heal immediately)")
                            last_state = "stock-running"
                    else:
                        log("stock detected while app RUNNING — healing (close + inject + relaunch)")
                        close_app()
                        apply(asar_path, hud_path, work, close_first=False)
                        launch_app()
                        last_state = "healed"
                else:
                    last_state = "injected"
            else:
                state, _, _ = inspect(asar_path, work)
                if state != "injected":
                    log("stock detected while app closed — healing")
                    apply(asar_path, hud_path, work, close_first=False)
                    last_state = "healed"
                else:
                    last_state = "injected"
        except SystemExit as e:
            log(f"ERROR: {e}")
        except Exception as e:
            log(f"ERROR: {type(e).__name__}: {e}")
        time.sleep(interval)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--asar", default=DEFAULT_ASAR)
    ap.add_argument("--hud", default=None)
    ap.add_argument("--work", default=os.path.join(state_dir(), "asar-work-glass"))
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--watch", action="store_true")
    ap.add_argument("--close", action="store_true",
                    help="gracefully close Grok Bot before swapping")
    ap.add_argument("--auto-relaunch", action="store_true",
                    help="watch mode: close + heal + relaunch instead of waiting")
    ap.add_argument("--interval", type=int, default=30)
    args = ap.parse_args()

    hud_path = resolve_hud(args.hud)
    if not os.path.isfile(args.asar):
        raise SystemExit(f"glass-inject: asar not found: {args.asar}")

    if args.watch:
        return watch(args.asar, hud_path, args.work, args.auto_relaunch, args.interval)
    if args.apply:
        return apply(args.asar, hud_path, args.work, args.close)
    return check(args.asar, hud_path, args.work)


if __name__ == "__main__":
    sys.exit(main())
