<p align="center">
  <img src="assets/hero.png" alt="open·grok — run any model in Grok Bot: one model per agent, pick, test, save. keys stay on your machine. pick a model → wire map applies → talks native → survives updates" width="100%">
</p>

<p align="center">
  <a href="#-quick-start"><img alt="setup" src="https://img.shields.io/badge/setup-one%20command-7c6cff"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-3fb950"></a>
  <a href="#-the-laws"><img alt="evidence" src="https://img.shields.io/badge/maps-evidence--based-a78bfa"></a>
  <a href="https://github.com/OnlyTerp/opengrok/actions/workflows/verify.yml"><img alt="verify" src="https://github.com/OnlyTerp/opengrok/actions/workflows/verify.yml/badge.svg"></a>
  <img alt="deps" src="https://img.shields.io/badge/dependencies-zero-2f81f7">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-8b949e">
</p>

<p align="center">
  <b>Pick a model per agent. Save. Keys stay on the hop, not in bindings.</b><br>
  Stock Grok Bot 0.30 needs the box installer. Mac-only setup does not route chat.
</p>

---

<p align="center">
  <img src="assets/picker.png" alt="the model picker — one dropdown per agent" width="640">
</p>

## Quick start

**Stock Grok Bot cloud computer (the common case).** Do this on the Bot's
computer, not only on your laptop. Full write-up: [STOCK-HOST](docs/STOCK-HOST.md).

```bash
git clone https://github.com/aaravarr/opengrok
cd opengrok
export API_SERVER_KEY='your-provider-key'
python3 tools/install-stock-box.py \
  --upstream http://YOUR-OPENAI-COMPAT-HOST:PORT \
  --model glm-5.3-flash
```

Bounce `sand-host`, then send a normal message in the Bot. Proof is
`/tmp/opengrok-session.log` and traffic on `127.0.0.1:18790`.

