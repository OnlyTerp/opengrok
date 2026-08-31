# Cloud-host integration: making a saved binding actually route

**Stock Grok Bot 0.30.** `apply-box-patch.py` does not install on a stock
cloud host. The OpenAI hop lane it edits is not in the shipped bundle
(issues #3, #5). Use [STOCK-HOST](STOCK-HOST.md) (`tools/install-stock-box.py`)
on those machines. Keep this document for the private-lane patcher and for
the six questions from issue #1.

**The missing step (issue #1).** Saving a binding and pushing `model-bindings.json`
to the box is **not** enough. Stock Grok Bot cloud hosts ship a `sand-host`
bundle with **zero** `hopBaseUrl` / `model-bindings.json` / `applyHarnessControls`
symbols — the host never reads bindings, so a saved hop binding is silently
ignored and the agent falls back to its original model.

## The flow, end to end (private OpenAI-hop host only)

```
 local machine                         box (cloud computer)
 ─────────────                         ────────────────────
 setup.py ──► model-bindings.json ──push──► /home/box/sand-data/model-bindings.json
 model-picker.py (edit + test)                │
                                              ▼
 tools/apply-box-patch.py ──────────────────► patches host-main.cjs + hop session
                                              │   (only if createOpenAiHopSession exists)
                                              ▼
                                      bounce host (supervisor-safe)
                                              │
                                              ▼
                              normal chat turn ──► hopBaseUrl ──► upstream
```

On stock hosts, replace the patcher step with `tools/install-stock-box.py`.

## 1. Which file or service consumes `model-bindings.json` on the cloud computer?

**After a successful install:** the live host process
(`node /home/box/sand-host/host-main.cjs`). Stock hosts wrap
`createProtoSession` and read `/home/box/sand-data/model-bindings.json`
(see STOCK-HOST). Private-lane hosts read the same file from the
`__entry.modelId` path inside `apply-box-patch.py`. **Before either
install: nothing consumes it.**

## 2. Which function hooks the live `sand-host/host-main.cjs` request path?

**Stock:** `createProtoSession` (count should be 1 definition). Wrapped by
`tools/wrap_proto_session.py`.

**Private OpenAI hop lane only.** Two anchored edits in
`tools/apply-box-patch.py`:

- **host-main.cjs** — at the model-resolution site, reads
  `maxMode` + `parameters` off the binding entry and carries them into the main
  session options (the summarization lane is deliberately untouched), then
  forwards them into `createOpenAiHopSession(...)`.
- **openai-hop-session.cjs** — `createOpenAiHopSession` and the executor accept
  `maxMode`/`parameters`, and right before building the completions URL the
  hop calls `applyProviderReasoningControls(body, {modelId, baseUrl, maxMode,
  parameters})` from `provider-maps.cjs` (the localQwen lane is excluded).

If those anchors are missing, the patcher exits and tells you to use
`install-stock-box.py`.

## 3. Where does `provider-maps-hop.cjs` need to be installed so it actually "ships on the box"?

`provider-maps-hop.cjs` (Contract B) is the **library** that defines
`applyHarnessControls()`. The **consumer** that calls maps at request time is
`openai-hop-session.cjs`, now shipped in `tools/`. The **map** it loads at
runtime is `provider-maps.cjs`. On the box you need:

```
/home/box/sand-data/
├── model-bindings.json
├── openai-hop-session.cjs
├── opengrok-runtime.cjs
└── provider-maps.cjs
```

`install-stock-box.py` copies those files. `apply-box-patch.py` still writes
`provider-maps.cjs` next to a pre-existing hop session when that lane exists.

## 4. What is the exact `BOX_RELAY_URL` setup and what process implements `/push/model-bindings.json`?

`BOX_RELAY_URL` is the base URL of a **file relay** on the box (loopback-only,
not public). When set, `model-picker.py` POSTs the bindings file to
`<BOX_RELAY_URL>/push/model-bindings.json`. The relay is a tiny HTTP service
that accepts a file body and writes it to a known path on the box. The repo
ships a reference implementation you can run on the box:

```bash
# on the box
python3 tools/file-relay.py --dir /home/box/sand-data --port 8799
# picker side
BOX_RELAY_URL=http://<box-ip>:8799 python tools/model-picker.py
```

`/push/<name>` writes `sand-data/<name>`; `/pull/<name>` serves it back. It is
a convenience for pushing files when you have a shell but no scp — it is **not**
the binding consumer. Pushing the JSON alone changes nothing until the host
is wrapped or patched.

## 5. Does the working setup require a private host patch or relay component that is not currently in this repository?

**For stock 0.30 hosts: use `install-stock-box.py`.** It ships
`openai-hop-session.cjs` (previously missing from the repo) and wraps
`createProtoSession`. `apply-box-patch.py` still requires the private OpenAI
hop lane and will refuse a stock bundle instead of half-patching.

`hop-server.py` injects the API key. Bindings never contain credentials.

## 6. Document the difference between "saved locally," "pushed to box," and "verified that a normal chat turn used the binding."

| State | What it means | How you know |
|---|---|---|
| **Saved locally** | `model-bindings.json` on your machine has the entry; picker test passed (a direct probe from *your* machine to the hop). | picker shows the binding; `python tools/qa.py` passes |
| **Pushed to box** | The JSON file exists at `/home/box/sand-data/model-bindings.json` | `ls` on the box; relay `/pull/model-bindings.json` |
| **Consumer installed** | stock wrap marker in `host-main.cjs`, or private-lane patch applied | `grep opengrok-stock-wrap` on the host, or `apply-box-patch.py` reports "no changes needed" |
| **Routed (verified)** | A **normal chat turn** in the Bot produced a connection to the hop port | `/tmp/opengrok-session.log` and hop access log / `tcpdump` on the hop port |

The picker's direct probe verifies the **hop**, not the **routing**. The only
proof of routing is a normal message in the Bot conversation hitting the hop
port.

## Verification checklist (stock)

```bash
# on the box
python3 tools/install-stock-box.py --census-only
python3 tools/install-stock-box.py --upstream http://127.0.0.1:8642 --model glm-5.3-flash
node --check /home/box/sand-host/host-main.cjs
grep -c "opengrok-stock-wrap" /home/box/sand-host/host-main.cjs
# bounce the host (supervisor-safe, NOT raw kill)
# send a normal message, then:
grep route /tmp/opengrok-session.log
```
