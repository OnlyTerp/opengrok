#!/usr/bin/env python3
"""model-picker v2 — one clean box. Pick a model per agent, done.

  python model_picker.py [--port 8766] [--bindings FILE] [--hop URL]

    --hop   live Grok-hop /health URL (auto-populates model dropdowns from
            the REAL route table; falls back to bundled catalog offline)

Security: keys NEVER enter bindings; Test button probes from THIS machine only.
"""
import argparse, json, os, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

# Offline fallback catalog (live-verified wire facts baked in)
FALLBACK = {
  "grok-4.6": {"prov":"grok"}, "grok-4.6-superheavy": {"prov":"grok"},
  "claude-opus-5": {"prov":"anthropic"}, "claude-opus-5-oauth-1": {"prov":"anthropic"},
  "claude-opus-5-oauth-3": {"prov":"anthropic"}, "claude-fable-5-oauth-1": {"prov":"anthropic"},
  "claude-fable-5-oauth-3": {"prov":"anthropic"},
  "gemini-3.7-flash": {"prov":"gemini"}, "gemini-3.7-flash-high": {"prov":"gemini"},
  "glm-5.3": {"prov":"glm"}, "glm-5.3-flash": {"prov":"glm"},
  "deepseek/deepseek-v4-pro-0813": {"prov":"nanogpt"},
  "deepseek/deepseek-v4-pro-0813:thinking": {"prov":"nanogpt"},
  "qwen3.8-max": {"prov":"qwen"}, "local-qwen38-27b": {"prov":"local"},
  "local-qwen38-27b-aipc": {"prov":"local"}, "mimo-v2.5-pro-ultraspeed": {"prov":"custom"},
  "local-ornith-35b": {"prov":"local"},
  "gpt-5.6-sol": {"prov":"codex-everywhere"}, "gpt-5.6-terra": {"prov":"codex-everywhere"},
  "gpt-5.6-luna": {"prov":"codex-everywhere"}, "gpt-5.5": {"prov":"codex-everywhere"},
}
PROV_LABEL = {"grok":"xAI","anthropic":"Claude","gemini":"Gemini","glm":"GLM",
              "nanogpt":"DeepSeek","qwen":"Qwen","local":"Local","custom":"Custom",
              "openai":"OpenAI","openrouter":"OpenRouter","ollama":"Ollama",
              "codex-everywhere":"Codex Everywhere"}

AI_PROMPT = """Configure Grok Bot model bindings. Return ONLY JSON: {"agents":{"<id>":{"name":str,"modelId":str,"provider":str,"hopBaseUrl":str,"parameters":[{"id":"effort","value":"low|medium|high|max"}],"maxMode":bool}}}
Laws: no API keys ever | unknown wire behavior => omit parameters, never guess | xAI effort=xhigh-not-max | GLM effort=max-literal+thinks-by-default | deepseek-slug-owns-thinking
Agents: <PASTE FROM PICKER> · Wanted: <PLAIN ENGLISH>"""

def load(p, d):
    try: return json.load(open(p, encoding="utf-8"))
    except Exception: return d

def save(p, o):
    t = p + ".tmp"
    with open(t, "w", encoding="utf-8") as f: json.dump(o, f, indent=2); f.write("\n")
    os.replace(t, p)

def fetch_models(hop):
    """Pull the LIVE route table: [(modelName, routeName), ...] + health blob.
    Direct when reachable; falls back to box file-relay push (VNC pod is
    localhost-only for :18786, but its file relay CAN curl localhost)."""
    def direct():
        with urllib.request.urlopen(hop.rstrip("/") + "/health", timeout=6) as r:
            return json.loads(r.read().decode())
    try:
        h = direct()
    except Exception:
        h = None
    if h is None:
        seeded = os.path.join(HERE, "hop-health-snapshot.json")
        try: h = json.load(open(seeded, encoding="utf-8"))
        except Exception: return [{"model": k, "route": "catalog"} for k in FALLBACK], None
    models = []
    def scan(obj, route_hint=None):
        if isinstance(obj, dict):
            if "models" in obj and isinstance(obj["models"], list):
                for m in obj["models"]:
                    if isinstance(m, str) and m not in [x["model"] for x in models]:
                        models.append({"model": m, "route": route_hint or obj.get("note","")[:24] or "?"})
            for k, v in obj.items(): scan(v, route_hint or (k if isinstance(v, dict) and "models" in v else None))
        elif isinstance(obj, list):
            for v in obj: scan(v, route_hint)
    scan(h)
    return models, h

