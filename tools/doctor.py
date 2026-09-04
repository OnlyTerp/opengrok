#!/usr/bin/env python3
"""grok-native doctor — find every failure point BEFORE it bites.

Checks (each maps to a registered failure mode in docs/FAILURE-MODES.md, F01–F18):

  SERVICES      expected listening sockets + identity probes
  AUTH/BINDING  model-bindings.json integrity (count, names, SHA drift)
  CONFIG DRIFT  hermes config.yaml provider flags (discover_models, vision)
  FILES         SHA baselines of the pieces that must never silently change
  GROK CACHE    models_cache.json age/version (silent-update detector)
  PERSISTENCE   Startup VBS launchers present

Modes:
  default        human report, exit 0 clean / 2 if FAIL / 1 if new WARN
  --init         capture current state as baseline (records known WARNs)
  --quiet        print NOTHING when clean (cron watchdog mode);
                 prints only problems otherwise; same exit codes
  --json         machine report to stdout (adds PIDs/timestamp detail)
  --fix          SAFE auto-heals ONLY: hermes-hop relaunch via its VBS,
                 claude-shim via canonical restart-shim.py, antigravity via
                 its Startup VBS. Never force-kills a live listener.
"""
from __future__ import annotations

import json
import os
import platform
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent          # tools/
HOME = Path.home()
BASE_DIR = HERE.parent                       # repo root (portable; baseline lives with the repo)
BASELINE = BASE_DIR / "baseline.json"
STARTUP = Path(os.environ.get("APPDATA", str(HOME / "AppData" / "Roaming"))) / \
    "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"

def _first_existing(candidates: list[str]) -> Path:
    for c in candidates:
        if c:
            p = Path(c).expanduser()
            if p.exists():
                return p
    return Path(candidates[0]).expanduser() if candidates[0] else Path(candidates[-1]).expanduser()

# Hermes config.yaml — Windows default first, then common Unix locations.
HERMES_CFG = _first_existing([
    str(Path(os.environ.get("LOCALAPPDATA", str(HOME / "AppData" / "Local"))) / "hermes" / "config.yaml"),
    str(HOME / ".config" / "hermes" / "config.yaml"),
    str(HOME / ".hermes" / "config.yaml"),
])
# Bindings — same candidate shapes setup.py writes/adopts (first existing wins).
BINDINGS_CANDIDATES = [HOME / ".grokbot" / "model-bindings.json"]
for _appdir in (HOME / "AppData" / "Roaming" / "Grok Bot",
                HOME / ".config" / "Grok Bot",
                HOME / "Library" / "Application Support" / "Grok Bot"):
    BINDINGS_CANDIDATES.append(_appdir / "model-bindings.json")
BINDINGS_CANDIDATES.append(BASE_DIR / "model-bindings.json")
BINDINGS = next((p for p in BINDINGS_CANDIDATES if p.exists()), BINDINGS_CANDIDATES[0])

# --- service expectations -------------------------------------------------
# (port, name, probe) probe=None -> TCP-only; fn -> callable returning (bool,str)
def tcp(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.6)
        return s.connect_ex(("127.0.0.1", port)) == 0

def probe_url(url: str, want: str | None = None) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(url, timeout=4) as r:
            body = r.read(400).decode("utf-8", "replace")
            if want and want not in body:
                return False, f"unexpected body @ {url}"
            return True, f"{r.getcode()} @{url}"
    except urllib.error.HTTPError as e:
        return (e.code == int(want or -1)), f"HTTP {e.code} @{url}"
    except Exception as exc:
        return False, f"{type(exc).__name__} @{url}"

