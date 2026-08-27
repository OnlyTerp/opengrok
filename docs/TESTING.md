# Testing Discipline — How Not to Fool Yourself

The rules that kept this stack honest. Written after each was violated at least once.

---

## 1. Every green needs a proven red

A detector/test that has never failed is indistinguishable from a broken one.

**Protocol (do it for real):**
```
1. BREAK: actually stop a real service (kill the process; don't simulate).
2. RUN the check → MUST go noisy/nonzero-exit.
3. FIX: restore via the canonical command.
4. RE-RUN → MUST return to silence.
```

Recorded proof from this repo's development:
- killed llama server → doctor printed `[FAIL] svc :30000 NOT LISTENING`, exit 2 ✅
- relaunched with canonical command → models endpoint answers, doctor silent, exit 0 ✅

## 2. Negative controls prove boundaries; both-green = worst outcome

Auth boundary test is two assertions, not one:
| call | expected |
|---|---|
| through hop (key injected server-side) | success |
| direct, NO key | rejected (401/403) |

If direct-no-key also succeeds, you don't HAVE a boundary. If hop fails but direct works, the hop is broken. If BOTH succeed silently somewhere, treat it as an incident.

## 3. Never mirror the logic under test

A test that reimplements the code it checks will pass even when the code regresses. Drive the REAL entry point — the actual dispatcher function, the actual HTTP handler, the actual CLI — and assert content only the real implementation can produce. Then revert the fix once and confirm the suite FAILS (byte-identical restore afterwards). This double-proves the tests bite.

## 4. Runtime beats literal checks

String assertions on HTML/markup/config pass while behavior is broken. Where feasible, execute behavior in a runtime (node vm for JS modules, real POST for servers) rather than grepping sources.

## 5. Exit codes are evidence only when pipelines aren't lying

Never pipe verification commands through filters/tails that report the LAST pipeline element's status. Run bare; if you need shorter logs, write full output to a file you inspect separately.

## 6. Static first, live last, approved always

For metered/subscription lanes:
1. Unit tests against recorded wire fixtures.
2. Local fake-upstream integration (hit localhost doubles only).
3. ONE approved live end-to-end probe, streamed, with the assertion written BEFORE sending.

Routine periodic checks (doctor crons) use keyless/static probes ONLY so monitoring itself never costs tokens.

## 7. An honest skip is louder than a silent pass

Conditional skips in suites look green. Make environment requirements explicit failures (`available() -> else FAIL`) so a missing dependency screams instead of shrugging.

## 8. Prove file state, not intentions

After ANY claim-shaped event ("saved the doc", "applied the patch", "restarted the server"):
`ls -la` the file · read back a checksummed excerpt · netstat the port.
An agent (or human!) reporting success without artifact proof is running on vibes; several documented incidents in this stack trace exactly to trusting that report.
