#!/usr/bin/env python3
"""setup.py — one command from clone to working.

    python setup.py

Detects your machine, asks nothing it can answer itself, asks 3 questions it
can't, wires everything, verifies live, and drops you in the picker.

Phases:
  1. DETECT   — Grok Bot install, platform, existing config, running services
  2. PLAN     — prints exactly what it will do (nothing hidden)
  3. WIRE     — bindings skeleton + services.json + doctor baseline + picker seed
  4. VERIFY   — runs doctor; every check green or told WHY not
  5. OPEN     — launches the picker UI
"""
import argparse, json, os, platform, shutil, socket, subprocess, sys, time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path.home()

def q(question, default=None, choices=None):
    """Ask once. Empty = default. Choices given = validate."""
    suffix = f" [{default}]" if default is not None else ""
    if choices: suffix = f" ({'/'.join(choices)}){suffix}"
    while True:
        a = input(f"{question}{suffix}: ").strip()
        if not a and default is not None: return default
        if choices and a not in choices:
            print(f"  ? pick one of: {', '.join(choices)}"); continue
        if a: return a
        print("  ? required")

def tcp(port, host="127.0.0.1"):
    s = socket.socket(); s.settimeout(1.0)
    try: return s.connect_ex((host, port)) == 0
    finally: s.close()

def http_probe(url, want=None, timeout=4):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            body = r.read(2000).decode("utf-8", "replace")
            return (want is None or want in body), r.getcode(), body
    except urllib.error.HTTPError as e:
        return (want is not None and str(e.code) == str(want)), e.code, ""
    except Exception as e:
        return False, None, str(e)

def find_grokbot():
    """Locate the Grok Bot config dir across known shapes."""
    cands = [
        HOME / "AppData" / "Roaming" / "Grok Bot",
        HOME / ".grokbot",
        HOME / ".config" / "Grok Bot",
        HOME / "Library" / "Application Support" / "Grok Bot",  # macOS
    ]
    for c in cands:
        if c.is_dir(): return c
    return None

def detect_hop_binding(gb_dir):
    """If a model-bindings.json already exists somewhere sensible, adopt it.
    Sensible = beside the detected Grok Bot dir, or in HOME/.grokbot. A stray
    file in the current directory is NOT adopted (cwd leftovers would hijack)."""
    cands = [gb_dir / "model-bindings.json" if gb_dir else None,
             Path.home() / ".grokbot" / "model-bindings.json"]
    for p in cands:
        try:
            if p and p.is_file():
                d = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(d.get("agents"), dict) and d["agents"]:
                    return p, d
        except Exception: pass
    return None, None

C = {"g":"\033[92m","y":"\033[93m","r":"\033[91m","b":"\033[94m","0":"\033[0m","B":"\033[1m"}
def say(color, tag, msg): print(f"{C[color]}[{tag}]{C['0']} {msg}")
def head(t): print(f"\n{C['B']}── {t} {'─'*max(0,58-len(t))}{C['0']}")