EXPECTED_UP = []
SERVICES_CFG_CANDIDATES = [   # repo-root services.json (setup.py writes here) wins; then state dirs
    HERE.parent / "services.json",
    BASE_DIR.parent / "services.json",
    BASE_DIR / "services.json",
]
SERVICES_CFG = next((p for p in SERVICES_CFG_CANDIDATES if p.exists()), None)
if SERVICES_CFG:
    try:
        _cfg = json.loads(SERVICES_CFG.read_text(encoding="utf-8"))
        for _s in _cfg.get("services", []):
            _url = _s.get("probe_url") or f"http://127.0.0.1:{_s['port']}/health"
            EXPECTED_UP.append((_s["port"], _s.get("name", f"svc-{_s['port']}"),
                                (lambda u=_url, w=_s.get("probe_want"): (lambda: probe_url(u, w)))()))
    except Exception:
        print("[WARN] services.json unreadable — using built-in defaults", file=sys.stderr)
        SERVICES_CFG = None
if not SERVICES_CFG:  # fallback: our production table (kept so doctor works out-of-box for us)
    EXPECTED_UP = [
        (8642,  "hermes api_server", lambda: probe_url("http://127.0.0.1:8642/v1/models", "401")),
        (18790, "hermes-hop",        lambda: probe_url("http://127.0.0.1:18790/healthz", '"upstream_reachable": true')),
        (18776, "claude-shim",       None),
        (18777, "codex-shim",        None),
        (18778, "antigravity-shim",  None),
        (18779, "grok-shim",         lambda: probe_url("http://127.0.0.1:18779/health")),
        (30000, "llama-server slot",  lambda: probe_url("http://127.0.0.1:30000/v1/models", '"models"')),  # identity-agnostic: slot serves qwen/ornith per season; body must be a models list
    ]

WATCHED_FILES = [BINDINGS]
WATCHED_CFG = next((p for p in SERVICES_CFG_CANDIDATES if (p.parent / "watched-files.json").exists()), None)
try:
    _wf = json.loads((WATCHED_CFG.parent / "watched-files.json").read_text(encoding="utf-8")) if WATCHED_CFG else []
    WATCHED_FILES += [Path(p) for p in _wf if Path(p).exists()]
except Exception:
    print("[WARN] watched-files.json unreadable — watching bindings only", file=sys.stderr)
for _p in [HERE / "provider-maps.cjs", HERE / "test-provider-maps.cjs",
           HERE / "provider-maps-hop.cjs", HERE / "test-provider-maps-hop.cjs"]:   # repo's own maps always watched
    if _p.exists() and _p not in WATCHED_FILES: WATCHED_FILES.append(_p)
PERSISTENCE_DEFAULT = ["claude-shim.vbs", "codex-shim.vbs", "antigravity-shim.vbs",
                       "hermes-hop.vbs", "start_gmsg_daemon.vbs", "start_sms_lane.vbs"]
PERSISTENCE = PERSISTENCE_DEFAULT
if SERVICES_CFG:
    try:
        _pers = json.loads(SERVICES_CFG.read_text(encoding="utf-8")).get("persistence")
        if isinstance(_pers, list) and _pers:
            PERSISTENCE = [str(x) for x in _pers]   # setup.py recorded YOUR launchers
    except Exception:
        pass

results: list[tuple[str, str, str]] = []  # level, tag, detail
def emit(level: str, tag: str, detail: str) -> None:
    results.append((level, tag, detail))

def sha(p: Path) -> str:
    import hashlib
    return hashlib.sha256(p.read_bytes()).hexdigest()

# --- checks -----------------------------------------------------------------
def check_services() -> None:
    for port, name, probe in EXPECTED_UP:
        if not tcp(port):
            emit("FAIL", f"svc:{name}", f":{port} NOT LISTENING")
            continue
        if probe is None:
            emit("PASS", f"svc:{name}", f":{port} tcp up")
        else:
            ok, detail = probe()
            (emit("PASS" if ok else "FAIL", f"svc:{name}", f":{port} {detail}"))
    # identity spot-check: hermes-hop stream stays SSE-capable header-wise is POST-proven separately;
    # grok-shim auth token presence rides its /health body (want filter covers 200 only).

