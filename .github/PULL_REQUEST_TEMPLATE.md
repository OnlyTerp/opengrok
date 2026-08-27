## What this map claims

<!-- One line per wire claim. Reviewers check each against the capture. -->

- 
- 

## Evidence

PRs that change or add a route MUST include the capture:

- [ ] `wire-captures/<slug>/capture.json` — full probe ladder
- [ ] `wire-captures/<slug>/verdict.json` — machine-readable verdict

Generated with:

```bash
python tools/wire-probe.py --base <base-url> --model <slug> --key-env <PROVIDER>_API_KEY
```

## Tests

- [ ] New/changed behavior covered in `tools/test-provider-maps.cjs` (or `-hop`)
- [ ] Negative control done: reverted the map, watched the new tests FAIL, restored byte-identical
- [ ] `node tools/test-provider-maps.cjs` green
- [ ] `python tools/qa.py` green (leak scan, refs, compile)

## Laws acknowledged

- [ ] gap-fill only — caller-set fields never overwritten
- [ ] unknown effort token → provider default, never guessed
- [ ] no verified off-switch → `fast` is an explicit noop with a reason string
