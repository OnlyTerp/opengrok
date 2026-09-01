#!/usr/bin/env python3
"""Local Chat Completions -> OpenAI Responses API bridge.

Grok Bot's hop lane speaks ``/v1/chat/completions`` while Codex Everywhere is
configured in OpenClaw as an ``openai-responses`` provider.  This small,
dependency-free adapter translates the common request/response surface and
keeps the provider key on the bridge side.

Environment:
  CE_BASE_URL  Codex Everywhere origin or /v1 base (default: the public origin)
  CE_API_KEY   API key used only for upstream requests (required)
  CE_BRIDGE_HOST / CE_BRIDGE_PORT  local bind address and port

The bridge binds to loopback by default.  It intentionally does not accept a
remote upstream URL or credentials from an incoming request.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


LOG = logging.getLogger("codex-everywhere-bridge")
MAX_BODY = 16 * 1024 * 1024


def responses_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    return base + "/responses" if base.endswith("/v1") else base + "/v1/responses"


def models_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    return base + "/models" if base.endswith("/v1") else base + "/v1/models"


def _text_content(content: Any, role: str = "user") -> Any:
    """Convert Chat Completions content parts to Responses input parts."""
    if isinstance(content, str) or content is None:
        return content or ""
    if not isinstance(content, list):
        return str(content)
    parts = []
    for part in content:
        if not isinstance(part, dict):
            continue
        kind = part.get("type")
        if kind in ("text", "input_text", "output_text"):
            parts.append({
                "type": "output_text" if role == "assistant" else "input_text",
                "text": part.get("text", ""),
            })
        elif kind in ("image_url", "input_image"):
            image = part.get("image_url", part)
            if isinstance(image, dict):
                item = {"type": "input_image"}
                if image.get("url"):
                    item["image_url"] = image["url"]
                if image.get("detail"):
                    item["detail"] = image["detail"]
                parts.append(item)
    return parts


def chat_message_to_input(message: dict[str, Any]) -> list[dict[str, Any]]:
    """Translate one Chat message, including tool calls/results."""
    role = message.get("role", "user")
    result: list[dict[str, Any]] = []
    if role == "tool":
        result.append({
            "type": "function_call_output",
            "call_id": message.get("tool_call_id", ""),
            "output": str(message.get("content", "")),
        })
        return result

    tool_calls = message.get("tool_calls") or []
    for call in tool_calls:
        fn = call.get("function") or {}
        result.append({
            "type": "function_call",
            "call_id": call.get("id", ""),
            "name": fn.get("name", ""),
            "arguments": fn.get("arguments", "{}"),
        })

    item: dict[str, Any] = {
        "role": role,
        "content": _text_content(message.get("content"), role),
    }
    if message.get("name"):
        item["name"] = message["name"]
    result.append(item)
    return result


def convert_tools(tools: Any) -> Any:
    if not isinstance(tools, list):
        return tools
    converted = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        if tool.get("type") != "function" or not isinstance(tool.get("function"), dict):
            converted.append(tool)
            continue
        fn = tool["function"]
        converted.append({
            "type": "function",
            "name": fn.get("name", ""),
            "description": fn.get("description", ""),
            "parameters": fn.get("parameters", {"type": "object", "properties": {}}),
            **({"strict": fn["strict"]} if "strict" in fn else {}),
        })
    return converted


def chat_to_responses(request: dict[str, Any]) -> dict[str, Any]:
    """Build a Responses request without mutating the incoming JSON."""
    out: dict[str, Any] = {"model": request.get("model", "")}
    messages = request.get("messages") or []
    inputs = []
    for message in messages:
        if isinstance(message, dict):
            inputs.extend(chat_message_to_input(message))
    out["input"] = inputs

    passthrough = (
        "stream", "temperature", "top_p", "tools", "tool_choice",
        "parallel_tool_calls", "metadata", "store", "include",
    )
    for key in passthrough:
        if key in request:
            out[key] = convert_tools(request[key]) if key == "tools" else request[key]

    if "max_output_tokens" in request:
        out["max_output_tokens"] = request["max_output_tokens"]
    elif "max_completion_tokens" in request:
        out["max_output_tokens"] = request["max_completion_tokens"]
    elif "max_tokens" in request:
        out["max_output_tokens"] = request["max_tokens"]

    if "reasoning" in request:
        out["reasoning"] = request["reasoning"]
    elif request.get("reasoning_effort") is not None:
        out["reasoning"] = {"effort": request["reasoning_effort"]}

    # Responses does not need a separate `user` field for the common case, but
    # preserve it as metadata so request attribution is not silently lost.
    if request.get("user") is not None and "metadata" not in out:
        out["metadata"] = {"user": str(request["user"])}
    out.setdefault("store", False)
    return out


def _output_text(item: dict[str, Any]) -> str:
    content = item.get("content") or []
    if isinstance(content, str):
        return content
    text = []
    for part in content:
        if isinstance(part, dict) and part.get("type") in ("output_text", "text"):
            text.append(part.get("text", ""))
    return "".join(text)


def responses_to_chat(response: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    output = response.get("output") or []
    text = []
    tool_calls = []
    for item in output:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "message":
            text.append(_output_text(item))
        elif item.get("type") == "function_call":
            tool_calls.append({
                "id": item.get("call_id", item.get("id", "")),
                "type": "function",
                "function": {
                    "name": item.get("name", ""),
                    "arguments": item.get("arguments", "{}"),
                },
            })
    usage = response.get("usage") or {}
    chat_usage = {
        "prompt_tokens": usage.get("input_tokens", 0),
        "completion_tokens": usage.get("output_tokens", 0),
        "total_tokens": usage.get("total_tokens", usage.get("input_tokens", 0) + usage.get("output_tokens", 0)),
    }
    message: dict[str, Any] = {"role": "assistant", "content": "".join(text) or None}
    if tool_calls:
        message["tool_calls"] = tool_calls
    finish = "tool_calls" if tool_calls else ("length" if response.get("status") == "incomplete" else "stop")
    return {
        "id": response.get("id", "resp-bridge"),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": response.get("model", request.get("model", "")),
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": chat_usage,
    }


def sse_events(raw) -> Any:
    event = None
    data_lines = []
    for line in raw:
        line = line.decode("utf-8", "replace").rstrip("\r\n")
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif line == "":
            if data_lines:
                payload = "\n".join(data_lines)
                if payload != "[DONE]":
                    try:
                        yield event or "message", json.loads(payload)
                    except json.JSONDecodeError:
                        LOG.warning("ignoring non-JSON upstream SSE event")
                event, data_lines = None, []


class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "codex-everywhere-bridge/1"

    def log_message(self, fmt, *args):
        LOG.info("%s", fmt % args)

    @property
    def config(self):
        return self.server.bridge_config  # type: ignore[attr-defined]

    def send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/health", "/healthz"):
            self.send_json(200, {"ok": True, "service": "codex-everywhere-bridge"})
            return
        if self.path == "/v1/models":
            self.proxy_models()
            return
        self.send_json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})

    def proxy_models(self):
        request = urllib.request.Request(models_url(self.config["base_url"]))
        request.add_header("Authorization", "Bearer " + self.config["api_key"])
        try:
            with urllib.request.urlopen(request, timeout=self.config["timeout"]) as response:
                body = response.read(MAX_BODY)
                self.send_response(response.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as error:
            self.send_json(error.code, {"error": {"message": "upstream models request failed"}})
        except Exception:
            self.send_json(502, {"error": {"message": "upstream unavailable", "type": "bridge_error"}})

    def do_POST(self):
        if self.path not in ("/v1/chat/completions", "/chat/completions"):
            self.send_json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                self.send_json(413, {"error": {"message": "request body too large or empty"}})
                return
            chat_request = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(chat_request, dict) or not chat_request.get("model"):
                self.send_json(400, {"error": {"message": "model is required", "type": "invalid_request_error"}})
                return
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": {"message": "invalid JSON", "type": "invalid_request_error"}})
            return

        payload = json.dumps(chat_to_responses(chat_request)).encode("utf-8")
        request = urllib.request.Request(
            responses_url(self.config["base_url"]), data=payload, method="POST"
        )
        request.add_header("Authorization", "Bearer " + self.config["api_key"])
        request.add_header("Content-Type", "application/json")
        request.add_header("Accept", "text/event-stream" if chat_request.get("stream") else "application/json")
        try:
            upstream = urllib.request.urlopen(request, timeout=self.config["timeout"])
        except urllib.error.HTTPError as error:
            body = error.read(MAX_BODY)
            self.send_response(error.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        except Exception:
            self.send_json(502, {"error": {"message": "upstream unavailable", "type": "bridge_error"}})
            return

        try:
            if chat_request.get("stream"):
                self.stream_response(upstream, chat_request)
            else:
                response = json.loads(upstream.read(MAX_BODY).decode("utf-8"))
                self.send_json(200, responses_to_chat(response, chat_request))
        except Exception:
            LOG.exception("response conversion failed")
            if not self.wfile.closed:
                self.send_json(502, {"error": {"message": "invalid upstream response", "type": "bridge_error"}})
        finally:
            upstream.close()

    def stream_response(self, upstream, chat_request):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        emitted_text = False
        tool_index = 0
        tool_names: dict[str, int] = {}

        def emit(payload: dict[str, Any]):
            data = ("data: " + json.dumps(payload, separators=(",", ":")) + "\n\n").encode()
            self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
            self.wfile.flush()

        for event, payload in sse_events(upstream):
            event_type = payload.get("type", event)
            if event_type == "response.output_text.delta":
                delta = payload.get("delta", "")
                emitted_text = emitted_text or bool(delta)
                emit({"id": payload.get("response_id", "resp-bridge"), "object": "chat.completion.chunk", "created": int(time.time()), "model": chat_request["model"], "choices": [{"index": 0, "delta": {"content": delta}, "finish_reason": None}]})
            elif event_type == "response.output_item.added" and (payload.get("item") or {}).get("type") == "function_call":
                item = payload["item"]
                call_id = item.get("call_id", item.get("id", ""))
                tool_names[call_id] = tool_index
                emit({"id": payload.get("response_id", "resp-bridge"), "object": "chat.completion.chunk", "created": int(time.time()), "model": chat_request["model"], "choices": [{"index": 0, "delta": {"tool_calls": [{"index": tool_index, "id": call_id, "type": "function", "function": {"name": item.get("name", ""), "arguments": ""}}]}, "finish_reason": None}]})
                tool_index += 1
            elif event_type == "response.function_call_arguments.delta":
                call_id = payload.get("call_id", "")
                index = tool_names.get(call_id, 0)
                emit({"id": payload.get("response_id", "resp-bridge"), "object": "chat.completion.chunk", "created": int(time.time()), "model": chat_request["model"], "choices": [{"index": 0, "delta": {"tool_calls": [{"index": index, "function": {"arguments": payload.get("delta", "")}}]}, "finish_reason": None}]})
            elif event_type == "response.completed":
                response = payload.get("response") or payload
                finish = "tool_calls" if tool_index else ("length" if response.get("status") == "incomplete" else "stop")
                emit({"id": response.get("id", "resp-bridge"), "object": "chat.completion.chunk", "created": int(time.time()), "model": response.get("model", chat_request["model"]), "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]})
            elif event_type in ("response.failed", "error"):
                emit({"error": {"message": payload.get("message", "upstream response failed"), "type": "upstream_error"}})
        done = b"data: [DONE]\n\n"
        self.wfile.write(b"%x\r\n%s\r\n0\r\n\r\n" % (len(done), done))
        self.wfile.flush()


def make_config(args) -> dict[str, Any]:
    base_url = args.base_url or os.environ.get("CE_BASE_URL", "https://codex-everywhere.com")
    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        raise SystemExit(f"{args.api_key_env} is required; the value is never read from a request")
    return {"base_url": base_url, "api_key": api_key, "timeout": args.timeout}


def main() -> None:
    parser = argparse.ArgumentParser(description="Bridge Grok Bot Chat Completions to Codex Everywhere Responses API")
    parser.add_argument("--host", default=os.environ.get("CE_BRIDGE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("CE_BRIDGE_PORT", "18795")))
    parser.add_argument("--base-url", default="")
    parser.add_argument("--api-key-env", default="CE_API_KEY")
    parser.add_argument("--timeout", type=float, default=1800)
    args = parser.parse_args()
    config = make_config(args)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    server = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    server.bridge_config = config  # type: ignore[attr-defined]
    LOG.info("listening on http://%s:%d -> %s (key loaded)", args.host, args.port, responses_url(config["base_url"]))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