def check_bindings() -> dict:
    meta: dict = {}
    if not BINDINGS.exists():
        emit("FAIL", "bindings", "model-bindings.json MISSING")
        return meta
    try:
        data = json.loads(BINDINGS.read_text(encoding="utf-8"))
        agents = data.get("agents", data)
        n = len(agents)
        names = sorted(a.get("name", "?") for a in agents.values() if isinstance(a, dict))
        meta = {"agent_count": n, "names": names, "sha": sha(BINDINGS)}
        emit("PASS", "bindings:parse", f"{n} agents")
    except Exception as exc:
        emit("FAIL", "bindings:parse", repr(exc))
        return meta
    # liveness coupling: only hops doctor is EXPECTED to monitor. Remote/box
    # hops (live elsewhere) must not be flagged. A binding pointing at a DOWN
    # local hop that doctor owns IS a real outage.
    expected_ports = {p for p, _n, _pr in EXPECTED_UP}
    txt = BINDINGS.read_text(encoding="utf-8")
    for port in sorted({int(m.group(1)) for m in re.finditer(r"127\.0\.0\.1:(\d+)", txt)}):
        if port in expected_ports and not tcp(port):
            emit("FAIL", "bindings:liveness-coupling", f":{port} bindings route here but NOT LISTENING")
    return meta

def check_config() -> dict:
    txt = HERMES_CFG.read_text(encoding="utf-8") if HERMES_CFG.exists() else ""
    flags: dict = {}
    if not txt:
        # Optional component: not everyone runs Hermes. WARN, never FAIL.
        emit("WARN", "config", f"hermes config.yaml not found ({HERMES_CFG})")
        return flags
    # discover_models flips (flood guard) — crude block scan keeps deps zero
    for block in re.split(r"\n(?=\S)", txt):
        m = re.match(r"^([a-zA-Z0-9_\-]+):\s*$", block)
        if not m or "\n  base_url" not in block:
            continue
        prov = m.group(1)
        dm = re.search(r"discover_models:\s*(\w+)", block)
        sv = len(re.findall(r"supports_vision:\s*[Tt]rue", block))
        flags[prov] = {"discover_models": dm.group(1) if dm else None, "vision_true_count": sv}
    return flags

def check_grok_cache() -> dict:
    p = HOME / ".grok" / "models_cache.json"
    info: dict = {}
    if not p.exists():
        emit("WARN", "grok-cache", "models_cache.json missing")
        return info
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        fetched = d.get("fetched_at", "")
        ver = d.get("grok_version", "?")
        cnt = len(d.get("models", {}))
        info = {"fetched_at": fetched, "grok_version": ver, "model_count": cnt}
        age_days = (datetime.now(timezone.utc)
                    - datetime.fromisoformat(fetched.replace("Z", "+00:00"))).days if fetched else 999
        if age_days > 14:
            emit("WARN", "grok-cache", f"stale {age_days}d (silent-update suspect)")
        else:
            emit("PASS", "grok-cache", f"age={age_days}d v{ver} models={cnt}")
    except Exception as exc:
        emit("FAIL", "grok-cache", repr(exc))
    return info

def check_persistence() -> None:
    if platform.system() != "Windows":
        # VBS launchers are the Windows persistence shape; other OSes use
        # systemd/launchd units (out of scope for the built-in table).
        emit("WARN", "startup:vbs", f"persistence checks are Windows-VBS only (this is {platform.system()})")
        return
    for vbs in PERSISTENCE:
        ok = (STARTUP / vbs).exists()
        emit("PASS" if ok else "WARN", "startup:vbs", f"{vbs} {'present' if ok else 'MISSING'}")

# --- fix ---------------------------------------------------------------------
def try_fix(dead_names: list[str]) -> None:
    fixes = {
        "hermes-hop": ["cscript", "//nologo", str(STARTUP / "hermes-hop.vbs")],
        "antigravity-shim": ["cscript", "//nologo", str(STARTUP / "antigravity-shim.vbs")],
    }
    if "claude-shim" in dead_names:
        rd = os.environ.get("CLAUDE_SHIM_DIR") or (HOME / ".claude-shim")
        if (rd / "restart-shim.py").exists():
            r = subprocess.run([sys.executable, "restart-shim.py"], cwd=rd,
                               capture_output=True, text=True, timeout=240)
            emit("INFO", "fix:claude-shim", f"restart-shim rc={r.returncode}")
        else:
            emit("WARN", "fix:claude-shim", "canonical restart-shim.py not found; MANUAL")
    for nm in dead_names:
        cmd = fixes.get(nm)
        if not cmd:
            continue
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        emit("INFO", f"fix:{nm}", f"launcher rc={r.returncode}")

