# opengrok × your Grok Bot box — the integration guide

**TL;DR:** everything in `box/` is the battle-tested code that has been running
Terp's real Grok Bot box since late August: the hop session that gives any
model a working turn (streaming, tool-calls, context guardian, auto-repair),
the provider wire maps, and the full harness suite (98 checks). The pull path
below is safe for the box and takes under a minute.

---

## What lives in `box/`

| File | What it is | Used by |
|---|---|---|
| `openai-hop-session.cjs` | The hop session: streaming OpenAI-compatible executor for the Grok Bot host. Context Guardian (anti-cooking tool-output pruning), in-chat `/reset`, tool-argument auto-repair, live-metrics telemetry, provenance audit. | dropped into `/home/box/sand-data/` |
| `test/*.cjs` + `test/run-all.cjs` | 6 harness suites, 98 checks (m1 guardian, m2 routing/streaming/adversarial, m4 empirical + challenger, provider maps) | `node box/test/run-all.cjs` |

Everything here is the **sanitized** twin of the production files: personal
IDs, machine paths, and the hardcoded metrics relay are gone — behavior is
byte-for-byte the same (the 98-check suite runs against the same declarations
the production system was validated on 9/2–9/4).

## Pull path (box → running with this in ~60s, no scp, no auth)

The box already runs a file relay on `127.0.0.1:8799` (`tools/file-relay.py`
in this repo). All commands below run **on the box**:

```bash
# 1. grab the files from this repo (raw.githubusercontent, no auth needed)
SD=/home/box/sand-data
curl -fsSL https://raw.githubusercontent.com/OnlyTerp/opengrok/main/box/openai-hop-session.cjs -o $SD/openai-hop-session.cjs
curl -fsSL https://raw.githubusercontent.com/OnlyTerp/opengrok/main/tools/provider-maps.cjs  -o $SD/provider-maps.cjs

# 2. prove they load (syntax) before touching the running host
node --check $SD/openai-hop-session.cjs && node --check $SD/provider-maps.cjs

# 3. optional: run the harness against what you just pulled (needs repo clone)
node box/test/run-all.cjs     # expect: SUITES: 6 | FAILED SUITES: 0

# 4. bounce the host (supervisor-safe, NOT a raw kill)
```

## Layering the binding consumer (if your host doesn't read bindings)

Stock Grok Bot hosts ignore `model-bindings.json` — see
[CLOUD-HOST](CLOUD-HOST.md) for the full story and
`tools/apply-box-patch.py` for the anchored, idempotent patcher
(`--dry-run` first; it ships a patcher, not a bundle — the actual box
`host-main.cjs` + `openai-hop-session.cjs` are applied on the box).

## Environment (all optional, all sane defaults)

| Var | Meaning |
|---|---|
| `GROKBOT_HOP_BRIEFING` | specialist system briefing text (none by default — clean silence) |
| `GROKBOT_LIVE_METRICS_LOG` | where per-turn metrics append (default: `~/.grokbot/live-metrics.jsonl`, box: `/home/box/sand-data/live-metrics.jsonl`) |
| `GROKBOT_METRICS_RELAY` | opt-in PUSH relay base URL (loopback/private net only; nothing leaves the machine unless you set this) |
| `GROKBOT_LOCAL_PROVENANCE_LOG` | provenance audit jsonl path |

## Verify after install

1. `node $SD/openai-hop-session.cjs` → no output, exit 0 (module load)
2. bounce the host → send a normal message in a bound conversation
3. `tail -f /home/box/sand-data/live-metrics.jsonl` → fresh rows per turn
4. context guardian: long tool outputs in history get pruned on later turns;
   a `[... truncated by Anti-Cooking Context Guardian ...]` marker appears
5. in-chat `/reset` clears the in-flight conversation state

## Test philosophy

This tree is covered by the 98-check harness; CI runs it on every push.
If you change anything in `box/`, `node box/test/run-all.cjs` is the gate.
