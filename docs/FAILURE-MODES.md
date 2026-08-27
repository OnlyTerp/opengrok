# Failure Encyclopedia

Every failure mode we hit in production, how it presented, and the lock that closed it. Numbered for reference in issues/PRs. **If you find a new one, PR it here with evidence.**

Legend: SYMPTOM (what you see) → CAUSE (what's actually wrong) → LOCK (the fix).

---

## A. Silent infrastructure failures

### F01 — Service dies between checks
- **SYMPTOM:** agent replies degrade or "model missing"; nothing in any log announces the death.
- **CAUSE:** inference/proxy servers exit on transient conditions (OOM, update, crash loop) with no supervisor.
- **LOCK:** identity health probes on a cron (not just TCP — probe an endpoint returning the model/service NAME so a lookalike port can't fool you). `tools/doctor.py svc:` block + every-30-min schedule.

### F02 — False-success tool calls (Windows shells)
- **SYMPTOM:** "command succeeded" (exit 0) but the world didn't change; hours lost.
- **CAUSE:** bash-ish shells with MSYS conversion disabled pass `//c`-style flags RAW to native tools: cmd.exe opens INTERACTIVE and exits immediately having done nothing.
- **LOCK:** single-slash flags; ALWAYS verify the EFFECT (port listening / file mtime changed) after native invocations, never trust the exit code alone.

### F03 — The detector lies
- **SYMPTOM:** watchdog green while things are broken (or noisy forever).
- **CAUSE:** suppression/dedup keys formatted differently at write vs compare time; positive controls faked by broken test actions (a kill command that never killed).
- **LOCK:** single source of truth for key format; EVERY green must have a proven red: break something real → expect exit≠0 → restore → expect silence.

## B. Silent updates & drift

### F04 — Vendor update replaces your stack
- **SYMPTOM:** after an app self-update, routing falls back to defaults, or patched binaries get REFUSED (best case).
- **CAUSE:** stock host replaced; attestation manifests pin old hashes; nothing told you.
- **LOCK:** SHA baselines over host/binding/config files + cache-staleness tripwires (fetch dates, versions) + current-only gate refusing unreviewed versions + deliberate re-baseline (`doctor.py --init` AFTER inspecting what changed). Never bypass an attestation fuse — regenerate its manifest through the review path instead.

### F05 — Config/code drift without updates
- **SYMPTOM:** model list explodes; a lane behaves like a stranger wrote it.
- **CAUSE:** curation flags flipped (discovery re-enabled), hand-edits in shared files, sibling agents editing concurrently.
- **LOCK:** watched-file SHAs + exact-flip alerts (False→True) + re-check shared files before AND after edits when more than one operator exists.

### F06 — Persistence gaps
- **SYMPTOM:** everything fine until next reboot; then half the stack missing.
- **CAUSE:** launchers referenced scripts that moved; VBS/unit files absent; manual-only start paths forgotten.
- **LOCK:** persistence inventory checked every doctor cycle (launcher present AND target script present); one canonical relaunch command per service, documented, tested.

## C. Model-behavior degradation

### F07 — "Dumb mode" on provider-tuned models
- **SYMPTOM:** model noticeably below its own benchmarks; filler answers; forgets instructions mid-task.
- **CAUSE:** request shape lacks fields the provider's RL harness always sent (thinking flags, effort, max-token floors); model treats your prompt as an out-of-distribution weirdo.
- **LOCK:** per-provider wire map (see tools/provider-maps.cjs); verify with a known-answer probe before/after enabling.

### F08 — Reasoning payload kills the run mid-flight
- **SYMPTOM:** long job dies at minute 20 with an SDK TypeError naming a field like `thinking`; all work lost; no failover.
- **CAUSE:** wire-level options passed as SDK kwargs (crash client-side pre-request) instead of body/extra_body merge.
- **LOCK:** allowlist of real SDK kwargs; everything unknown merges into extra_body/body root; add a signature-drift guard test.

### F09 — Effort/suffix mishandling
- **SYMPTOM:** shallow answers despite "max" settings; or surprise slow burns from every call.
- **CAUSE:** caller omits effort and a shim injects ITS default; slug suffixes parsed inconsistently; "none" emitted for providers where reasoning is always-on.
- **LOCK:** explicit effort in bindings' parameters; assert resolved effort once in shim logs at startup; omit rather than emit invalid values.

### F10 — Summarizer/memory eating the constrained lane
- **SYMPTOM:** dead air; context crawls; GPU/quota exhausted by invisible work.
- **CAUSE:** background summaries share the main lane; a runaway produced 100k+ tokens in one turn.
- **LOCK:** separate summarizer route or strip-tools+cap-output summary profile; suppress async summaries on single-lane setups; bounded blocking compaction budgets per user turn, fail-closed.

### F11 — Retry storms & synthetic statuses
- **SYMPTOM:** brief provider hiccup converts into fleet-wide failover; monitoring shows impossible status codes.
- **CAUSE:** transient 5xx treated as exhaustion; layers synthesize fake 429s evicting healthy lanes.
- **LOCK:** same-plan immediate retry for blips; cooldown+budget only after PERSISTED errors; return REAL upstream codes verbatim.

### F12 — Fail-open routing lies about which model answered
- **SYMPTOM:** "usage limit" UI while the configured local/custom lane sits healthy; answers clearly not from the bound model.
- **CAUSE:** bound-route errors fall through to global/default provider.
- **LOCK:** fail CLOSED on bound routes: error out visibly rather than substitute.

## D. Token waste

### F13 — Discovery flood
- **SYMPTOM:** picker unusable; accidental selection of expensive/wrong variants.
- **CAUSE:** remote catalog discovery left enabled after initial curation.
- **LOCK:** curate inline; flip discovery OFF; doctor alert on flips (pairs with F05).

### F14 — Unbounded outputs / missing budgets
- **SYMPTOM:** occasional gigantic bills/runaways from specific lanes.
- **CAUSE:** no max-token defaults anywhere; one lane omits budget entirely.
- **LOCK:** sensible per-lane output caps enforced at the shim (gap-fill ONLY — never override explicit caller budgets).

### F15 — Verification burns metered quota
- **SYMPTOM:** quota drained by repeated smoke tests themselves.
- **CAUSE:** live-provider probes used as routine checks.
- **LOCK:** static/unit verification everywhere; live probe only as final gated step with approval (Devin-style weekly quotas drain permanently).

## E. Auth & secrets

### F16 — Decorative auth boundary
- **SYMPTOM:** "protected" endpoint answers happily without credentials.
- **CAUSE:** negative control never run; hop/gateway misconfig.
- **LOCK:** require BOTH: with-key=200 AND keyless=rejected (401), checked by the doctor on every cycle.

### F17 — Secrets leaking into files/logs
- **SYMPTOM:** token found in a config copy, a log line, or worse — a pushed repo.
- **CAUSE:** convenience hardcoding; verbose logging of headers.
- **LOCK:** env/OS-store only; shims never log Authorization/bodies; pre-push secret grep (sk-, Bearer, JWT shapes).

### F18 — Locked credential stores
- **SYMPTOM:** automation can't read browser cookie DBs while the browser runs.
- **CAUSE:** exclusive locks on credential databases.
- **LOCK:** dedicated profiles/dir copies for automation; never fight the user's live session.

---

*Additions welcome — include reproduction steps and the lock that worked.*
