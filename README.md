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

## 🗺️ Status

- ✅ Working today: Grok, GLM, Claude plans, Gemini (incl. fast lane), DeepSeek, local llama.cpp
- 🧪 Pattern proven, capture pending: OpenRouter, Groq, Mistral, xAI OAuth
- 📄 Docs: [MODEL-GUIDELINES](docs/MODEL-GUIDELINES.md) · [BYOK vs hop](docs/BYOK-DECISION.md) · [FAILURE-MODES](docs/FAILURE-MODES.md) · [ROADMAP](docs/ROADMAP.md)

---

<p align="center">
  <sub><b>not farming you, arming you.</b></sub>
</p>
