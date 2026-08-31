# Stock Grok Bot host (0.30)

Upstream `apply-box-patch.py` does not install on a stock cloud computer.
The host bundle has no `createOpenAiHopSession`, no `resolvedOpenaiBaseUrl`,
and no `openai-hop-session.cjs`. That is issues #3 and #5. Saving
`model-bindings.json` on your Mac does not change Grok Bot chat.

This tree ships the missing hop session and an installer that wraps the
factory that **does** exist on stock: `createProtoSessionProvider` (returns
`new ProtoSession(...)`). Issue #5 counted the substring `createProtoSession`
(2 hits: the definition and one call). `--census-only` prints snippets.

## What you run (on the Grok Bot computer)

Clone this fork onto the box, then:

```bash
export API_SERVER_KEY='your-provider-key'
python3 tools/install-stock-box.py \
  --upstream http://YOUR-OPENAI-COMPAT-HOST:PORT \
  --model glm-5.3-flash
```

`--upstream` is the origin **without** `/v1`. The hop listens on
`127.0.0.1:18790` and injects `Authorization`. Bindings only store
`http://127.0.0.1:18790/v1`.

Then bounce `sand-host` (supervisor-safe) and send a normal message in the
Bot. Proof is `/tmp/opengrok-session.log` plus a request on port 18790.

Census without writing:

```bash
python3 tools/install-stock-box.py --census-only
```

## What the installer does

1. Copies `openai-hop-session.cjs`, `opengrok-runtime.cjs`, provider maps,
   and `hop-server.py` into `/home/box/sand-data`.
2. Writes `model-bindings.json` with a `*` wildcard (every conversation)
   unless you pass `--agent-id`.
3. Backs up `host-main.cjs`, wraps the proto-session factory, `node --check`s,
   then replaces the host file.
4. Starts the hop with `API_SERVER_KEY` from the environment.

Re-run is idempotent. The wrap marker is `/* opengrok-stock-wrap */`.

## Fail-closed

If there is no binding, the wrapped factory throws. It does not silently
fall back to the plan-quota proto session.

If the host calls a session method the hop object does not implement, the
turn errors and `/tmp/opengrok-session.log` records `missing-prop <name>`.
Set `OPENGROK_PROBE_PROTO=1`, send one message, and read
`/tmp/opengrok-proto-keys.json` for the real method names.

## What this does not do

It does not add a model picker inside the Grok Bot desktop app.
BYOK UI is gated off for consumer accounts (`ModelAllowlistByok` exists in
the protobuf, not in the settings screen).

Mac-only hop (`127.0.0.1` on your laptop) is unreachable from the cloud
computer. The hop must run on the box.

## Tests you can re-run without a box

```bash
python tools/test-wrap-proto-session.py
node tools/test-openai-hop-session.cjs
python tools/qa.py
```
