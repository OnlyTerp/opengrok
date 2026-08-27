#!/usr/bin/env python3
"""Hermes hop shim (:18790) — lets credentialed clients (Grok Bot box bindings)
reach the Hermes api_server adapter (:8642) without carrying API_SERVER_KEY.

Why this exists (GROK-NATIVE-INTEGRATION-MAP.md §4-B):
  - model-bindings.json forbids creds in the file ("no user/pass, no query").
  - Native-lane pattern already proven by shims :18776/:18777/:18778/:18779 —
    each adds a trusted identity layer; this one adds the Hermes Bearer.

Behavior:
  - Forwards ANY method/path to http://127.0.0.1:8642/<same-path>.
  - Always overrides/injects: Authorization: Bearer $API_SERVER_KEY.
    (Client may send any placeholder; never trusted, never logged.)
  - Streams request AND response bodies chunk-by-chunk (SSE-safe, /v1/chat/completions
    stream=true passes through untouched).
  - /healthz answered locally: {"ok":true,"upstream":<bool>} — no upstream call.
  - NEVER logs the key, Authorization values, or full bodies. Line logs only.

Env:
  HERMES_HOP_PORT   (default 18790)
  HERMES_HOP_HOST   (default 127.0.0.1 — loopback only; Tailscale adapter reachable)
  API_SERVER_KEY    (required; falls back to reading key from
                     %LOCALAPPDATA%/hermes/.env "API_SERVER_KEY=..." line)

Run persistence (matches sibling shims):
  Startup .vbs calling:  pythonw <your-hop-dir>/hop-server.py
"""
from __future__ import annotations

import json
import logging
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger("hermes-hop")

HOST = os.environ.get("HERMES_HOP_HOST", "127.0.0.1")
PORT = int(os.environ.get("HERMES_HOP_PORT", "18790"))
UPSTREAM = os.environ.get("HERMES_HOP_UPSTREAM", "http://127.0.0.1:8642").rstrip("/")
_TIMEOUT = float(os.environ.get("HERMES_HOP_TIMEOUT", "1800"))  # long agent turns
_MAX_BODY = 64 * 1024 * 1024


def load_key() -> str:
    key = os.environ.get("API_SERVER_KEY", "").strip()
    if key:
        return key
    env_path = os.path.join(os.environ.get("LOCALAPPDATA", ""), "hermes", ".env")
    try:
        with open(env_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("API_SERVER_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    raise SystemExit("hermes-hop: no API_SERVER_KEY in env or %s" % env_path)


_KEY = ""  # set in main()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "hermes-hop/1"

    def log_message(self, fmt, *args):  # noqa: N802 - quiet default; line logger below
        log.info("%s - %s", self.address_string(), fmt % args)

    # ---- helpers -------------------------------------------------------
    def _relay(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length > _MAX_BODY:
            self._simple(413, b'{"error":"body too large"}')
            return
        body = self.rfile.read(length) if length else None

        url = UPSTREAM + self.path
        req = urllib.request.Request(url, data=body, method=self.command)
        for name, value in self.headers.items():
            lname = name.lower()
            if lname in ("host", "authorization", "content-length", "connection", "accept-encoding"):
                continue  # rebuilt downstream; accept-encoding off so chunks arrive readable
            req.add_header(name, value)
        req.add_header("Authorization", "Bearer " + _KEY)
        req.add_header("Accept-Encoding", "identity")

        try:
            resp = urllib.request.urlopen(req, timeout=_TIMEOUT)
        except urllib.error.HTTPError as exc:
            payload = exc.read() or b""
            self.send_response(exc.code)
            ctype = exc.headers.get("Content-Type") if exc.headers else None
            if ctype:
                self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            log.warning("upstream unreachable: %r", exc)
            self._simple(502, b'{"error":{"message":"hermes api_server unreachable","type":"hop_error"}}')
            return

        ctype = resp.headers.get("Content-Type", "")
        if "text/event-stream" in ctype or "chunked" in (resp.headers.get("Transfer-Encoding") or ""):
            self.send_response(resp.getcode())
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionAbortedError):
                log.info("client aborted mid-stream")
        else:
            payload = resp.read()
            self.send_response(resp.getcode())
            if ctype:
                self.send_header("Content-Type", ctype)
            extra = (resp.headers.get("X-Request-Id") or resp.headers.get("x-request-id"))
            if extra:
                self.send_header("X-Request-Id", extra)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        resp.close()

    def _simple(self, code: int, payload: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):  # noqa: N802
        if self.path == "/healthz":
            up = _probe_upstream()
            self._simple(200, json.dumps({"ok": True, "service": "hermes-hop",
                                          "port": PORT, "upstream_reachable": up}).encode())
            return
        self._relay()

    def do_POST(self):  # noqa: N802
        self._relay()

    def do_DELETE(self):  # noqa: N802
        self._relay()


def _probe_upstream() -> bool:
    try:
        with urllib.request.urlopen(UPSTREAM + "/health", timeout=3) as r:
            return r.getcode() < 500
    except Exception:
        return False


def main() -> None:
    global _KEY
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    _KEY = load_key()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    log.info("hermes-hop listening http://%s:%s -> %s (key loaded, len=%d)",
             HOST, PORT, UPSTREAM, len(_KEY))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
