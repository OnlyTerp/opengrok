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
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)

MARKER_HTML = "<!--GROKBOT_LIQUIDGLASS_IN_APP_INJECTED-->"
MARKER_JS = "/*GROKBOT_LIQUIDGLASS_IN_APP_INJECTED*/"
LEGACY_SCRIPT_TAG = '<script defer src="./assets/gb-liquidglass.js"></script>'
CSP_CONNECT_ANCHOR = "connect-src 'self' ws: sand-media:"
CSP_CONNECT_EXTRA = " http://127.0.0.1:* http://localhost:*"

DEFAULT_ASAR = r"C:\Users\User\AppData\Local\Programs\Grok Bot\resources\app.asar"
DEFAULT_EXE = r"C:\Users\User\AppData\Local\Programs\Grok Bot\Grok Bot.exe"
MACHINE_HUD = r"C:\Users\User\.grokbot\grokbot-liquidglass.js"
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
    d = r"C:\Users\User\.grokbot"
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
    try:
        out = subprocess.run(
            ["cmd", "/c", "tasklist", "/fo", "csv", "/nh"],
            capture_output=True, text=True, timeout=30,
        ).stdout
    except Exception as e:
        raise SystemExit(f"glass-inject: tasklist failed: {e}")
    return any(line.lower().startswith('"grok bot.exe"') for line in out.splitlines())


def close_app():
    """Graceful close (WM_CLOSE) — the patch-live.ps1 ritual, then verify."""
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
    if not os.path.isfile(exe):
        log(f"WARN: cannot relaunch, missing {exe}")
        return
    subprocess.Popen(["cmd", "/c", "start", "", exe], shell=False)
    log("Grok Bot relaunched")


def run_asar(*args):
    """Run @electron/asar via npx (the proven toolchain on this box).

    npx is a .cmd shim — CreateProcess can't exec it bare, so run the quoted
    command line through cmd.exe (shell=True on Windows does exactly that).
    """
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


def read_unpacked_flag_count(asar_path):
    """Count unpacked entries in the asar header (formatting-proof JSON parse)."""
    with open(asar_path, "rb") as f:
        raw = f.read(16)
        json_len = struct.unpack("<IIII", raw)[3]
        header = json.loads(f.read(json_len).decode("utf-8", "replace"))
    count = 0

    def walk(node):
        nonlocal count
        for v in node.get("files", {}).values():
            if "files" in v:
                walk(v)
            elif v.get("unpacked"):
                count += 1

    walk(header)
    return count


def derive_unpack_plan(work, unp):
    """Map the unpacked set onto pack options: fully-unpacked subtrees become
    --unpack-dir groups; leftover files need globally-unique basenames for the
    matchBase --unpack pattern. Ambiguity fails loud (never guess a wrong set).

    Returns (dirs, basename_glob_or_None).
    """
    all_files = []
    for dirpath, _, filenames in os.walk(work):
        for fn in filenames:
            all_files.append(os.path.relpath(os.path.join(dirpath, fn), work).replace(os.sep, "/"))
    unp_set = set(unp)

    # maximal directories whose subtree is entirely unpacked (a deeper group must
    # not block its parent — both are valid, the parent just covers more)
    candidates = set()
    for rel in unp_set:
        parts = rel.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            prefix = "/".join(parts[:i])
            subtree = {f for f in all_files if f.startswith(prefix + "/")}
            if subtree and subtree <= unp_set:
                candidates.add(prefix)
    maximal = [p for p in candidates
               if not any(p != q and p.startswith(q + "/") for q in candidates)]
    # the pack CLI takes ONE --unpack-dir (repeated flags arrive as an array and
    # silently match nothing) — keep the largest fully-unpacked subtree as the
    # dir, fold the rest into basename leftovers
    maximal.sort(key=lambda p: -sum(1 for f in all_files if f.startswith(p + "/")))
    dirs, covered = [], set()
    for prefix in maximal:
        subtree = {f for f in all_files if f.startswith(prefix + "/")}
        if not dirs:
            dirs.append(prefix)
        covered |= subtree

    leftovers = sorted(unp_set - covered)
    if dirs and not leftovers and len(maximal) > 1:
        pass
    covered_directories = set()
    if dirs:
        covered_directories = {f for f in all_files if f.startswith(dirs[0] + "/")}
    leftovers = sorted(unp_set - covered_directories)
    if not leftovers:
        return dirs, None

    # matchBase matching: a leftover is expressible only if its basename is unique
    base_count = {}
    for f in all_files:
        b = f.rsplit("/", 1)[-1]
        base_count[b] = base_count.get(b, 0) + 1
    for rel in leftovers:
        b = rel.rsplit("/", 1)[-1]
        if base_count.get(b, 0) != 1:
            raise SystemExit(f"glass-inject: unpacked file {rel} has ambiguous "
                             "basename — cannot express pack options (fail-loud)")
    glob = "{" + ",".join(rel.rsplit("/", 1)[-1] for rel in leftovers) + "}" \
        if len(leftovers) > 1 else leftovers[0].rsplit("/", 1)[-1]
    return dirs, glob


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
    if os.path.isfile(DEFAULT_EXE):
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
    pack_args = ["pack", work]
    if unp:
        dirs, glob = derive_unpack_plan(work, unp)
        # --unpack-dir matches via literal prefix on the OS-relative dir path
        for d in dirs:
            pack_args += ["--unpack-dir", d.replace("/", os.sep)]
        if glob:
            pack_args += ["--unpack", glob]
        log(f"preserving {len(unp)} unpacked files: dirs={dirs} files={glob}")

    packed = os.path.join(state_dir(), "app.asar.glassbuild")
    if os.path.exists(packed):
        os.remove(packed)
    shutil.rmtree(packed + ".unpacked", ignore_errors=True)
    run_asar(*pack_args, packed)

    # verify the packed artifact before it goes anywhere near the install
    vwork = os.path.join(state_dir(), "verify-extract")
    vstate, vhtml, _ = inspect(packed, vwork)
    if vstate != "injected":
        raise SystemExit("glass-inject: packed asar failed verification (fail-loud)")
    if unp and read_unpacked_flag_count(packed) != len(unp):
        raise SystemExit(f"glass-inject: packed asar lost unpacked flags "
                         f"({read_unpacked_flag_count(packed)} != {len(unp)}) — fail-loud")
    log(f"packed + verified: {os.path.getsize(packed)} bytes sha {sha256_file(packed)[:12]}…")

    # backup the live asar (pre-glass) and swap atomically
    if state != "injected":
        bk = os.path.join(state_dir(), f"app.asar.pre-glass-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(asar_path, bk)
        log(f"backup -> {bk}")
    os.replace(packed, asar_path)
    post = sha256_file(asar_path)
    log(f"swapped in place — live sha {post[:16]}…")

    # post-swap verify: the file on disk really is the verified build
    p2 = os.path.join(state_dir(), "verify-post")
    pstate, _, _ = inspect(asar_path, p2)
    if pstate != "injected":
        raise SystemExit("glass-inject: POST-SWAP VERIFY FAILED — restore from backup!")
    log("post-swap verify: injected OK")

    # Electron embedded-asar-integrity: sync the exe or boot dies FATAL
    if os.path.isfile(DEFAULT_EXE):
        want = patch_exe_integrity(DEFAULT_EXE, asar_path)
        if asar_header_hash(asar_path) != want:
            raise SystemExit("glass-inject: header hash drift after swap (fail-loud)")
        log("exe integrity verified in sync — ready to boot")
    else:
        log(f"WARN: exe not found at {DEFAULT_EXE} — skipped integrity sync")
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