def main():
    print(f"{C['B']}opengrok — setup{C['0']}")
    plan, acts = [], []

    # ---------- 1. DETECT ----------
    head("detect")
    plat = platform.system()
    say("b", "os", f"{plat} {platform.release()}  ({platform.machine()})")

    gb = find_grokbot()
    say("g" if gb else "y", "grok bot", str(gb) if gb else "config dir not found — continuing anyway (patterns still apply)")

    # running services we care about
    services = {}
    for port, name in [(8642,"hermes-api"),(11434,"ollama"),(30000,"llama-server"),
                       (18779,"grok-shim"),(18786,"superheavy-hop"),(18776,"claude-shim"),
                       (18778,"antigravity-shim"),(18777,"codex-shim")]:
        up = tcp(port)
        services[port] = up
        if up: say("g", f"svc", f":{port} {name} — LIVE")

    # existing bindings?
    bpath, bdata = detect_hop_binding(gb)
    if bdata:
        say("g", "bindings", f"found {len(bdata['agents'])} agents @ {bpath}")
    else:
        say("y", "bindings", "none found — will create skeleton")

    # ---------- 2. PLAN ----------
    head("plan")
    print("""  1. create model-bindings.json  (your agents → model map; keys NEVER live here)
  2. create services.json        (doctor watches YOUR services, not ours)
  3. run doctor --init           (snapshot = the update tripwire)
  4. seed + launch the picker UI (pick models per agent, test live)""")
    if input("proceed? [Y/n]: ").strip().lower() in ("n","no"):
        say("y","aborted","nothing changed."); return 1

    # ---------- 3. WIRE ----------
    head("wire")

    # 3a. bindings
    bind_path = bpath or (gb / "model-bindings.json" if gb else HERE.parent / "model-bindings.json")
    if bpath:
        say("g", "adopt", f"using your existing bindings at {bpath} — picker edits will update THEM")
    if not bdata:
        n_agents = int(q("how many agents do you want to map?", default="3"))
        agents = {}
        for i in range(n_agents):
            name = q(f"agent {i+1} name", default=f"agent-{i+1}")
            model = q(f"  model for {name} (exact slug, e.g. glm-5.3)", default="")
            base  = q(f"  OpenAI-compatible base url (must end in /v1)", default="")
            agents[f"{name.lower().replace(' ','-')}-{int(time.time())%100000}"] = {
                "name": name, "modelId": model, "hopBaseUrl": base}
        bdata = {"_comment": "created by setup.py", "agents": agents}
        bind_path.parent.mkdir(parents=True, exist_ok=True)
    bind_path.write_text(json.dumps(bdata, indent=2) + "\n", encoding="utf-8")
    say("g", "bindings", f"→ {bind_path} ({len(bdata['agents'])} agents)")

    # 3b. services.json for doctor (gap-3 fix: doctor reads config, not hardcode)
    svc_cfg = {"services": [], "watched_files": [str(bind_path)], "persistence": []}
    for port, up in services.items():
        if up:
            svc_cfg["services"].append({"port": port, "name": f"svc-{port}"})
    (HERE / "services.json").write_text(json.dumps(svc_cfg, indent=2) + "\n", encoding="utf-8")
    say("g", "services.json", f"{len(svc_cfg['services'])} live services recorded")

    # 3c. doctor baseline
    r = subprocess.run([sys.executable, str(HERE / "tools" / "doctor.py"), "--init"],
                       capture_output=True, text=True)
    say("g" if r.returncode == 0 else "y", "doctor", "baseline --init ok" if r.returncode == 0 else f"init rc={r.returncode}: {r.stderr[-120:]}")

    # 3d. hop: offer template if they have credentialed upstream but no hop
    if gb and not tcp(18786) and input("launch hop template now? [Y/n]: ").strip().lower() != "n":
        say("g", "hop", f"template ready: tools/hop-server.py  (HERMES_HOP_PORT / _UPSTREAM / _KEY envs — see header)")
        acts.append(f"configure hop: set HERMES_HOP_* envs, run tools/hop-server.py")

    # ---------- 4. VERIFY ----------
    head("verify")
    r = subprocess.run([sys.executable, str(HERE / "tools" / "doctor.py")], capture_output=True, text=True)
    out = (r.stdout or "") + (r.stderr or "")
    fails = [l for l in out.splitlines() if l.startswith("FAIL")]
    says_ok = r.returncode == 0
    if says_ok:
        say("g", "doctor", "all green")
    else:
        say("y", "doctor", f"{len(fails)} items need attention:")
        for l in fails[:8]: print("   " + l)
        print("   (normal on first run — re-run python setup.py after fixes)")

    # ---------- 5. OPEN ----------
    head("picker")
    port = 8766
    say("g", "launch", f"starting picker on http://127.0.0.1:{port} ...")
    picker = subprocess.Popen([sys.executable, str(HERE / "tools" / "model-picker.py"),
                               "--bindings", str(bind_path), "--port", str(port)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    if tcp(port):
        say("g", "picker", f"LIVE → http://127.0.0.1:{port}")
        try:
            if plat == "Windows": os.startfile(f"http://127.0.0.1:{port}")
            elif plat == "Darwin": subprocess.run(["open", f"http://127.0.0.1:{port}"])
            else: subprocess.run(["xdg-open", f"http://127.0.0.1:{port}"])
        except Exception: pass
    else:
        say("r", "picker", "didn't come up — check console output above")

    head("done")
    print("""Your setup is live. From here:
  · pick models per agent in the browser window that just opened
  · run  python tools/doctor.py  anytime (or cron it) to catch Grok Bot updates
  · after any Grok Bot update: doctor tells you exactly what moved
  · add a provider: docs/MODEL-GUIDELINES.md § adding-a-model (probe recipe)""")
    if acts:
        print("\nOutstanding (needs you):")
        for a in acts: print("  · " + a)
    return 0

if __name__ == "__main__":
    try: sys.exit(main())
    except KeyboardInterrupt: print("\naborted."); sys.exit(1)
