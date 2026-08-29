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
  <b>Pick a model per agent. Save. It talks native and survives Grok Bot updates.</b><br>
  Keys never leave your machine. Every wire claim in this repo is probe-verified, not vibed.
</p>

---

<p align="center">
  <img src="assets/picker.png" alt="the model picker — one dropdown per agent" width="640">
</p>

## ⚡ Quick start

```bash
git clone https://github.com/OnlyTerp/opengrok
cd opengrok
python setup.py
```

That's the whole install: it detects your Grok Bot install and live services,
adopts existing bindings or asks 3 questions, writes its config, baselines your
machine, and opens the picker. Then:

1. **pick** a model for each agent in the dropdown
2. **test** it live (one click, real request)
3. **save** — done

```bash
python tools/doctor.py        # anytime: is everything still healthy?
python tools/qa.py            # repo self-check: leaks, refs, tests
```

## KORG-I: OAuth-first Grok Bot lane

KORG-I is the lil pup and mascot of the fleet. Its loopback bridge gives Grok
Bot a narrowly scoped xAI route without changing the ordinary `grok` command or
its config.

KORG-I currently supports macOS and Linux. Obtain a real stable agent ID from
Grok Bot's existing agent or workflow metadata; never invent one. Then:

```bash
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/bin/korg-i" "$HOME/.local/bin/korg-i"
korg-i auth status
korg-i probe
korg-i bind set --agent-id '<real-stable-grok-bot-agent-id>' \
  --name Executor --model grok-4.6
korg-i configure
```

The existing Grok CLI OAuth record is always the first credential used. API
fallback comes from `KORG_I_XAI_API_KEY`, `XAI_API_KEY`, or a single
1Password reference in
`${XDG_CONFIG_HOME:-$HOME/.config}/korg-i/api-key-ref`. A fallback replay
is allowed only when the same OAuth/API credential pair has proved an exact
model overlap in the current process and OAuth returns 401/403 or structured
quota exhaustion. Redirects, generic 429s, network failures, and 5xx responses
fail closed.

When present, `korg-i configure` resolves `KORG_I_SET_GROK_WRAPPER` or
`set-grok-bot` on `PATH` and invokes it without passing either secret. Without
that optional integration it opens the live model picker directly. Both paths
stay in the same terminal process. Every bridge start rotates an unguessable
session capability and refreshes KORG-I bindings; requests without that
capability are rejected. Bindings and model proof live in private XDG
directories, and KORG-I never rewrites `~/.grok`.

Use `korg-i serve` when bindings already exist and only the bridge is needed.

## 🤖 What it gives each model

Dropping a foreign model into Grok Bot usually "works" and feels *off* — slower,
dumber, token-hungry. That's harness mismatch: the model was RL-trained on its
own harness's wire shape, and gets a generic prompt shape plus wrong reasoning
knobs. opengrok fixes the wire:

| Model family | What goes wrong vanilla | What opengrok does |
|---|---|---|
| **Grok (xAI)** | effort knob is `xhigh`, not `max`; `fast` has no field | literal token mapping, always-on reasoning documented |
| **GLM (Zhipu)** | thinks by default — silence is *expensive*; `max` is real | verified token table + true off-switch via `thinking:disabled` |
| **Claude** | thinking is owned by the auth shim; body-painting it 400s | shim-owned thinking, effort passes clean |
| **Gemini** | "fast" was decorative — the knob is the *slug*, not a field | fast lane rerouting, measured 1.5s → 0.9s first token |
| **DeepSeek** | thinking lives in the model slug, not the body | slug-owns-thinking mapping |
| **local models** | context/recovery edges | dedicated route, fail-closed |

Every row of that table is backed by a capture in `wire-captures/`
(see [glm-5.3-flash](wire-captures/glm-5.3-flash/) for the full ladder —
bare request thinks by default, `disabled` really switches it off, `max` is a
real token).

## 🧩 How it fits together

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

**Cloud agents need one more step.** Stock Grok Bot cloud hosts do not read
`model-bindings.json` — a saved binding is ignored until you install the
binding consumer into the host. `tools/apply-box-patch.py` does that (anchored,
idempotent, backs up first), and `tools/file-relay.py` is the box-side file
relay the picker pushes bindings to. See [CLOUD-HOST](docs/CLOUD-HOST.md) for
the full local → push → patch → bounce → verify flow.

## 🛡️ Update-proof by design

Grok Bot updates silently rewrite its bundle. Instead of hoping:

- `doctor.py` **baselines your machine** on setup and watches files, services,
  and caches — after any update it tells you *exactly what moved*
- `--quiet` mode stays silent when clean (cron-friendly), complains only on drift
- maps hot-reload; no restart needed to fix a route

## 📚 The laws

Hard-won rules this repo encodes — each one earned by a real failure:

- **Evidence or it doesn't ship.** No map lands without a wire capture (`tools/wire-probe.py`).
- **200-accepted ≠ honored.** A field that 200s and does nothing is worse than a 400. Behavior-prove every knob.
- **Silence is not cheap.** Several providers think by default; a bare request burns reasoning tokens.
- **Shared connection pools break under load; fresh-connection-per-call triggers throttling.** Thread-local keep-alive or nothing.
- **Fail-closed over fake success.** If a control can't be expressed on the wire, document the noop — never pretend.

## 🧪 Testing (how we know it's true)

```bash
node tools/test-provider-maps.cjs       # 23/23 — Contract A
node tools/test-provider-maps-hop.cjs   #  6/6 — Contract B
python tools/qa.py                      # leak scan, ref integrity, suites
```

CI runs all three on every push and PR. The QA tool is itself
negative-control-tested: plant a fake key or break a file and it **fails
loudly** — a green that can't fail is decoration.

## ➕ Adding a provider

```bash
python tools/wire-probe.py --base https://api.example.com/v1 --model their-model --key-env THEIR_API_KEY
```

Run it, paste the verdict into a PR with the capture attached.
`CONTRIBUTING.md` has the contract — **no capture, no merge.**

## 🎙️ Voice assistant (voice/)

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

## 🗺️ Status

- ✅ Working today: Grok, GLM, Claude plans, Gemini (incl. fast lane), DeepSeek, local llama.cpp
- 🧪 Pattern proven, capture pending: OpenRouter, Groq, Mistral, xAI OAuth
- 📄 Docs: [MODEL-GUIDELINES](docs/MODEL-GUIDELINES.md) · [BYOK vs hop](docs/BYOK-DECISION.md) · [FAILURE-MODES](docs/FAILURE-MODES.md) · [CLOUD-HOST](docs/CLOUD-HOST.md) · [ROADMAP](docs/ROADMAP.md)

---

<p align="center">
  <sub><b>not farming you, arming you.</b></sub>
</p>
