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

## F. Vendor bundle integrity

### F19 — Repacked asar dies at boot ("Integrity check failed")
- **SYMPTOM:** `FATAL: asar_util.cc:143] Integrity check failed for asar archive (X vs Y)` — instant boot death after any app.asar modification; stock asar boots fine.
- **CAUSE:** two independent traps: (1) Electron's embedded-asar-integrity fuse — the exe carries `[{"file":"resources\\app.asar","alg":"SHA256","value":…}]` and boot requires `value == sha256(asar JSON header bytes)` (NOT the whole file); (2) naive extract+repack drops `unpacked: true` flags, inlining native `.node`/`.exe` files that can only load from `app.asar.unpacked/`.
- **LOCK:** preserve the unpack set (derive it from the install's `app.asar.unpacked/` at apply time), then sync the exe's embedded value to the new header hash (same-length hex swap, keep a pre-patch exe backup). Fail loud if the integrity block is missing/ambiguous or the unpack set can't be expressed. `tools/glass-inject.py` implements both gates.

### F20 — Update silently deletes the injection seam
- **SYMPTOM:** patcher's anchor count drops to 0 after a platform update; the routed lane falls back to the stock model with no error.
- **CAUSE:** the vendor restructured/minified the session factory (e.g. `new e("openai_session"` disappeared entirely along with the whole custom-session path).
- **LOCK:** the patcher's unknown-SHA + anchor-count refusal is sacred — never allowlist a SHA whose required anchors are absent. Re-map the seam on the pulled bundle first (unique count==1 anchor, preserved option surface), revise the patch contract with behavioral red/restore/green on a mock upstream, then patch. Blind "update the allowlist" is how you silently ship a no-op.

### F21 — macOS inject: THREE stacked traps (asar integrity carrier, sealed resources, library validation)
- **SYMPTOM:** repacked `app.asar` kills the app at launch on macOS — either instant `sealed resource is missing or invalid` from `codesign --verify`, or dyld abort `Library not loaded: @rpath/Electron Framework… Reason: … different Team IDs` (SIGABRT, `fatalDyldError`).
- **CAUSE:** three independent layers beyond F19's Windows traps: (1) the asar-integrity hash lives in `Contents/Info.plist` → `ElectronAsarIntegrity["Resources/app.asar"].hash` (fuses `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` verified enabled) — the Windows exe-block patch is a no-op on Darwin; (2) `Info.plist` and `app.asar` are sealed resources of the Developer ID signature (Team DCNK4UB866, notarization stapled) — editing either invalidates the Apple seal, and the vendor cert cannot be re-applied locally; (3) adding `--options=runtime` (hardened runtime) to the ad-hoc signature enables library validation, which kills the ad-hoc main at first dyld map (`non-platform have different Team IDs`) — the decisive fix is signing ad-hoc WITHOUT the runtime flag; the Electron Framework's internal leaves (`Helpers/*`, `Libraries/*.dylib`) stay vendor-signed and load fine once validation is off. The `app.asar.unpacked` native `.node` modules (loose, dlopen'd) are re-signed ad-hoc as belt-and-suspenders.
- **LOCK (proven on macOS 26.5.1 arm64, Grok Bot 0.61.0):** sync the plist hash, re-sign ad-hoc WITHOUT hardened runtime — loose Mach-O leaves outside nested bundles first (main exe + `.unpacked` natives, magic-byte detect), then nested bundles deepest-first, then root — preserving entitlements (vendor main-exe entitlements are re-applied from `tools/entitlements/grokbot-main-vendor.entitlements` — a stripped-entitlements sign makes "preserve current" permanent and starves boot of helpers). Strip `com.apple.quarantine` or Gatekeeper kills the ad-hoc build. Rollback restores the asar+plist as a same-run PAIR (mixing an old stock asar with a newer plist passes codesign but aborts Electron). `@electron/asar` 4.3.1 CLI quirks are load-bearing: options after positionals; repeated `--unpack*` flags are last-wins; brace globs match only the first alternative — express the unpack set as one `parent/+(a|b)` extglob + one `+(files)` extglob. Verify HUD live via `--remote-debugging-port=9222` → `/json/list` → `Runtime.evaluate` on the guard (`window.__grokbotLiquidGlassInjected`). `tools/glass-inject.py` implements all of this.

---

*Additions welcome — include reproduction steps and the lock that worked.*
