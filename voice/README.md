# GrokBot Voice

Turns your machine into a full **realtime voice assistant**:

- **Ears** — streaming speech-to-text (Grok/xAI STT), energy-gated turn detection
- **Captain** — OpenAI **realtime model** brain (`gpt-realtime-2.1`) with consult/dispatch tools
- **Mouth** — ElevenLabs TTS (any voice, including your own clone), never-flush queue with barge-in

Everything runs locally. Audio leaves your machine only to the providers you configure
(xAI STT, OpenAI realtime, ElevenLabs TTS).

## What you need

| Requirement | Where to get it |
|---|---|
| Node.js 18+ | https://nodejs.org (LTS) |
| ElevenLabs account | https://elevenlabs.io (free tier works) |
| OpenAI account with realtime access | ChatGPT Plus/Pro, or an API key |
| Grok CLI auth (for the ears) | see SETUP.md — a one-time login |

## Quick start

```powershell
cd voice
.\scripts\start-voice.ps1
```

The script starts the gateway, panel, and consult gateway, then opens the panel at
**http://127.0.0.1:8094**. The checklist banner on the page shows exactly which piece is
missing and links to the fix. Click **Start call** and talk — you can interrupt any time.

## Docs

- **[SETUP.md](SETUP.md)** — full walkthrough: ElevenLabs voice + key, OpenAI realtime token
  (Codex CLI login or API key), Grok CLI auth for the ears, consult roster, live-context feed.
- **[.env.example](.env.example)** — every knob, commented
- **[AUDIO_CONTRACT.md](AUDIO_CONTRACT.md)** — sample-rate / pipeline contract

## Ports (all localhost-only)

| Port | Service |
|---|---|
| 18793 | Voice gateway (supervisor): `/health` + WebSocket |
| 8094 | Panel (static server + health proxy) |
| 18795 | Consult completion gateway (optional lane) |

Do not expose the gateway to the network without your own auth in front of it.

## License

MIT — same as the repo.
