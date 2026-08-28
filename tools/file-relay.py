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
import argparse, os, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SAFE = re.compile(r"^[A-Za-z0-9._-]+$")
MAX_BODY = 64 * 1024 * 1024  # 64 MiB


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "file-relay/1"

    def log_message(self, fmt, *args):  # quiet default
        pass

    def _send(self, code, body=b"", ctype="text/plain"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _name(self):
        # strip leading /push/ or /pull/
        parts = self.path.strip("/").split("/", 1)
        if len(parts) != 2 or not SAFE.match(parts[1]):
            return None
        return parts[1]

    def do_POST(self):
        if not self.path.startswith("/push/"):
            self._send(404, b'{"error":"not found"}', "application/json")
            return
        name = self._name()
        if not name:
            self._send(400, b'{"error":"bad name"}', "application/json")
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self._send(413, b'{"error":"body too large"}', "application/json")
            return
        body = self.rfile.read(length) if length else b""
        dest = os.path.join(RELAY_DIR, name)
        tmp = dest + ".tmp"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, dest)
        self._send(200, b'{"ok":true,"name":"%s","bytes":%d}' % (name.encode(), len(body)), "application/json")

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