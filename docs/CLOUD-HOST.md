# Cloud-host integration: making a saved binding actually route

**The missing step (issue #1).** Saving a binding and pushing `model-bindings.json`
to the box is **not** enough. Stock Grok Bot cloud hosts ship a `sand-host`
bundle with **zero** `hopBaseUrl` / `model-bindings.json` / `applyHarnessControls`
symbols — the host never reads bindings, so a saved hop binding is silently
ignored and the agent falls back to its original model. This is by design
upstream (the bundle is sealed/attested), and it is why the README promise
"pick a model per agent, save, it talks native" needs one extra, explicit step
for **cloud** agents.

This document is the exact answer to the six questions in the issue.

## The flow, end to end

```
 local machine                         box (cloud computer)
 ─────────────                         ────────────────────
 setup.py ──► model-bindings.json ──push──► /home/box/sand-data/model-bindings.json
 model-picker.py (edit + test)                │
                                              ▼
 tools/apply-box-patch.py ──────────────────► patches host-main.cjs + hop session
                                              │   (installs the binding consumer)
                                              ▼
                                      bounce host (supervisor-safe)
                                              │
                                              ▼
                              normal chat turn ──► hopBaseUrl ──► upstream
```

## 1. Which file or service consumes `model-bindings.json` on the cloud computer?

**After this patch:** the live host process itself (`node /home/box/sand-host/host-main.cjs`).
The patch adds a binding lookup at the exact point the host resolves a
conversation's model — it reads `model-bindings.json` from
`/home/box/sand-data/model-bindings.json` (configurable) and uses the entry for
the conversation's agent id. **Before the patch: nothing consumes it.** That is
the bug this repo was missing.

## 2. Which function hooks the live `sand-host/host-main.cjs` request path?

Two anchored edits, applied by `tools/apply-box-patch.py` (byte-surgical, never
a blind sed, each anchor asserted `count==1` so a changed upstream bundle fails
loudly instead of half-patching):

- **host-main.cjs** — at the model-resolution site, reads
  `maxMode` + `parameters` off the binding entry and carries them into the main
  session options (the summarization lane is deliberately untouched), then
  forwards them into `createOpenAiHopSession(...)`.
- **openai-hop-session.cjs** — `createOpenAiHopSession` and the executor accept
  `maxMode`/`parameters`, and right before building the completions URL the
  hop calls `applyProviderReasoningControls(body, {modelId, baseUrl, maxMode,
  parameters})` from `provider-maps.cjs` (the localQwen lane is excluded).

## 3. Where does `provider-maps-hop.cjs` need to be installed so it actually "ships on the box"?

`provider-maps-hop.cjs` (Contract B) is the **library** that defines
`applyHarnessControls()`. The **consumer** that calls it at request time is the
`openai-hop-session.cjs` file patched in step 2, and the **map** it loads at
runtime is `provider-maps.cjs`. So on the box you need **three** files in
`/home/box/sand-data/`:

```
/home/box/sand-data/
├── model-bindings.json      # pushed by the picker
├── openai-hop-session.cjs   # the hop session (patched)
└── provider-maps.cjs        # the runtime map (Contract A file; hop calls it)
```

`apply-box-patch.py` writes `provider-maps.cjs` there if it's missing (from
`--maps`). The hop session `require()`s it by absolute path — that is the
"installed" location.

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
the binding consumer. Pushing the JSON alone changes nothing until step 2+3 are
done.

## 5. Does the working setup require a private host patch or relay component that is not currently in this repository?

**Previously yes** — the working setup on the maintainer's machine used a
private `apply_on_box.sh` + a patched `openai-hop-session.cjs` that were never
in this repo. That is exactly the gap this issue flagged. **Now: no.** The
consumer is `tools/apply-box-patch.py`, the reference relay is
`tools/hop-server.py`, and the runtime map is `tools/provider-maps.cjs` — all
in-repo. No private component remains.

## 6. Document the difference between "saved locally," "pushed to box," and "verified that a normal chat turn used the binding."

| State | What it means | How you know |
|---|---|---|
| **Saved locally** | `model-bindings.json` on your machine has the entry; picker test passed (a direct probe from *your* machine to the hop). | picker shows the binding; `python tools/qa.py` passes |
| **Pushed to box** | The JSON file exists at `/home/box/sand-data/model-bindings.json` | `ls` on the box; relay `/pull/model-bindings.json` |
| **Consumer installed** | `host-main.cjs` + `openai-hop-session.cjs` patched; `provider-maps.cjs` present | `apply-box-patch.py` re-run reports "no changes needed"; grep the host for the patch marker |
| **Routed (verified)** | A **normal chat turn** in the bound Bot conversation produced a connection to the hop port | on the box: `journalctl`/`tcpdump` on the hop port while sending a message; or the hop's access log shows a request timestamped with your turn |

The picker's direct probe verifies the **hop**, not the **routing**. The only
proof of routing is a normal message in the Bot conversation hitting the hop
port. `tools/apply-box-patch.py` prints this reminder after applying.

## Verification checklist (after applying)

```bash
# on the box
python3 tools/apply-box-patch.py            # idempotent; re-run = "no changes needed"
node --check /home/box/sand-host/host-main.cjs
grep -c "applyProviderReasoningControls" /home/box/sand-data/openai-hop-session.cjs
# bounce the host (supervisor-safe, NOT raw kill)
# then, in the app, send a normal message in the bound conversation:
tcpdump -i lo port <hop-port>               # expect packets
```