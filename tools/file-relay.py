#!/usr/bin/env python3
"""file-relay — reference implementation of the box file relay (BOX_RELAY_URL).

The picker POSTs to `<BOX_RELAY_URL>/push/model-bindings.json` when
BOX_RELAY_URL is set. This is the service that receives those pushes and
writes them to a directory on the box (default /home/box/sand-data).

Run it ON the box:

    python3 tools/file-relay.py --dir /home/box/sand-data --port 8799

Endpoints:
    POST /push/<name>   write request body to <dir>/<name>   (200 on success)
    GET  /pull/<name>   serve <dir>/<name> back              (404 if missing)
    GET  /health        {"ok": true, "dir": "..."}

Security notes:
  - Bind loopback by default (--host 127.0.0.1). If you must expose it on a
    private network, put it behind the restricted SSH tunnel you already use
    for the hop — never a public port.
  - Name is sanitized to [A-Za-z0-9._-]; anything else 400s. No path escape.
  - No auth: it is a convenience for pushing files when you have a shell but
    no scp. It is NOT the binding consumer — see docs/CLOUD-HOST.md.
"""
import argparse, json, os, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

SAFE = re.compile(r"^[A-Za-z0-9._-]+$")
MAX_BODY = 64 * 1024 * 1024  # 64 MiB
BINDINGS = "model-bindings.json"
METRICS = "live-metrics.jsonl"
# The in-app HUD page is a file:// document; Chromium sends Origin "null" (or
# "file://"). Any other Origin is a web page and must not rebind agents.
APP_ORIGINS = {"null", "file://"}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _write_atomic(path, data):
    """Write through symlinks: the relay dir may link to the app's real
    bindings file; replacing the link itself would silently fork them."""
    real = os.path.realpath(path)
    tmp = real + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, real)


def apply_binding_update(path, update):
    """Merge one HUD model selection into model-bindings.json.

    Only whitelisted fields are copied (never credentials); hopBaseUrl must
    be loopback http. Returns the stored agent entry."""
    aid = update.get("agentId")
    model = update.get("modelId")
    hop = update.get("hopBaseUrl")
    if not isinstance(aid, str) or not SAFE.match(aid):
        raise ValueError("bad agentId")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("bad modelId")
    u = urlparse(hop) if isinstance(hop, str) else None
    if not u or u.scheme != "http" or u.hostname not in LOOPBACK_HOSTS:
        raise ValueError("hopBaseUrl must be loopback http")
    try:
        with open(path, "rb") as f:
            doc = json.load(f)
    except FileNotFoundError:
        doc = {}
    agents = doc.setdefault("agents", {})
    entry = agents.setdefault(aid, {})
    entry["modelId"] = model.strip()
    entry["hopBaseUrl"] = hop
    for key in ("name", "provider"):
        if isinstance(update.get(key), str) and update[key].strip():
            entry[key] = update[key].strip()
    if isinstance(update.get("parameters"), list):
        entry["parameters"] = update["parameters"]
    _write_atomic(path, (json.dumps(doc, indent=2) + "\n").encode())
    return entry


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "file-relay/1"

    def log_message(self, fmt, *args):  # quiet default
        pass

    def _send(self, code, body=b"", ctype="text/plain"):
        self.send_response(code)
        origin = self.headers.get("Origin")
        if origin in APP_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204 if self.headers.get("Origin") in APP_ORIGINS else 403)

    def _read_body(self):
        """Always consume the declared body before replying. HTTP/1.1
        keep-alive: an unread body is parsed as the NEXT request line (the
        HUD then sees 501 "Unsupported method ('{...}GET')" on its polls)."""
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self.close_connection = True
            return None
        return self.rfile.read(length) if length else b""

    def _app_origin_ok(self):
        origin = self.headers.get("Origin")
        return origin is None or origin in APP_ORIGINS

    def _update_binding(self, raw):
        try:
            update = json.loads(raw or b"{}")
            entry = apply_binding_update(os.path.join(RELAY_DIR, BINDINGS), update)
        except (ValueError, TypeError, AttributeError) as e:
            self._send(400, json.dumps({"error": str(e)}).encode(), "application/json")
            return
        body = json.dumps({"ok": True, "agentId": update["agentId"], "binding": entry})
        self._send(200, body.encode(), "application/json")

    def _append_metrics(self, raw):
        """One JSON object per call → one line in live-metrics.jsonl (the file
        the HUD polls via /pull/live-metrics.jsonl)."""
        try:
            row = json.loads(raw or b"{}")
            if not isinstance(row, dict):
                raise ValueError("metrics row must be an object")
        except ValueError as e:
            self._send(400, json.dumps({"error": str(e)}).encode(), "application/json")
            return
        with open(os.path.join(RELAY_DIR, METRICS), "a", encoding="utf-8") as f:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")
        self._send(200, b'{"ok":true}', "application/json")

    def _name(self):
        # strip leading /push/ or /pull/
        parts = self.path.strip("/").split("/", 1)
        if len(parts) != 2 or not SAFE.match(parts[1]):
            return None
        return parts[1]

    def do_POST(self):
        raw = self._read_body()
        if raw is None:
            self._send(413, b'{"error":"body too large"}', "application/json")
            return
        if self.path in ("/update-binding", "/append-metrics"):
            if not self._app_origin_ok():
                self._send(403, b'{"error":"origin not allowed"}', "application/json")
                return
            if self.path == "/update-binding":
                self._update_binding(raw)
            else:
                self._append_metrics(raw)
            return
        if not self.path.startswith("/push/"):
            self._send(404, b'{"error":"not found"}', "application/json")
            return
        name = self._name()
        if not name:
            self._send(400, b'{"error":"bad name"}', "application/json")
            return
        _write_atomic(os.path.join(RELAY_DIR, name), raw)
        self._send(200, b'{"ok":true,"name":"%s","bytes":%d}' % (name.encode(), len(raw)), "application/json")

    def do_GET(self):
        if self.path == "/health":
            self._send(200, b'{"ok":true,"dir":"%s"}' % RELAY_DIR.encode(), "application/json")
            return
        if not self.path.startswith("/pull/"):
            self._send(404, b'{"error":"not found"}', "application/json")
            return
        name = self._name()
        if not name:
            self._send(400, b'{"error":"bad name"}', "application/json")
            return
        dest = os.path.join(RELAY_DIR, name)
        if not os.path.exists(dest):
            self._send(404, b'{"error":"missing"}', "application/json")
            return
        with open(dest, "rb") as f:
            self._send(200, f.read(), "application/octet-stream")


def main():
    global RELAY_DIR
    ap = argparse.ArgumentParser(description="Box file relay for BOX_RELAY_URL pushes.")
    ap.add_argument("--dir", default="/home/box/sand-data", help="directory to write pushes into")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (loopback default)")
    ap.add_argument("--port", type=int, default=8799, help="listen port")
    a = ap.parse_args()
    RELAY_DIR = os.path.abspath(a.dir)
    os.makedirs(RELAY_DIR, exist_ok=True)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"file-relay http://{a.host}:{a.port} -> {RELAY_DIR}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()