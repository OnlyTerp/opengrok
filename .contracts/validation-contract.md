# Validation Contract — opengrok takeover: port the 9/2 Grok-bot wave + fix reliability + answer the issues

**Mission:** Take over https://github.com/OnlyTerp/opengrok. Terp's ask: "no where near
reliable or easy enough to use … take it over and get it perfect." Two inputs:

1. The **9/2 /teamwork wave** that shipped live on his machine but never landed in the
   repo: Context Guardian, in-chat reset, provider wire maps (36-route), Cerebras
   recognition, probe triage. Isolated material lives in `C:\Users\User\.grokbot\` and
   `C:\Users\User\.terp\grokbox\box-fs\`.
2. Five unresolved community issues (#3,4,5,8,10) all pointing at the same hole:
   `openai-hop-session.cjs` + the real host-patch path were never published, and the
   patch anchors assumed a pre-patched bundle stock users don't have.

**Hard laws inherited from repo + operator:** no personal identifiers/paths/IPs in
tracked files; no fixture-only capability (drive real entry points); exits are truth;
BLOCKED ≠ failed (one honest attempt, report, stop); nothing pushed without Terp GO.

## File inventory (port plan)

| # | Source (isolated, verified live) | Repo destination | Sanitization |
|---|---|---|---|
| 1 | `.terp/grokbox/box-fs/openai-hop-session.cjs` (1966 ln, CRLF, node --check OK, 341-test suite green) | `box/openai-hop-session.cjs` (LF) | S-1..S-3 (env-var takeover) |
| 2 | `.grokbot/harness-shim-work/provider-maps.cjs` (449 ln = box-fs copy byte-identity for CRLF lines) | merge into `tools/provider-maps.cjs` + `tools/provider-maps-hop.cjs` | doc refs only |
| 3 | `.terp/grokbox/box-fs/reapply-model-bindings-patch.py` (856 ln, LF) | `box/reapply-host-patch.py` | S-1..S-3 |
| 4 | `.grokbot/grokbot-liquidglass.js` (1797 ln, LF) | `box/liquidglass.js` (+ docs) | S-1..S-4 (roster = user's own bindings) |
| 5 | `.grokbot/harness-shim-work/test-*.cjs` (m1/m2-full/m2-* /m4 ×2/provider-maps; driver-verified 9/4: m1=11, m2-full=26, m2-adv=19, m2-emp=3, m4-node=14, m4-challenger=25 = 98 unique harness passes; provider-maps merged suite 34/34) | `box/test/*.cjs` | dedupe vs repo suites |
| 6 | `.terp/grokbox/box-fs/reapply-*` doc refs (PATCHES/SHIP-STATUS/DESIGN-NOTE/BINDINGS-SCHEMA/PARITY) | `docs/BOX-INTEGRATION.md` | rewrite |

Not ported: box-only bash scripts, `maps-box.cjs` (superseded by #2), `apply_on_box.sh`
(older parallel of #3), app.asar artifacts, LiquidGlass ASAR injector & pyw overlay
(descriptor frozen; in-app mode documented as optional power-user step).

## Sanitization requirements (extend opengrok contract S-1..S-4)

- S-5: `HOP_ENV_BRIEFING` in openai-hop-session.cjs — env-overridable
  (`GROKBOT_HOP_BRIEFING_FILE` / `_S`), generic default with zero names/handles/paths.
- S-6: metrics paths + tailscale push IP — fs-exists discovery over HOME/XDG env vars,
  never hardcoded user paths; tailscale push only via `GROKBOT_METRICS_RELAY` env.
- S-7: provider-maps comments de-personalized; `.grokbot/harness-shim-work` literal
  references → repo-relative docs paths.
- S-8: test fixtures embedded locals (Terpbot name, agent uuid as data) fine ONLY when
  generic context (they fake a bindings dict); real `machine-bindings.json` never read.
- S-9: leak scan (qa.py) extended: names Robert/Terp/onlyterp/Roskey/Rob + terp-life-map
  + machine tailscale IP + `.terp`/`.grokbot` paths must return 0 hits.

## Reliability requirements (the issues)

- R-1 (#4): doctor.py null-sha TypeError — fix both branches, + negative-control test.
- R-2 (#3/5/8/10): CLOUD-HOST.md rewritten honest-state; setup gates resolve step on
  `--check-target` gate step; apply-box-patch.py --dry-run states "SHIPS A PATCHER, NOT BUNDLE";
  reapply path + sha registry documented; anchor-count CI tripwire.
- R-3 (#5 ask 3): CI tripwire proves patch tooling shipped + hop session present.
- R-4: qa.py already runs the m-suite.

## Validation gates (all must show real output before ANY push)

- V-1: `python tools/qa.py` = 0 fails, includes new boxes suite + new leak patterns.
- V-2: `node box/test/run-all.cjs` = 98 harness-pass 0 fail (11 m1 + 26 m2-full + 19 m2-adv + 3 m2-emp + 14 m4-node + 25 m4-challenger, driver-verified 9/4) (port-adapted paths).
- V-3: `node tools/test-provider-maps.cjs` + hop suites original green (23/23, 6/6)
  AND merged-map suite green (34/34 → extended).
- V-4: negative controls: (a) revert guardian call → V-2 count drops (suite bites);
  (b) fake key planted → qa.py fails; (c) `box/openai-hop-session.cjs` requiring
  removed map name fails loudly (import integrity).
- V-5: S-9 leak scan on the full working tree incl. boxes → 0.
- V-6: each closed issue gets a gh comment with real command + exit code evidence;
  PRs triaged honestly; NO pushes/deploys without explicit Terp GO.
- V-7: every /teamwork-panel deliverable matched: Guardian+reset in box lane ✓, maps ✓,
  Cerebras probe module ✓, probe triage doc ✓; divergence documented in
  `docs/MODEL-GUIDELINES.md` (stock-host overlay not portable this 1.0).

## Done definition

V-1..V-5 real-exit-code PASS (no fixture-only lane), Terp-verifiable summary citing
ticket refs + exit codes, full push/PR actions presented as a proposal. "Perfect" =
a stranger can clone → setup → pick → save → see the binding consumed — with the
honest-state doc that says exactly when stock hosts cannot (and what replaces it).

## Blocked ≠ failed

No ✓ fabrication. Live-wire (on-box) patch validation is BLOCKED (no box access
without interrupting Terp's session); reported as such with what unblocks it.
