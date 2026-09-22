#!/usr/bin/env python3
"""plan-hop — auth-injecting OpenAI-compatible router for paid plan lanes (:18784).

One loopback endpoint for models whose keys must never travel: Grok Bot
bindings/custom agents (and any OpenAI-compatible client) call plan-hop; plan-hop
injects the right Bearer credential and forwards to the plan upstream. Same
family and laws as the sibling shims (:18776/:18777/:18778/:18779/:18780):

  - keys live ONLY in the machine's private credentials dir (never in this repo,
    never in logs, never in request/response logs)
  - SSE-safe streaming relay in both directions
  - strict model routing: unknown model -> 404 with the route list (fail loud,
    never silently fall back to a different model)

Endpoints:
  GET  /healthz          {"ok":true,"routes":[...ids]}
  GET  /v1/models        OpenAI-style catalog built from the route table
  POST /v1/chat/completions   routed by body.model (exact route id)

Config (--config JSON):
{
  "host": "127.0.0.1", "port": 18784,
  "routes": [
    {"id": "muse-spark-1.3", "label": "Muse Spark 1.3 (Max)",
     "upstream": "https://api.meta.ai/v1",
     "key_file": "C:/Users/User/.terp/credentials/meta_key.txt",
     "context_window": 1048576, "max_tokens": 131072,
     "default_body": {"reasoning_effort": "max"}}
  ]
}

Run (persistence matches sibling shims):
  pythonw.exe <repo>/tools/plan-hop.py --config C:/Users/User/.terp/plan-hop/config.json
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger("plan-hop")

MAX_BODY = 64 * 1024 * 1024
TIMEOUT = float(os.environ.get("PLAN_HOP_TIMEOUT", "1800"))  # long agent turns
ROUTES: dict = {}
CFG: dict = {}
USAGE: dict = {}  # per-route call counter for the HUD's "who is doing the work" panel


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    routes = {}
    for r in cfg.get("routes", []):
        key = read_key(r)
        routes[r["id"]] = {**r, "_key": key}
    cfg["routes"] = routes
    return cfg


def read_key(route: dict) -> str:
    """Resolve the route credential: key_file (preferred) or key_env. Never logged."""
    if route.get("key_file"):
        with open(route["key_file"], "r", encoding="utf-8") as fh:
            return fh.read().strip()
    if route.get("key_env"):
        return os.environ[route["key_env"]].strip()
    raise SystemExit(f"plan-hop: route {route['id']!r} has no key_file/key_env")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "plan-hop/1"

    def log_message(self, fmt, *args):  # quiet default; line logs only below
        pass

    def _json(self, code: int, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            return self._json(200, {"ok": True, "routes": sorted(ROUTES)})
        if self.path == "/usage":
            return self._json(200, {
                "ok": True,
                "since": USAGE.get("_started"),
                "calls": {k: v for k, v in USAGE.items() if k != "_started"},
            })
        if self.path == "/v1/models":
            data = [
                {
                    "id": rid,
                    "object": "model",
                    "owned_by": r.get("label", rid),
                    "context_window": r.get("context_window"),
                    "max_tokens": r.get("max_tokens"),
                }
                for rid, r in sorted(ROUTES.items())
            ]
            return self._json(200, {"object": "list", "data": data})
        self._json(404, {"error": {"message": "plan-hop: unknown path"}})

    def do_POST(self):
        if not self.path.startswith("/v1/chat/completions"):
            return self._json(404, {"error": {"message": "plan-hop: only /v1/chat/completions"}})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._json(413, {"error": {"message": "plan-hop: body too large"}})
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": {"message": "plan-hop: invalid JSON body"}})
        model = str(body.get("model", ""))
        route = ROUTES.get(model)
        if route is None:
            return self._json(404, {"error": {
                "message": f"plan-hop: unknown model {model!r}", "routes": sorted(ROUTES)}})

        # default_body fills keys the client did not set (e.g. effort preset)
        for k, v in (route.get("default_body") or {}).items():
            body.setdefault(k, v)
        payload = json.dumps(body).encode()
        url = route["upstream"].rstrip("/") + "/chat/completions"
        req = urllib.request.Request(
            url, data=payload, method="POST",
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(len(payload)),
                "Authorization": f"Bearer {route['_key']}",
                "x-plan-hop-model": model,
            },
        )
        log.info("route %s -> %s", model, route["upstream"])
        try:
            up = urllib.request.urlopen(req, timeout=TIMEOUT)
            USAGE[model] = USAGE.get(model, 0) + 1  # answered calls only: upstream accepted
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        except Exception as e:
            return self._json(502, {"error": {"message": f"plan-hop: upstream {type(e).__name__}"}})

        self.send_response(up.status)
        for h in ("Content-Type", "Cache-Control"):
            if up.headers.get(h):
                self.send_header(h, up.headers[h])
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            while True:
                chunk = up.read(8192)
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except BrokenPipeError:
            pass
        finally:
            up.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--host", default=None)
    ap.add_argument("--port", type=int, default=None)
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    global CFG, ROUTES
    CFG = load_config(args.config)
    ROUTES = CFG["routes"]
    USAGE["_started"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    host = args.host or CFG.get("host", "127.0.0.1")
    port = args.port or int(CFG.get("port", 18784))
    srv = ThreadingHTTPServer((host, port), Handler)
    log.info("plan-hop on %s:%s routes=%s", host, port, sorted(ROUTES))
    srv.serve_forever()


if __name__ == "__main__":
    main()
