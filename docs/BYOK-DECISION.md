# Native BYOK vs the hop lane — which one, when

Grok Bot's newer builds ship a **native BYOK** mechanism (`ModelAllowlistByok`):
paste an API key in-app, pick a model, done. Our hop/bindings lane also exists.
They solve different problems. Here's the honest decision table.

## Use NATIVE BYOK when ALL of these are true
- ✅ Your provider speaks plain OpenAI-compatible chat completions
- ✅ Plain API-key auth (no OAuth dance, no subscription plans)
- ✅ You accept the provider's DEFAULT wire behavior (no effort/thinking control)
- ✅ You just want the model available, fast

**Examples that fit:** OpenRouter, Groq, Mistral, most key-metered APIs.

## Use the HOP + BINDINGS lane when ANY of these are true
- 🔶 The model needs **wire fidelity** — effort/thinking controls, slug rules,
  token quirks (GLM max-literal, xAI xhigh-not-max, DeepSeek :thinking slugs)
- 🔶 Auth is **OAuth or a subscription plan**, not a per-call key
  (Claude plans, ChatGPT plans, Google AI subscriptions)
- 🔶 You want **update immunity**: doctor watching files, maps hot-reloading,
  audit trail of every control applied
- 🔶 You want **one key store** shared across many agents (keys in ONE hop, not pasted N times)

**Examples that fit:** Claude subscription via shim, GLM coding plans,
DeepSeek v4 with thinking control, local llama.cpp/ollama with specific context budgeting.

## The hybrid (what power users converge on)

Native BYOK for the boring passthrough providers. Hop lane for everything
where wire behavior or auth shape matters. Both coexist fine — the picker
shows whichever routes your hop exposes, and BYOK models configured in-app
appear alongside them in Grok Bot's own UI.

## Why not just BYOK everything?

Because "it feels off" has a cause: default wire behavior. BYOK gives you the
provider's defaults — that's exactly how you get GLM thinking away your tokens
or DeepSeek running at effort medium when you wanted high. The hop lane exists
to make the wire match your intent, verified by probe, enforced per request.
