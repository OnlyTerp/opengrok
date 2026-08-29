# Validation Contract — Voice Assistant Port into opengrok

**Mission:** Port the working voice-v5 stack (ears / captain / mouth / supervisor /
watchdog) from the private machine-local install into the public `OnlyTerp/opengrok`
repository, fully sanitized, with an end-to-end onboarding path (ChatGPT OAuth for
the realtime brain + ElevenLabs for the mouth) such that a stranger can clone,
set up, and talk to it with zero personal-info leakage and zero dead ends.

**Scope:** Runtime lanes only. The MITM / mobile-bridge / iPhone lane is explicitly
OUT of scope (Terp is finishing mobile separately).

---

## Sanitization requirements (hard law)

- S-1: Zero absolute personal paths (`C:\Users\<name>`, `/c/Users/<name>`, `/Users/<name>`)
  anywhere in tracked files. All configurable via env / config with generic defaults.
- S-2: Zero personal identifiers: no "Rob", "Terp", "onlyterp", "terp", Twitch handle
  `#onlyterp`, machine name, agent-UUID roster, voice-clone IDs, pronunciation-dict IDs,
  Life OS keys/paths, personal API keys/tokens (scan-verified).
- S-3: All auth flows from env vars or interactive first-run prompts — no baked tokens,
  no committed `.env`, `.env` in `.gitignore` verified.
- S-4: Default persona text is generic (works for any user); persona is user-suppliable
  via config. No hardwired private agent names (GLM Friendli / Fable / Opus roster) —
  replaced by a generic consult model list the user configures.

## Runtime requirements (stranger test)

- R-1: `node <entry>` starts all four lanes (ears STT, captain realtime, mouth TTS,
  supervisor) on a stock Windows/macOS/Linux box with only Node >= 18 + portaudio-capable
  mic stack prerequisites documented.
- R-2: Missing credentials produce a guided, actionable error (which env var, which URL
  to get it, exact format) — never a stack trace as the first line of failure.
- R-3: ChatGPT/OpenAI OAuth onboarding: documented step-by-step (where to log in, which
  OAuth flow yields the realtime-capable token, where it lands, how the stack picks it
  up without restart pain).
- R-4: ElevenLabs onboarding: documented step-by-step (API key, voice selection, model
  tier, pronunciation lexicon optional), with a built-in self-test command that speaks
  a test line so the user hears confirmation.
- R-5: A `--doctor` / self-check command verifies: Node version, mic access, OpenAI
  realtime reachability, ElevenLabs API reachability, voice config validity — each with
  PASS/FAIL + fix hint.
- R-6: Works without ElevenLabs too (fallback TTS = system voice), so the free tier of
  the stack (OpenAI only) still functions end-to-end.

## Repo integration requirements

- I-1: Voice stack lives as a self-contained subpackage (`voice/` at repo root) with its
  own README; opengrok's root README links to it.
- I-2: `setup.py` (existing opengrok installer) gains a voice step: detect/offer, never
  break existing non-voice setup if voice deps are absent (voice setup is optional and
  skippable).
- I-3: `start-v5.ps1`-equivalent exists as cross-platform `voice/start.js` (Windows
  `.cmd` + POSIX `.sh` wrappers), no hardcoded user paths.
- I-4: MIT license + attribution preserved; no upstream code copied beyond what the
  port needs.

## Validation gates (all must PASS before push)

- V-1 leak-scan: automated scan of every tracked file for S-1/S-2 patterns
  (personal paths, identifiers, key formats: `sk-`, `xai-`, ElevenLabs key shape,
  JWT fragments, agent UUIDs). Expected matches: 0. Scan script committed at
  `voice/scripts/leak-scan.js` so it is repeatable by anyone.
- V-2 fresh-clone test: clone to a clean temp dir, run setup walkthrough headlessly
  (docs-only mode without creds), confirm every documented command exists and runs
  to its intended prompt/error (expect: all documented entrypoints executable).
- V-3 syntax: `node --check` passes on every shipped .js/.cjs file (expect N files, 0
  syntax errors).
- V-4 doctor dry-run: `voice --doctor` runs with no creds present and exits with the
  guided onboarding message (R-2 behavior), not a crash.
- V-5 git hygiene: `git status` clean after build artifacts ignored; commit history
  contains no secrets (scan commit contents, not just tip).
- V-6 push verdict: after `git push`, verify via `git ls-remote origin` that remote
  HEAD matches local; then fetch fresh clone and re-run V-1 on the fetched tree.

## Done definition

All of V-1..V-6 PASS + Terp-visible summary with: file inventory, sanitization diff
summary, walkthrough location, and remote commit hash. A PASS with zero checks is not
a PASS: every V- gate must show its actual command output (exit codes are truth).

## Blocked ≠ failed

Any gate that needs credentials Terp hasn't provided (e.g. live OpenAI/ElevenLabs calls
in V-2) is reported as BLOCKED with what unblocks it — not silently skipped, not faked.
