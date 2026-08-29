# Audio Contract

Sample-rate and pipeline law for every lane. Breaking any line here breaks barge-in,
turn detection, or seam quality.

## Rates

| Lane | Rate | Format |
|---|---|---|
| Microphone uplink (UI → gateway) | 24000 Hz | PCM16 mono, base64 in JSON `input_audio` |
| STT downlink/uplink (ears ↔ xAI) | 16000 Hz | PCM16 (ears downsamples 24k→16k internally) |
| TTS playback (mouth → UI) | 24000 Hz | PCM16 mono (`pcm_24000`), base64 in JSON `audio.delta` |

## Pipeline

```
mic 24k ──► gateway ──► ears (16k, xAI STT, energy-gated finalize)
                            │ transcript
                            ▼
                        captain (OpenAI realtime, TEXT only)
                            │ speak requests
                            ▼
                        mouth (ElevenLabs pcm_24000)
                            │ audio.delta
                            ▼
                        UI playback (WebAudio, 24k)
```

## Laws

1. **One generation per answer.** The mouth never flushes mid-reply; queue is drained
   in order. Barge-in bumps the generation and drops the queue.
2. **No per-chunk volume pumping.** The UI receives one `audio.delta` per reply — do
   not re-introduce sliced deltas (they pumped playback volume 5×/second).
3. **Seam trim.** Mouth trims 60 samples of leading silence per clip (`trimSeam`).
4. **Barge = stop + gen++**. Ears owns turn detection (energy gate RMS 250); the UI
   never commits audio turns.
5. **Mic capture**: echoCancellation + noiseSuppression + autoGainControl ON. Without
   EC the assistant hears its own playback and never yields the turn.