`python setup.py` on your Mac still builds bindings and the picker. That
does **not** make stock Grok Bot read them. `apply-box-patch.py` refuses a
stock host and points here (issues #3, #5).

```bash
python tools/doctor.py        # anytime: is everything still healthy?
python tools/qa.py            # repo self-check: leaks, refs, tests
```

## What it gives each model

Dropping a foreign model into Grok Bot usually "works" and feels *off* — slower,
dumber, token-hungry. That's harness mismatch: the model was RL-trained on its
own harness's wire shape, and gets a generic prompt shape plus wrong reasoning
knobs. opengrok fixes the wire:

| Model family | What goes wrong vanilla | What opengrok does |
|---|---|---|
| **Grok (xAI)** | effort knob is `xhigh`, not `max`; `fast` has no field | literal token mapping, always-on reasoning documented |
| **GLM (Zhipu)** | thinks by default — silence is *expensive*; `max` is a real | verified token table + true off-switch via `thinking:disabled` |
| **Claude** | thinking is owned by the auth shim; body-painting it 400s | shim-owned thinking, effort passes clean |
| **Gemini** | "fast" was decorative — the knob is the *slug*, not a field | fast lane rerouting, measured 1.5s → 0.9s first token |
| **DeepSeek** | thinking lives in the model slug, not the body | slug-owns-thinking mapping |
| **local models** | context/recovery edges | dedicated route, fail-closed |

Every row of that table is backed by a capture in `wire-captures/`
(see [glm-5.3-flash](wire-captures/glm-5.3-flash/) for the full ladder —
bare request thinks by default, `disabled` really switches it off, `max` is a
real token).

## How it fits together

```
 Grok Bot agent
      │  modelId + parameters (thinking/effort/fast)
      ▼
 provider-maps ──► per-provider wire truth (verified, versioned, tested)
      │
      ▼
 upstream (xAI / Zhipu / Anthropic / Google / DeepSeek / local llama.cpp)
```

**Two contracts, one story:**
- `provider-maps.cjs` — Contract A: direct body maps (client-side lanes)
- `provider-maps-hop.cjs` — Contract B: `applyHarnessControls()` for hop lanes — this is what ships on the box

**Cloud agents.** Stock hosts wrap `createProtoSession` via
`tools/install-stock-box.py`. Hosts that still contain the private OpenAI hop
lane can use `tools/apply-box-patch.py`. See [STOCK-HOST](docs/STOCK-HOST.md)
and [CLOUD-HOST](docs/CLOUD-HOST.md).

## Update-proof by design

Grok Bot updates silently rewrite its bundle. Instead of hoping:

- `doctor.py` **baselines your machine** on setup and watches files, services,
  and caches — after any update it tells you *exactly what moved*
- `--quiet` mode stays silent when clean (cron-friendly), complains only on drift
- maps hot-reload; no restart needed to fix a route
- after a host update, re-run `install-stock-box.py` (wrap is idempotent, and
  `--census-only` tells you if `createProtoSession` vanished)

## The laws

Hard-won rules this repo encodes — each one earned by a real failure:

- **Evidence or it doesn't ship.** No map lands without a wire capture (`tools/wire-probe.py`).
- **200-accepted ≠ honored.** A field that 200s and does nothing is worse than a 400. Behavior-prove every knob.
- **Silence is not cheap.** Several providers think by default; a bare request burns reasoning tokens.
- **Shared connection pools break under load; fresh-connection-per-call triggers throttling.** Thread-local keep-alive or nothing.
- **Fail-closed over fake success.** If a control can't be expressed on the wire, document the noop — never pretend.

## Testing (how we know it's true)

```bash
node tools/test-provider-maps.cjs          # Contract A
node tools/test-provider-maps-hop.cjs      # Contract B
python tools/test-wrap-proto-session.py    # stock createProtoSession wrap
node tools/test-openai-hop-session.cjs     # shipped hop session
python tools/qa.py                         # leak scan, ref integrity, suites
```

CI runs these on every push and PR. The QA tool is itself
negative-control-tested: plant a fake key or break a file and it **fails
loudly** — a green that can't fail is decoration.

## Adding a provider

```bash
python tools/wire-probe.py --base https://api.example.com/v1 --model their-model --key-env THEIR_API_KEY
```

Run it, paste the verdict into a PR with the capture attached.
`CONTRIBUTING.md` has the contract — **no capture, no merge.**

## Voice assistant (voice/)

A full local realtime voice assistant built on the same wire-truth philosophy:

- **Ears** — streaming STT (Grok/xAI), energy-gated turn detection
- **Captain** — OpenAI realtime brain (`gpt-realtime-2.1`) with consult/dispatch tools
- **Mouth** — ElevenLabs TTS (any voice, including your own clone), never-flush queue, barge-in

Browser panel UI, zero native audio deps, all lanes localhost-only. Setup is a
guided walkthrough (ElevenLabs key + Codex CLI login + Grok CLI login), with a
doctor that tells you exactly what's missing:

```powershell
node voice/doctor.js                      # pre-flight check
voice\scripts\start-voice.ps1             # start everything, open the panel
```

See [voice/README.md](voice/README.md) · [voice/SETUP.md](voice/SETUP.md).

## Status

- Stock Grok Bot 0.30 box install: `install-stock-box.py` (this fork)
- Private OpenAI-hop host: `apply-box-patch.py` (refuses stock bundles)
- Maps live-verified: Grok, GLM, Claude plans, Gemini (incl. fast lane), DeepSeek, local llama.cpp
- Pattern proven, capture pending: OpenRouter, Groq, Mistral, xAI OAuth
- Docs: [STOCK-HOST](docs/STOCK-HOST.md) · [MODEL-GUIDELINES](docs/MODEL-GUIDELINES.md) · [BYOK vs hop](docs/BYOK-DECISION.md) · [FAILURE-MODES](docs/FAILURE-MODES.md) · [CLOUD-HOST](docs/CLOUD-HOST.md) · [ROADMAP](docs/ROADMAP.md)

---

<p align="center">
  <sub><b>not farming you, arming you.</b></sub>
</p>
