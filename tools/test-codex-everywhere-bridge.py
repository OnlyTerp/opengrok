#!/usr/bin/env python3
"""Local integration tests for codex-everywhere-bridge.py.

The fake upstream records the translated request and returns both JSON and SSE
Responses-shaped fixtures. No external network or real credential is used.
"""
from __future__ import annotations

import http.client
import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BRIDGE = ROOT / "codex-everywhere-bridge.py"

spec = importlib.util.spec_from_file_location("codex_bridge", BRIDGE)
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)


class FakeHandler(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *_args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        self.requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        if body.get("stream"):
            events = [
                {"type": "response.output_text.delta", "delta": "pong", "response_id": "resp_stream"},
                {"type": "response.completed", "response": {"id": "resp_stream", "model": body["model"], "status": "completed"}},
            ]
            payload = "".join("event: %s\ndata: %s\n\n" % (event["type"], json.dumps(event)) for event in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        response = {
            "id": "resp_json", "model": body["model"], "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": "pong"}]}],
            "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
        }
        payload = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(port: int, payload: dict) -> tuple[int, dict | str]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("POST", "/v1/chat/completions", json.dumps(payload), {"Content-Type": "application/json"})
    response = conn.getresponse()
    raw = response.read().decode()
    conn.close()
    if payload.get("stream"):
        return response.status, raw
    return response.status, json.loads(raw)


def main() -> int:
    translated = bridge.chat_to_responses({
        "model": "gpt-5.6-terra",
        "messages": [
            {"role": "system", "content": "Be concise"},
            {"role": "user", "content": "call a tool"},
            {"role": "assistant", "content": None, "tool_calls": [{
                "id": "call_1", "type": "function",
                "function": {"name": "lookup", "arguments": "{\"q\":\"x\"}"},
            }]},
            {"role": "tool", "tool_call_id": "call_1", "content": "result"},
        ],
        "tools": [{"type": "function", "function": {
            "name": "lookup", "description": "Look up a value",
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
        }}],
    })
    assert translated["input"][2]["type"] == "function_call"
    assert translated["input"][4]["type"] == "function_call_output"
    assert translated["tools"][0]["name"] == "lookup"

    upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeHandler)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    upstream_port = upstream.server_address[1]
    bridge_port = free_port()
    env = {**os.environ, "CE_API_KEY": "test-secret"}
    process = subprocess.Popen(
        [sys.executable, str(BRIDGE), "--port", str(bridge_port), "--base-url", f"http://127.0.0.1:{upstream_port}/v1"],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        for _ in range(50):
            try:
                with socket.create_connection(("127.0.0.1", bridge_port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise AssertionError("bridge did not start")

        status, result = request(bridge_port, {
            "model": "gpt-5.6-terra", "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 32, "reasoning_effort": "high",
        })
        assert status == 200, (status, result)
        assert result["choices"][0]["message"]["content"] == "pong"
        sent = FakeHandler.requests[-1]
        assert sent["path"] == "/v1/responses"
        assert sent["auth"] == "Bearer test-secret"
        assert sent["body"]["max_output_tokens"] == 32
        assert sent["body"]["reasoning"] == {"effort": "high"}
        assert sent["body"]["store"] is False

        status, stream = request(bridge_port, {
            "model": "gpt-5.6-terra", "messages": [{"role": "user", "content": "ping"}], "stream": True,
        })
        assert status == 200
        assert '"content":"pong"' in stream
        assert "data: [DONE]" in stream
        assert len(FakeHandler.requests) == 2
        print("2/2 bridge integration checks passed")
        return 0
    finally:
        process.terminate()
        process.wait(timeout=5)
        upstream.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
