# Validation Contract — Voice Assistant Port into opengrok

**Mission:** Port the working realtime voice stack (ears / captain / mouth / supervisor /
watchdog) from the private machine-local install into the public repository,
fully sanitized, with an end-to-end onboarding path (ChatGPT OAuth for
the realtime brain + ElevenLabs for the mouth) such that a stranger can clone,
set up, and talk to it with zero personal-info leakage and zero dead ends.

**Scope:** Runtime lanes only. The MITM / mobile-bridge / phone lane is explicitly
OUT of scope (owned separately).

---

## Sanitization requirements (hard law)

- S-1: Zero absolute personal user-home paths in any tracked files (Windows-style
  `Users-backslash-name`, POSIX `Users-slash-name`, MSYS `c-slash-Users` forms).
  All paths that reach user homes must go through `os.homedir()` or env config
  with generic defaults.
- S-2: Zero personal identifiers: no first names, no personal handles, no machine name,
  no private agent-ID rosters, no voice-clone IDs, no pronunciation-dict IDs,
  no personal API keys/tokens (scan-verified).
- S-3: All auth flows from env vars or interactive first-run logins — no baked tokens,
  no committed `.env`, `.env` in `.gitignore` verified.
- S-4: Default persona text is generic (works for any user); persona is user-suppliable
  via config. No hardwired private agent names — consult targets come from the
  user's own `VOICE_CONSULT_ROSTER` config.

## Runtime requirements (stranger test)

- R-1: `node voice/supervisor.cjs` starts all four lanes (ears STT, captain realtime,
  mouth TTS, supervisor) on a stock Windows/macOS/Linux box with only Node >= 18
  (mic capture runs in the browser panel — no native audio deps).
- R-2: Missing credentials produce a guided, actionable error (which env var, which URL
  to get it, exact format) — never a stack trace as the first line of failure.
- R-3: ChatGPT/OpenAI onboarding: documented step-by-step (Codex CLI login writes
  `~/.codex/auth.json`, stack picks it up; or `VOICE_OPENAI_TOKEN` env alternative).
- R-4: ElevenLabs onboarding: documented step-by-step (API key, voice selection incl.
  clone-your-voice path, optional pronunciation lexicon), `.env.example` documents
  every key.
- R-5: A doctor command verifies: Node version, `.env` presence, ElevenLabs config,
  OpenAI realtime auth (env or Codex login), Grok/xAI auth (env or `~/.grok/auth.json`)
  — each with PASS/FAIL + fix hint, exit code 1 on blockers.
- R-6: Degraded-but-honest without credentials: gateway boots without ElevenLabs
  (health shows `mouth: down`, checklist explains the fix); no fake success.

## Repo integration requirements

- I-1: Voice stack lives as a self-contained subpackage (`voice/` at repo root) with its
  own README; linked from the root README.
- I-2: ~~`setup.py` gains a voice step~~ AMENDED 8/29: voice is fully self-contained
  (`voice/doctor.js` + `voice/scripts/start-voice.ps1`); no coupling to setup.py.
- I-3: Launchers: `voice/scripts/start-voice.ps1` + `stop-voice.ps1` (Windows-first,
  documented), plain `node` commands work everywhere; no hardcoded user paths.
- I-4: MIT license + attribution preserved; no upstream code copied beyond what the
  port needs.

## Validation gates (all must PASS before push)

- V-1 leak-scan: `node voice/scripts/leak-scan.js` (committed, repeatable, structural
  patterns only) returns CLEAN; plus a one-off grep for the specific personal IDs on
  the push tree returns 0 hits. Expected matches: 0.
- V-2 fresh-clone test: clone to a clean temp dir; `node voice/doctor.js` runs and
  exits with guided FAILs (not crashes); `node voice/supervisor.cjs` on an ALT port
  boots all four lanes from the clone.
- V-3 syntax: `node --check` passes on every shipped .js/.cjs file (0 errors).
- V-4 doctor dry-run: doctor with no creds exits 1 with actionable FAIL lines (R-2).
- V-5 git hygiene: build/runtime artifacts ignored (`voice/.env`, logs, markers);
  commit contents scanned, not just tip.
- V-6 push verdict: after `git push`, verify via `git ls-remote origin` that remote
  HEAD matches local; then fresh-clone from the remote and re-run V-1.

## Done definition

All of V-1..V-6 PASS + operator-visible summary with: file inventory, sanitization diff
summary, walkthrough location, and remote commit hash. A PASS with zero checks is not
a PASS: every V- gate must show its actual command output (exit codes are truth).

## Blocked ≠ failed

Any gate that needs credentials not provided (e.g. live OpenAI/ElevenLabs calls) is
reported as BLOCKED with what unblocks it — not silently skipped, not faked.
