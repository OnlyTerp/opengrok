#!/usr/bin/env python3
"""Install opengrok onto a STOCK Grok Bot cloud computer.

Upstream `apply-box-patch.py` edits a private OpenAI-hop host that does not
ship in Grok Bot 0.30 (issues #3, #5). This installer:

  1. Copies hop + runtime + maps into /home/box/sand-data
  2. Writes a wildcard model-bindings.json (keys never go in this file)
  3. Wraps createProtoSessionProvider in host-main.cjs (backed up first)
  4. Optionally starts hop-server.py against your OpenAI-compatible upstream

Run ON the box:

    export API_SERVER_KEY='...'          # hop injects this; not written to bindings
    python3 install-stock-box.py \\
        --upstream http://127.0.0.1:8642 \\
        --model glm-5.3-flash

Re-run is idempotent. `--census-only` prints host symbols and writes nothing.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import wrap_proto_session  # noqa: E402

DEFAULT_HOST = "/home/box/sand-host/host-main.cjs"
DEFAULT_DATA = "/home/box/sand-data"


def die(msg: str) -> None:
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(1)


def node_check(path: Path) -> None:
    r = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
    if r.returncode != 0:
        die("node --check %s failed:\n%s" % (path, r.stderr))
    print("  ok: node --check %s" % path)


def copy_tool(name: str, dest_dir: Path) -> Path:
    src = HERE / name
    if not src.is_file():
        die("missing %s (run this from a full checkout)" % src)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / name
    shutil.copy2(src, dest)
    print("  copy %s -> %s" % (name, dest))
    return dest


def write_bindings(path: Path, model: str, hop_base: str, agent_id: str) -> None:
    agents = {}
    if path.is_file():
        try:
            agents = json.loads(path.read_text(encoding="utf-8")).get("agents") or {}
        except Exception:
            agents = {}
    entry = {
        "name": model,
        "modelId": model,
        "provider": "custom",
        "hopBaseUrl": hop_base,
        "maxMode": False,
        "parameters": [{"id": "fast", "value": "true"}],
    }
    agents[agent_id] = entry
    if "*" not in agents:
        agents["*"] = dict(entry)
        agents["*"]["name"] = model + " (wildcard)"
    doc = {"_comment": "created by install-stock-box.py; never put credentials here", "agents": agents}
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print("  bindings -> %s (%d agents)" % (path, len(agents)))


def main() -> int:
    ap = argparse.ArgumentParser(description="Install opengrok on a stock Grok Bot box")
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--data", default=DEFAULT_DATA)
    ap.add_argument("--model", default="glm-5.3-flash")
    ap.add_argument("--upstream", default="", help="OpenAI-compatible origin WITHOUT /v1 (hop injects the key)")
    ap.add_argument("--hop-port", type=int, default=18790)
    ap.add_argument("--agent-id", default="*", help="bindings key; * matches every conversation")
    ap.add_argument("--census-only", action="store_true")
    ap.add_argument("--skip-hop", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    host = Path(args.host)
    data = Path(args.data)
    if not host.is_file():
        die("host not found: %s" % host)

    src = host.read_text(encoding="utf-8")
    c = wrap_proto_session.census(src)
    print("== census %s ==" % host)
    print(json.dumps(c, indent=2))
    if args.census_only:
        return 0

    if c["createOpenAiHopSession"] and c["resolvedOpenaiBaseUrl"]:
        print("  this host still has the private OpenAI hop lane.")
        print("  use tools/apply-box-patch.py instead of this installer.")
        return 1

    hop_base = "http://127.0.0.1:%d/v1" % args.hop_port
    runtime_dest = data / "opengrok-runtime.cjs"

    try:
        wrapped = wrap_proto_session.wrap(src, str(runtime_dest))
    except ValueError as e:
        die(str(e))

    if args.dry_run:
        print("== dry-run: wrap would succeed ==")
        return 0

    data.mkdir(parents=True, exist_ok=True)
    for name in (
        "openai-hop-session.cjs",
        "opengrok-runtime.cjs",
        "provider-maps.cjs",
        "provider-maps-hop.cjs",
        "hop-server.py",
        "wrap_proto_session.py",
    ):
        copy_tool(name, data)

    write_bindings(data / "model-bindings.json", args.model, hop_base, args.agent_id)

    stamp = time.strftime("%Y%m%dT%H%M%SZ")
    backup = data / ("host-main.cjs.pre-opengrok-%s" % stamp)
    shutil.copy2(host, backup)
    print("  backup host -> %s" % backup)

    node_check(host)
    # Node 20 `--check` rejects a `.tmp` extension (ERR_UNKNOWN_FILE_EXTENSION).
    tmp = data / "host-main.opengrok-check.cjs"
    tmp.write_text(wrapped, encoding="utf-8")
    try:
        node_check(tmp)
        os.replace(tmp, host)
    except Exception:
        if tmp.exists():
            tmp.unlink()
        raise
    print("  [host] wrapped createProtoSessionProvider -> %s" % host)

    if not args.skip_hop:
        if not args.upstream:
            die("--upstream is required unless --skip-hop (example: http://127.0.0.1:8642)")
        if not os.environ.get("API_SERVER_KEY", "").strip():
            die("API_SERVER_KEY must be set in the environment (hop injects it; it is not stored in bindings)")
        env = os.environ.copy()
        env["HERMES_HOP_UPSTREAM"] = args.upstream.rstrip("/")
        env["HERMES_HOP_PORT"] = str(args.hop_port)
        env["HERMES_HOP_HOST"] = "127.0.0.1"
        log = data / "hop-server.log"
        logf = open(log, "ab")
        subprocess.Popen(
            [sys.executable, str(data / "hop-server.py")],
            env=env,
            stdout=logf,
            stderr=logf,
            start_new_session=True,
        )
        print("  hop started on 127.0.0.1:%d -> %s (log %s)" % (args.hop_port, env["HERMES_HOP_UPSTREAM"], log))

    print("""
DONE. Bounce the sand-host process (supervisor-safe, not a raw kill).
Then send a normal message in Grok Bot.

Proof of routing is a line in /tmp/opengrok-session.log and a request on the
hop port. The picker probe does not prove host routing.

If the first turn throws missing session.<method>, re-run with
OPENGROK_PROBE_PROTO=1, send one message, and inspect
/tmp/opengrok-proto-keys.json.
""")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("aborted.")
        sys.exit(1)
