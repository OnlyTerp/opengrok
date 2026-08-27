#!/usr/bin/env python3
"""wire-probe.py — add a provider route with EVIDENCE, not vibes.

    python tools/wire-probe.py --base https://open.bigmodel.cn/api/coding/paas/v4 \
        --model glm-5.3-flash --key-env GLM_API_KEY

Runs the 7-probe ladder (the exact recipe that produced our GLM/DeepSeek/grok
maps), saves a full wire-dump to wire-captures/<slug>/, and prints a
fill-in template for provider-maps.cjs. PR the dump + your map together:
reviewers can check every claim against the capture.

Cost discipline: 7 tiny calls, max_tokens capped. Aborts the ladder at the
first hard auth/block error so you never burn calls on a dead key.
"""
import argparse, json, os, sys, time, urllib.request, urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent

PROMPT = [{"role": "user", "content": "Reply with exactly: WIRE_OK"}]

def call(base, model, key, body, timeout=45):
    req = urllib.request.Request(base.rstrip("/") + "/chat/completions",
                                 data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    if key: req.add_header("Authorization", "Bearer " + key)
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.getcode(), json.loads(r.read().decode()), int((time.time()-t0)*1000)

def summarize(resp):
    ch = resp.get("choices", [{}])[0]
    msg = ch.get("message", {})
    usage = resp.get("usage") or {}
    return {
        "finish": ch.get("finish_reason"),
        "content": (msg.get("content") or "")[:80],
        "has_reasoning_content": "reasoning_content" in msg,
        "reasoning_len": len(msg.get("reasoning_content") or ""),
        "reasoning_tokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "thinking_echoed": msg.get("thinking") if isinstance(msg.get("thinking"), dict) else None,
        "other_msg_keys": [k for k in msg.keys() if k not in ("role","content","reasoning_content","thinking")],
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--key-env", default="")
    ap.add_argument("--key", default="")          # inline (dev only; prefer env)
    ap.add_argument("--max-tokens", type=int, default=300)
    a = ap.parse_args()
    key = a.key or os.environ.get(a.key_env, "") if a.key_env else a.key
    if not key and a.key_env: print(f"!! --key-env {a.key_env} not set; trying keyless")

    slug = a.model.replace("/", "_").replace(":", "-")
    outdir = HERE / "wire-captures" / slug
    outdir.mkdir(parents=True, exist_ok=True)
    log = []

    def run(tag, label, body):
        body = {"model": a.model, "messages": PROMPT, "max_tokens": a.max_tokens, **body}
        try:
            code, resp, ms = call(a.base, a.model, key, body)
            s = summarize(resp)
            log.append({"probe": tag, "label": label, "sent": body, "status": code, "ms": ms, "summary": s, "resp": resp})
            print(f"{tag}: {label:34} status={code} finish={s['finish']} reasoning_tok={s['reasoning_tokens']} content={s['content'][:30]!r}")
            return s
        except urllib.error.HTTPError as e:
            body_txt = e.read()[:300].decode("utf-8", "replace")
            log.append({"probe": tag, "label": label, "sent": body, "status": e.code, "err": body_txt})
            print(f"{tag}: {label:34} HTTP {e.code} — {body_txt[:120]}")
            if e.code in (401, 403):
                print("!! auth hard-block — aborting ladder (fix key first)")
                sys.exit(2)
            return None
        except Exception as e:
            log.append({"probe": tag, "label": label, "sent": body, "err": str(e)[:200]})
            print(f"{tag}: {label:34} ERR {str(e)[:120]}")
            return None

    print(f"probing {a.model} @ {a.base}\n")
    # P0 model list (catalog + slug confirmation)
    try:
        req = urllib.request.Request(a.base.rstrip("/") + "/models")
        if key: req.add_header("Authorization", "Bearer " + key)
        with urllib.request.urlopen(req, timeout=15) as r:
            ids = [m.get("id") for m in json.loads(r.read().decode()).get("data", [])]
        log.append({"probe": "P0", "models": ids})
        print(f"P0: models endpoint → {len(ids)} models; slug {'PRESENT' if a.model in ids else 'not listed (may still work)'}")
    except Exception as e:
        log.append({"probe": "P0", "err": str(e)[:200]})
        print("P0: models endpoint failed (non-fatal)")

    s1 = run("P1", "bare minimal", {})                                        # default behavior
    s2 = run("P2", "thinking enabled + effort low",   {"thinking": {"type": "enabled"}, "reasoning_effort": "low"})
    s3 = run("P3", "thinking enabled + effort high",  {"thinking": {"type": "enabled"}, "reasoning_effort": "high"})
    s4 = run("P4", "thinking enabled + effort max",   {"thinking": {"type": "enabled"}, "reasoning_effort": "max"})
    s5 = run("P5", "thinking enabled + effort medium",{"thinking": {"type": "enabled"}, "reasoning_effort": "medium"})
    s6 = run("P6", "thinking disabled (off-switch?)", {"thinking": {"type": "disabled"}})
    s7 = run("P7", "effort xhigh (xAI-style token)",  {"reasoning_effort": "xhigh"})

    (outdir / "capture.json").write_text(json.dumps(log, indent=2), encoding="utf-8")
    verdict = {
        "model": a.model, "base": a.base, "when": time.strftime("%Y-%m-%d %H:%M"),
        "thinks_by_default": bool(s1 and (s1["reasoning_tokens"] or 0) > 0 or s1["has_reasoning_content"]),
        "off_switch_works": bool(s6 and not (s6["reasoning_tokens"] or 0) and not s6["has_reasoning_content"]),
        "effort_tokens_accepted": [t for t, s in [("low",s2),("high",s3),("max",s4),("medium",s5),("xhigh",s7)] if s and s["status"] == 200],
        "capture": f"wire-captures/{slug}/capture.json",
    }
    (outdir / "verdict.json").write_text(json.dumps(verdict, indent=2), encoding="utf-8")
    print(f"\nverdict → {outdir/'verdict.json'}")
    print(json.dumps({k: v for k, v in verdict.items() if k != "capture"}, indent=2))
    print(f"""
next: write the route in tools/provider-maps.cjs using these facts.
laws: gap-fill only (never overwrite caller fields) · unknown token = leave default ·
never ship a map without this capture in the PR.""")

if __name__ == "__main__":
    main()
