# GrokBot Voice — Setup Walkthrough

Everything below is a first-run, out-of-box path. Total time: ~10 minutes. After step 1
you never touch this again; the gateway picks up credentials on every start.

---

## Step 0 — Prerequisites

- **Node.js 18+** — https://nodejs.org (LTS). Verify: `node --version`
- A normal user account on Windows/macOS/Linux.

## Step 1 — ElevenLabs (the voice)

1. Create a free account at **https://elevenlabs.io**
2. Click your profile icon → **API Keys** → **Create API Key** (default scopes are fine)
3. Copy the key
4. In this repo: `cp voice/.env.example voice/.env` and set:
   ```
   ELEVENLABS_API_KEY=sk_...your key...
   ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM   # premade "Rachel" — or your own
   ```
5. Want the assistant to sound like *you*? ElevenLabs → **Voices** → **Add voice** →
   record ~1 minute of yourself → copy the new **voice ID** into `ELEVENLABS_VOICE_ID`.

> Mouth is optional-soft: without a key the gateway still runs but won't speak.
> The panel checklist will show "Mouth down" until the key is set.

## Step 2 — OpenAI realtime (the brain)

Two options — pick ONE:

**Option A (recommended, no API key):** Install the Codex CLI and log in once:
```powershell
npx codex login
```
This writes `~/.codex/auth.json`. The gateway picks that token up automatically.
Your ChatGPT Plus/Pro subscription covers realtime usage through it.

**Option B (API key):** platform.openai.com → API keys → create → set:
```
VOICE_OPENAI_TOKEN=sk-...
```

> Realtime access requires an eligible ChatGPT plan (Plus/Pro) for Option A, or an API
> account with realtime model access for Option B.

## Step 3 — Grok CLI auth (the ears)

The STT lane speaks to xAI's endpoint with a Grok session token.

**If you have the Grok CLI installed:** log in once (`grok login` / `grok auth login`
depending on version) so `~/.grok/auth.json` exists — the gateway reads it directly.

**If you don't:** set the token directly:
```
VOICE_GROK_JWT=eyJ...your Grok session token...
```
(Grab it from the Grok desktop app's config, or wherever your Grok login stores it.)

> Ears is required: without STT the assistant cannot hear you.

## Step 4 — Start it

```powershell
cd voice
.\scripts\start-voice.ps1
```

- The script validates `.env`, starts gateway + panel + consult gateway, opens the browser
- The checklist banner turns **green** when all three lanes are up
- Click **Start call**, allow microphone access, and talk

## Step 5 — Talk to it

- Speak naturally; the assistant finalizes your turn on speech-end
- **Interrupt it any time** — it stops talking and listens (barge-in)
- Ask it to `consult` a smarter model for hard questions if you configured a roster (Step 6)

## Step 6 — Optional power features

### Consult roster (delegate questions to other assistants)
In `voice/.env`:
```
VOICE_CONSULT_ROSTER=Fast|11111111-2222-3333-4444-555555555555|fast,cheap
VOICE_CONSULT_DEFAULT_NAME=Fast
VOICE_CONSULT_DEFAULT_ID=11111111-2222-3333-4444-555555555555
```
Format: `NAME|agent-id|alias,alias`. The agent-id is an opaque ID your downstream
automation understands — anything you can POST to `:18795/consult/ping` can answer.

Who answers: POST to the consult gateway (port 18795):
```
POST http://127.0.0.1:18795/consult/complete
{ "status": "completed", "text": "The answer", "consult_id": "c_..." }
POST http://127.0.0.1:18795/consult/complete
{ "status": "failed", "error": "why", "consult_id": "c_..." }
```
The voice brain speaks the answer aloud when it arrives.

### Live context (what's happening right now)
Point the assistant at any JSON events feed it can read on air:
```
GET http://<VOICE_CONTEXT_HOST>:<VOICE_CONTEXT_PORT><VOICE_CONTEXT_PATH>
Authorization: Bearer <contents of VOICE_CONTEXT_KEY_FILE>
```
It expects `{ events: [ { author_name, text, ts } ] }` shaped rows (loose). Configure via
`.env` — without it, the `read_live_context` tool just reports "no source configured".

---

## Updating later

```powershell
git pull
cd voice && .\scripts\start-voice.ps1
```
Your `.env` is untracked — pull never touches it. If a new version changes the env keys,
`.env.example` is the reference.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Mouth down" in checklist | `ELEVENLABS_API_KEY` missing/invalid in `voice/.env`; restart |
| "Captain down" | No OpenAI realtime auth — `npx codex login`, or set `VOICE_OPENAI_TOKEN`, then restart |
| "Ears down" | No Grok auth — Grok CLI login or `VOICE_GROK_JWT`, then restart |
| Mic blocked in browser | Use `http://127.0.0.1:8094` (localhost is a secure context); avoid `0.0.0.0`/LAN IPs |
| Assistant never finalizes turns | Very noisy room — Ears uses energy gating (RMS threshold 250); speak closer to the mic |
| Assistant talks over you | Barge-in is automatic; if it fails, check that `echoCancellation: true` is on (default) |
| Port already in use | `VOICE_GW_PORT`/`VOICE_PANEL_PORT` in `.env`; the gateway picks 18793/8094 by default |
