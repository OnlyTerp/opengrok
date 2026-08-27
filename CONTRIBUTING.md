# Contributing a provider route

The rule that governs everything here: **a map ships only with evidence.**
No vibes, no "should work," no copying another provider's table. The wire-probe
tool makes the evidence cheap — one command, 7 tiny calls.

## Adding a provider (the whole process)

**1. Run the probe ladder:**
```bash
export MYPROVIDER_API_KEY=sk-...        # key never leaves your machine
python tools/wire-probe.py \
    --base https://api.provider.com/v1 \
    --model their-best-model \
    --key-env MYPROVIDER_API_KEY
```

**2. Read your verdict.json** — it answers the four questions every route needs:
- Does it think by default? (`thinks_by_default`)
- Is there a real off-switch? (`off_switch_works`)
- Which effort tokens are accepted? (`effort_tokens_accepted`)
- What does it echo back that we didn't expect? (check `other_msg_keys`)

**3. Write the route** in `tools/provider-maps.cjs` following the GLM example:
- **gap-fill only** — if the caller set a field, never overwrite it
- unknown effort token → leave provider default, don't guess
- no verified off-switch → `fast` is an explicit noop with a reason string
- cite the capture: `// live-verified YYYY-MM-DD (wire-captures/<slug>/)`

**4. Add tests** in `test-provider-maps.cjs` — at minimum:
- the happy path (effort maps correctly)
- the off-switch (or its documented noop)
- the minimal-intervention case (silent request stays untouched)

**5. PR with `wire-captures/<slug>/capture.json` + `verdict.json` included.**
Reviewers verify claims against captures, not against your prose.

## Testing discipline (short version — full doc: docs/TESTING.md)

Every green needs a proven red: revert your map change, watch the new tests
fail, restore byte-identical. A test that can't fail is decoration.

## What we don't accept

- Maps from documentation reading alone (docs lie; wires don't)
- "It worked when I tried it once" without the capture
- Effort-token mappings inferred from another vendor's behavior
