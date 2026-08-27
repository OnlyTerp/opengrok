# Use ANY Model in Grok Bot — Natively

**Drop any AI model into Grok Bot and have it work properly: full intelligence, no wasted tokens, no breakage when Grok Bot updates itself.**

This repo contains the reference implementation + field-tested guidelines for adding non-Grok models (Claude, Gemini, DeepSeek, GLM, Qwen, local llama.cpp models — anything OpenAI-compatible) to Grok Bot *without* the usual degradation: dumbed-down answers, runaway token burn, or a silent update nuking your routing overnight.

> Born from a production setup running 18 agents across 8+ providers (subscription OAuth lanes, paid APIs, and a local 35B MoE on a 5090). Every guideline here corresponds to a failure we actually hit and locked down.


## Quickstart

```bash
git clone https://github.com/OnlyTerp/opengrok
cd opengrok
python setup.py        # detects your setup, wires everything, opens the picker
```

That's it. Setup asks what it can't detect, verifies live with the doctor,
and drops you in the picker: one dropdown per agent, pick, save.

**Already have Grok Bot configured?** setup adopts your existing bindings.
**Want a provider we haven't mapped?** `tools/wire-probe.py` runs the
evidence ladder — see CONTRIBUTING.md. **Key-only simple provider?**
Grok Bot's native BYOK may be enough — see docs/BYOK-DECISION.md.

---

---

## Why foreign models feel "dumb" in Grok Bot (and why it's not the model)

A third-party model behaves **natively** only when BOTH layers are replicated:

| Layer | Meaning | What breaks without it |
|---|---|---|
| **Wire fidelity** | The request carries fields in the provider's OWN dialect (`thinking`, `reasoning_effort`, tiered slugs...) | Fields silently dropped or SDK TypeErrors mid-run; reasoning degraded or missing |
| **Client identity** | Requests carry a trusted session (OAuth JWT / CLI headers), not a bare BYOK key | Provider treats you as a stranger: throttling, degraded routing, auth churn |

Add a third killer that isn't about the model at all:

| Killer | What happens | Fix in this repo |
|---|---|---|
| **Harness mismatch** | Model RL-trained on ITS OWN harness gets a generic prompt shape and flails ("dumber than its benchmarks") | Per-provider wire maps (`tools/provider-maps.cjs`) |
| **Silent updates** | App self-updates, replaces your patched host/bindings with stock | Doctor + SHA baselines + attestation pattern (`tools/doctor.py`) |

---

## Quickstart (3 minutes)

```
1. Clone this repo.
2. Run the doctor against YOUR machine to see what's live:
       python tools/doctor.py
3. Copy your provider credentials into environment variables
       (NEVER into binding files — see docs/MODEL-GUIDELINES.md §Secrets).
4. Add your model as an agent entry — follow:
       examples/model-bindings.example.json
5. Wire provider-specific behavior (if any) per:
       docs/MODEL-GUIDELINES.md §Wire maps
6. Test with the one-liner smoke in docs/TESTING.md, then set up the
   watchdog cron so updates can't silently wreck things.
```

Full walkthrough: **[docs/MODEL-GUIDELINES.md](docs/MODEL-GUIDELINES.md)** · Failure encyclopedia: **[docs/FAILURE-MODES.md](docs/FAILURE-MODES.md)**

---

## Repo layout

```
tools/
  provider-maps.cjs     # Contract A: harness params -> provider wire fields (direct body maps)
  test-provider-maps.cjs# Contract A test suite (node, zero deps)
  provider-maps-hop.cjs # Contract B: applyHarnessControls() for hop lanes — route table
                        #   + audit shape; this is what ships ON the Grok Bot box
  test-provider-maps-hop.cjs # Contract B test suite
  hop-server.py         # Generic Bearer-injecting hop shim (SSE-streaming safe)
  doctor.py             # Health/drift/update-survival checks; cron-friendly, silent-when-clean
examples/
  model-bindings.example.json
docs/
  MODEL-GUIDELINES.md   # THE guide: making any model work properly + token discipline
  FAILURE-MODES.md      # Every known failure mode, how it bites, and its lock
  TESTING.md            # Positive/negative control discipline (how not to fool yourself)
```

## The 5 non-negotiable laws (full list in docs/)

1. **Unknown wire = leave it alone.** Never fabricate a passthrough for fields you haven't verified on the wire. Ship stubs, not guesses.
2. **Secrets never ride config files.** Bindings get port + slug only; credentials live in env / OS stores behind a hop shim.
3. **Every green needs a proven red.** A test suite that cannot fail proves nothing. Break something on purpose, watch detection fire, restore, confirm silence.
4. **Verify effects, not exit codes.** Especially on Windows shells: a command can exit 0 while doing literally nothing.
5. **Pin what must not move.** Any file whose change means "someone updated/replaced my stack" gets a recorded SHA baseline + periodic check.

## Status

| Piece | State |
|---|---|
| provider maps (grok/claude/gemini/deepseek) | ✅ shipped, 17/17 tests |
| unknown providers (glm/qwen/mimo/local) | honest stubs — verified facts only |
| hop shim | ✅ streaming verified end-to-end incl. negative control |
| doctor + update-survival kit | ✅ running in production, every-30-min cron |

## License

MIT — see [LICENSE](LICENSE).