PAGE = r"""<!doctype html><html><head><meta charset=utf-8><title>models</title><style>
:root{--bg:#0a0a0c;--fg:#e6e6ea;--mut:#777788;--acc:#7c6cff;--acc2:#9d8fff;--ok:#2ecc71;--bad:#ff5c74;--bd:#1e1e26;--card:#131318}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 500px at 50% -10%,#1a1430 0%,var(--bg) 60%);color:var(--fg);font:15px/1.5 -apple-system,'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;justify-content:center;padding:34px 18px}
.wrap{width:620px;max-width:100%}
h1{font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0 0 2px;text-align:center}
h1 .gem{background:linear-gradient(90deg,var(--acc2),#e07cff);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--mut);font-size:13.5px;text-align:center;margin-bottom:26px}
.bar{display:flex;gap:10px;align-items:center;margin-bottom:16px;position:sticky;top:14px;z-index:9}
.bar .cardb{flex:1;background:rgba(19,19,24,.85);backdrop-filter:blur(12px);border:1px solid var(--bd);border-radius:12px;padding:10px 14px;display:flex;gap:10px;align-items:center}
#msg{font-size:13px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ok{color:var(--ok)}.bad{color:var(--bad)}
button{background:linear-gradient(135deg,var(--acc),#6a5be0);border:0;color:#fff;font-weight:600;border-radius:9px;padding:8px 16px;cursor:pointer;font-size:13.5px;transition:transform .06s,filter .15s}
button:hover{filter:brightness(1.15)}button:active{transform:scale(.97)}
button.ghost{background:transparent;border:1px solid var(--bd);color:var(--mut);font-weight:500}
button.ghost:hover{color:var(--fg);border-color:var(--acc)}
.agent{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:13px 15px;margin-bottom:9px;display:flex;align-items:center;gap:12px;transition:border-color .15s}
.agent:hover{border-color:#2e2e3c}
.who{width:150px;min-width:150px}
.who .nm{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who .rt{font-size:11px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pick{flex:1;display:flex;gap:8px;align-items:center}
select.model{flex:1;-webkit-appearance:none;appearance:none;background:#0a0a0e url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23776788' fill='none' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 12px center;border:1px solid var(--bd);border-radius:9px;color:var(--fg);padding:9px 30px 9px 12px;font-size:13.5px;cursor:pointer;outline:0;transition:border-color .15s}
select.model:hover{border-color:var(--acc)}select.model:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(124,108,255,.15)}
.pill{font-size:10.5px;padding:3px 8px;border-radius:99px;background:#0a0a0e;border:1px solid var(--bd);color:var(--mut);white-space:nowrap}
.pill.r{color:var(--acc2);border-color:#2e2650}
.dot{width:7px;height:7px;border-radius:50%;background:var(--mut);display:inline-block;margin-right:5px}
.dot.live{background:var(--ok)}.dot.err{background:var(--bad)}
.tbtn{font-size:11px;padding:5px 10px;border-radius:7px;background:transparent;border:1px solid var(--bd);color:var(--mut);cursor:pointer;font-weight:500}
.tbtn:hover{border-color:var(--acc);color:var(--fg)}
.foot{text-align:center;color:var(--mut);font-size:12px;margin-top:20px}
.foot a{color:var(--acc2);cursor:pointer}
dialog{background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:16px;padding:22px;max-width:540px;width:92%}
dialog::backdrop{background:#000b;backdrop-filter:blur(4px)}
textarea{width:100%;height:200px;background:#0a0a0e;color:var(--fg);border:1px solid var(--bd);border-radius:10px;font:12px ui-monospace,monospace;padding:10px}
</style></head><body><div class=wrap>
<h1>model <span class=gem>picker</span></h1>
<div class=sub>one model per agent — pick, test, save. keys stay on your machine.</div>
<div class=bar><div class=cardb><span id=msg>loading…</span></div><button onclick=save()>Save</button></div>
<div id=list></div>
<div class=foot><a onclick=aiprompt()>let an AI do it</a> · <a onclick="location.reload()">refresh live models</a> · <span id=hopinfo></span></div>
</div>
<dialog id=dlg><h3 style='margin:0 0 10px'>Give this to any AI</h3><p style='color:var(--mut);font-size:13px;margin:0 0 10px'>Paste its JSON answer back into the picker (or send it to your agent to apply).</p><textarea id=dta readonly></textarea><div style='text-align:right;margin-top:12px'><button class=ghost onclick=dlg.close()>close</button> <button id=dcp>copy</button></div></dialog>
<script>
let ST,MODELS=[];
const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function show(t,c){const m=$("#msg");m.textContent=t;m.className=c||""}
function provOf(m){
  const route=(MODELS.find(x=>x.model===m)||{}).route||"?";
  return route==="?" && /^gpt-5(?:\.\d+)?/.test(m) ? "Codex Everywhere" : route;
}
async function boot(){
  const r=await(await fetch('/api/state')).json();ST=r;MODELS=r.models;
  $("#hopinfo").textContent=r.live?`${MODELS.length} models · live hop`:`${MODELS.length} models · catalog`;
  const L=$("#list");
  L.innerHTML=Object.entries(r.agents).map(([id,a])=>{
    const cur=a.modelId||"";
    const hop=a.hopBaseUrl?(a.hopBaseUrl.match(/:(\d+)/)||[])[1]:null;
    const lane=hop?`hop :${hop}`:"direct";
    const extra=MODELS.some(m=>m.model===cur)?"":(cur?[{model:cur,route:"saved"}]:[]);
    const opts=[...MODELS,...extra].map(m=>`<option value="${esc(m.model)}" ${m.model===cur?'selected':''} data-r="${esc(m.route)}">${esc(m.model)}</option>`).join("");
    return `<div class=agent data-id="${esc(id)}">
      <div class=who><div class=nm>${esc(a.name||"(unnamed)")}</div><div class=rt>${esc(lane)}</div><div class=rt title="Agent ID">id ${esc(id)}</div></div>
      <div class=pick><select class=model>${opts}</select><span class="pill r" data-pill>${esc(provOf(cur))}</span></div>
      <button class=tbtn data-test>test</button>
    </div>`}).join("");
  $$("select.model").forEach(s=>s.onchange=()=>{const p=s.closest(".agent").querySelector("[data-pill]");p.textContent=provOf(s.value)});
  $$("[data-test]").forEach(b=>b.onclick=()=>test(b));
  show(r.live?"live models loaded":"using catalog (hop offline)", r.live?"ok":"");
}
async function test(btn){
  const ag=btn.closest(".agent"),sel=ag.querySelector("select.model");
  btn.textContent="…";
  const r=await(await fetch("/api/test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:sel.value,baseUrl:ST.hop})})).json();
  btn.textContent=r.ok?"live":"err";btn.style.color=r.ok?"var(--ok)":"var(--bad)";
  setTimeout(()=>{btn.textContent="test";btn.style.color=""},2500);
}
async function save(){
  show("saving…");
  const agents={};
  $$(".agent").forEach(el=>{
    const id=el.dataset.id,base=ST.agents[id]||{};
    agents[id]={...base, modelId:el.querySelector("select.model").value};
  });
  const r=await(await fetch("/api/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agents})})).json();
  if(r.ok)show(r.pushed?"saved + pushed to box ✓":"saved locally ✓ (relay off)","ok");
  else show("save failed: "+(r.err||"?"),"bad");
}
async function aiprompt(){
  const txt=await(await fetch("/api/aiprompt")).text();
  $("#dta").value=txt.replace("<PASTE FROM PICKER>",Object.entries(ST.agents).map(([k,v])=>`${k} (${v.name})`).join(", "));
  $("#dcp").onclick=()=>{navigator.clipboard.writeText($("#dta").value);$("#dcp").textContent="copied ✓"};
  $("#dlg").showModal();
}
boot();
</script></body></html>"""

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def _origin_ok(self):
        origin = self.headers.get("Origin")
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            return False
        if origin:
            oh = urllib.parse.urlparse(origin).hostname
            return oh in ("127.0.0.1", "localhost")
        return True
    def do_GET(self):
        if not self._origin_ok(): return self._j(403, {"err":"forbidden origin"})
        if self.path == "/":
            b = PAGE.encode(); self.send_response(200)
            self.send_header("Content-Type","text/html"); self.send_header("Content-Length",str(len(b)))
            self.end_headers(); self.wfile.write(b)
        elif self.path == "/api/state":
            models, health = fetch_models(HOP)
            ags = load(BINDINGS, {"agents":{}}).get("agents", {})
            self._j(200, {"agents":ags, "models":models, "live":bool(health), "hop":HOP})
        elif self.path == "/api/aiprompt":
            b = AI_PROMPT.encode(); self.send_response(200)
            self.send_header("Content-Type","text/plain"); self.send_header("Content-Length",str(len(b)))
            self.end_headers(); self.wfile.write(b)
        else: self._j(404, {"err":"nf"})
    def do_POST(self):
        if not self._origin_ok(): return self._j(403, {"err":"forbidden origin"})
        n = int(self.headers.get("Content-Length") or 0)
        try: req = json.loads(self.rfile.read(n))
        except Exception: return self._j(400, {"err":"bad json"})
        if self.path == "/api/save":
            ags = req.get("agents")
            if not isinstance(ags, dict): return self._j(400, {"err":"agents required"})
            cur = load(BINDINGS, {"agents":{}})
            merged = dict(cur.get("agents", {}))
            for k, v in ags.items():
                if isinstance(v, dict) and v.get("modelId"):
                    merged.setdefault(k, {})
                    merged[k]["modelId"] = v["modelId"]
                    for f in ("name","provider","hopBaseUrl","parameters","maxMode"):
                        if f in v: merged[k][f] = v[f]
            save(BINDINGS, {**cur, "_comment":"model-picker v2 "+time.strftime("%Y-%m-%d %H:%M"), "agents":merged})
            pushed, perr = False, None
            if RELAY:
                try:
                    rq = urllib.request.Request(RELAY.rstrip("/")+"/push/model-bindings.json",
                                                data=open(BINDINGS,"rb").read(), method="POST")
                    with urllib.request.urlopen(rq, timeout=20) as resp: pushed = resp.status==200
                except Exception as e: perr = str(e)[:100]
            return self._j(200, {"ok":True, "pushed":pushed, "push_err":perr})
        if self.path == "/api/test":
            base = (req.get("baseUrl") or "").rstrip("/")
            model = req.get("model") or ""
            if not base.startswith("http"): return self._j(400, {"err":"bad base"})
            body = json.dumps({"modelId":model,"messages":[{"role":"user","content":"ping"}],"max_tokens":8}).encode()
            rq = urllib.request.Request(base+"/v1/chat/completions", data=body, method="POST")
            rq.add_header("Content-Type","application/json")
            try:
                with urllib.request.urlopen(rq, timeout=25) as resp:
                    ok = resp.status == 200
                    snippet = resp.read(200).decode("utf-8","replace")
                return self._j(200, {"ok":ok, "snippet":snippet[:120]})
            except Exception as e:
                return self._j(200, {"ok":False, "err":str(e)[:120]})
        return self._j(404, {"err":"nf"})

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--bindings", default=os.path.join(HERE, "picker-bindings.json"))
    ap.add_argument("--relay", default=os.environ.get("BOX_RELAY_URL",""))
    ap.add_argument("--hop", default=os.environ.get("BOX_HOP_URL",""))  # optional: BOX_HOP_URL=http://<your-box>:18786 feeds live-route dropdowns)
    a = ap.parse_args()
    BINDINGS, RELAY, HOP = os.path.abspath(a.bindings), a.relay.strip(), a.hop.strip()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    print(f"model-picker v2 → http://127.0.0.1:{a.port}  (hop={HOP})")
    srv.serve_forever()