# --- main ----------------------------------------------------------------------
def run(fix: bool) -> tuple[int, str]:
    check_services()
    bmeta = check_bindings()
    cfgflags = check_config()
    gcache = check_grok_cache()
    check_persistence()
    file_shas = {}
    for p in WATCHED_FILES:
        file_shas[str(p)] = sha(p) if p.exists() else "MISSING"

    base: dict = {}
    if BASELINE.exists():
        base = json.loads(BASELINE.read_text(encoding="utf-8"))

    # diffs vs baseline
    kbase = base.get("files", {})
    for path, h in file_shas.items():
        if path in kbase and kbase[path] != h:
            short = Path(path).name
            emit(h == "MISSING" and "FAIL" or "WARN", "drift:file",
                 f"{short} changed vs baseline (review; re-run --init to accept)")
    kb = base.get("bindings", {})
    if kb and (kb.get("sha") != bmeta.get("sha")):
        emit("WARN", "drift:bindings", f"agent sha changed ({kb.get('sha','')[:8]}…->{bmeta.get('sha','')[:8]}…)")
    kc = base.get("config_flags", {})
    for prov, cur in cfgflags.items():
        prev = kc.get(prov)
        if prev and prev["discover_models"] == "False" and cur["discover_models"] == "True":
            emit("WARN", "drift:config", f"{prov} discover_models flipped FALSE->TRUE (flood risk)")

    fails = [r for r in results if r[0] == "FAIL"]
    warns = [r for r in results if r[0] == "WARN"]
    # Known-warning keys MUST use the exact same format --init stores (LEVEL::tag::detail).
    known = set(base.get("known_warnings", []))
    new_warns = [w for w in warns if f"{w[0]}::{w[1]}::{w[2]}" not in known]

    payload = {
        "generated_for": "grok-native-lockdown",
        "services_ok": not fails and not new_warns,
        "fail": [{"tag": t, "detail": d} for _, t, d in fails],
        "new_warn": [{"tag": t, "detail": d} for _, t, d in new_warns],
        "known_warn_count": len(warns) - len(new_warns),
        "bindings_agent_count": bmeta.get("agent_count"),
        "grok_cache": gcache,
    }

    if fix and fails:
        dead = [t.split(":")[1] for lvl, t, _ in results
                if lvl == "FAIL" and t.startswith("svc:")]
        try_fix(dead)

    def fmt(level, tag, detail):
        return f"[{level}] {tag} :: {detail}"
    human = "\n".join(fmt(*r) for r in results) or "ALL GREEN"
    summary = f"\nSUMMARY: {len(fails)} fail, {len(new_warns)} new warn, {len(warns)-len(new_warns)} known warn"

    if "--init" in sys.argv:
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps({
            "captured": datetime.now().isoformat(timespec="seconds"),
            "files": file_shas,
            "bindings": {k: bmeta.get(k) for k in ("sha", "agent_count")},
            "config_flags": cfgflags,
            "known_warnings": [f"{lvl}::{t}::{d}" for lvl, t, d in results if lvl == "WARN"],
        }, indent=1), encoding="utf-8")
        human += "\nBASELINE WRITTEN -> " + str(BASELINE)
        return 0, human + summary

    if "--json" in sys.argv:
        return (2 if fails else (1 if new_warns else 0)), json.dumps(payload, indent=1)

    if "--quiet" in sys.argv:
        if not fails and not new_warns:
            return 0, ""                       # SILENT when clean
        out = "\n".join(fmt("FAIL" if l == "FAIL" else "WARN", t, d)
                        for l, t, d in fails + new_warns)
        return (2 if fails else 1), out

    return (2 if fails else (1 if new_warns else 0)), human + summary


if __name__ == "__main__":
    code, out = run("--fix" in sys.argv)
    if out:
        print(out)
    sys.exit(code)
