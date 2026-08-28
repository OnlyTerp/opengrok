# Wire captures — the evidence

Every map in `tools/provider-maps.cjs` and `tools/provider-maps-hop.cjs` cites
a capture here. A capture is the
raw request/response record of the probe ladder that established the map's
claims. **No capture, no merge** (see `CONTRIBUTING.md`).

## Layout

```
wire-captures/<model-slug>/
├── capture.json    # full ladder: sent body + status + summarized response per probe
└── verdict.json    # machine-readable answer to the 4 questions every route needs
```

## Reading a verdict

| Field | Question it answers |
|---|---|
| `thinks_by_default` | Does a BARE request burn reasoning tokens? |
| `off_switch_works` | Is there a real way to turn thinking off (not just 200)? |
| `effort_tokens_accepted` | Which `reasoning_effort` tokens the wire actually takes |
| `capture` | Path back to the full dump |

## Capture index

| Model | Verdict | Proven by |
|---|---|---|
| `glm-5.3-flash` | thinks by default · `thinking:disabled` is a TRUE off-switch · `low/medium/high/max` all accepted | [glm-5.3-flash/](glm-5.3-flash/) — 7 probes, live 2026-08-26 |
| `gemini-3-flash` via cliproxyapi `:8317` | **negative evidence** · `off_switch_works:false` · effort tokens HTTP-accepted but reasoning_tok did not scale · justifies hop-owned passthrough (no dialect map) | [cliproxy-gemini-3-flash/](cliproxy-gemini-3-flash/) — live 2026-08-28 |

## Reproducing a capture

```bash
python tools/wire-probe.py \
    --base https://open.bigmodel.cn/api/coding/paas/v4 \
    --model glm-5.3-flash \
    --key-env GLM_API_KEY
```

7 tiny calls, max_tokens capped, aborts on hard auth errors. The written
`capture.json` + `verdict.json` are exactly what goes in the PR.

## Hygiene

- Captures store request bodies, statuses, and response excerpts — never
  Authorization headers, API keys, or tailnet addresses. QA scans every push
  for key-shaped strings and private IPs.
- `capture.json` keeps full responses; nothing else is needed to verify claims.
