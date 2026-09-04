# Codex Everywhere bridge

Codex Everywhere is an OpenAI Responses API provider in OpenClaw. Grok Bot's
hop lane uses OpenAI Chat Completions, so a protocol adapter is required.

## Start the local bridge

The bridge binds to loopback and sends the upstream key only to the configured
Codex Everywhere URL. It never accepts an upstream URL or key from an incoming
request.

```bash
python3 tools/codex-everywhere-bridge.py \
  --api-key-env CE_API_KEY \
  --base-url https://codex-everywhere.com \
  --port 18795
```

Provide `CE_API_KEY` through an OS-managed secret environment. Do not put a
real key in shell history, a binding file, or a repository.

Health check:

```bash
curl http://127.0.0.1:18795/healthz
```

## Binding

The binding must point to the local bridge, not directly to the remote
provider. `modelId` must be one of the exact upstream IDs exposed by CE.

```json
{
  "agents": {
    "<grok-bot-agent-id>": {
      "name": "Codex Everywhere Terra",
      "modelId": "gpt-5.6-terra",
      "provider": "codex-everywhere",
      "hopBaseUrl": "http://127.0.0.1:18795/v1",
      "maxMode": false,
      "parameters": []
    }
  }
}
```

The `provider` value is audit metadata. Routing uses the binding URL and model
ID. Start the picker with the binding file after the bridge is running:

```bash
python3 tools/model-picker.py \
  --bindings /path/to/model-bindings.json \
  --hop http://127.0.0.1:18795 \
  --port 8766
```

## Compatibility

Supported translation surface:

- Chat `messages` to Responses `input`, including prior assistant tool calls
  and tool results.
- Chat function tools to Responses function tools.
- `max_tokens`/`max_completion_tokens` to `max_output_tokens`.
- `reasoning_effort` to `reasoning.effort`.
- JSON responses and text streaming (`response.output_text.delta`).
- Non-streaming function calls and streaming function-call arguments.
- Responses usage to Chat Completions usage.

The bridge is not an authentication or model-policy bypass. If CE requires
OAuth/session headers, non-Bearer credentials, or a Codex-specific request
shape beyond the standard Responses API, the upstream request layer needs an
explicit extension. Run the fake-upstream integration test before any live
metered probe:

```bash
python3 tools/test-codex-everywhere-bridge.py
```

The repository's `wire-probe.py` targets Chat Completions, so it cannot prove
the CE Responses endpoint directly. For CE, first prove the bridge locally,
then make one approved live request through it and inspect the upstream-side
request/response status without logging credentials or full bodies.
