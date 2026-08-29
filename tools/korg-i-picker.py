#!/usr/bin/env python3
"""Loopback-only model picker backed by one configured live hop."""
from __future__ import annotations
import argparse, json, os, re, secrets, stat, tempfile, urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MAX_POST=65536; HEALTH_TIMEOUT=20
MODEL_RE=re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
FALLBACK=["grok-4.5","grok-4.6"]
class DuplicateKeyError(ValueError): pass
class BindingLoadError(ValueError): pass
def unique_object(pairs):
    out={}
    for key,value in pairs:
        if key in out: raise DuplicateKeyError(f"duplicate JSON key: {key}")
        out[key]=value
    return out
class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*_args,**_kwargs): return None
NO_REDIRECT_OPENER=urllib.request.build_opener(RejectRedirects)
PAGE=r'''<!doctype html><html><head><meta charset=utf-8><meta name=referrer content=no-referrer><title>korg-i models</title><style>
:root{color-scheme:dark;--bg:#0a0a0c;--card:#131318;--fg:#e8e8ed;--mut:#858596;--acc:#806cff;--ok:#35ce80;--bad:#ff6279}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px system-ui;display:flex;justify-content:center;padding:36px 18px}.wrap{width:660px;max-width:100%}h1{text-align:center;font-size:23px}.sub,#msg{color:var(--mut);text-align:center}.bar{position:sticky;top:12px;display:flex;gap:12px;background:#0a0a0ddd;padding:12px 0}.bar span{flex:1}button,select{border:1px solid #2b2b35;border-radius:9px;padding:9px 12px;background:var(--card);color:var(--fg)}button{background:var(--acc);font-weight:650;cursor:pointer}.agent{display:grid;grid-template-columns:180px 1fr 62px;gap:10px;align-items:center;background:var(--card);padding:14px;margin:9px 0;border-radius:13px}.name{font-weight:650}.id{font-size:11px;color:var(--mut);overflow:hidden;text-overflow:ellipsis}.ok{color:var(--ok)!important}.bad{color:var(--bad)!important}</style></head><body><main class=wrap><h1>korg-i model picker</h1><p class=sub>Only models live on both authenticated lanes are offered.</p><div class=bar><span id=msg>loading</span><button id=save>Save</button></div><div id=list></div></main><script>
const csrf="__CSRF__",$=s=>document.querySelector(s);let state;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function request(path,options={}){options.headers={...(options.headers||{}),'X-CSRF-Token':csrf};let r=await fetch(path,options),j=await r.json();if(!r.ok)throw Error(j.error||`HTTP ${r.status}`);return j}
async function boot(){try{state=await request('/api/state');let models=state.models;$('#list').innerHTML=Object.entries(state.agents).map(([id,a])=>`<section class=agent data-id="${esc(id)}"><div><div class=name>${esc(a.name)}</div><div class=id>${esc(id)}</div></div><select>${models.map(m=>`<option value="${esc(m)}" ${m===a.modelId?'selected':''}>${esc(m)}</option>`).join('')}</select><button class=test>test</button></section>`).join('');document.querySelectorAll('.test').forEach(b=>b.onclick=()=>test(b));$('#msg').textContent=`${models.length} live models`;$('#msg').className='ok'}catch(e){$('#msg').textContent=e.message;$('#msg').className='bad'}}
async function test(b){try{let model=b.closest('.agent').querySelector('select').value;b.textContent='…';await request('/api/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model})});b.textContent='live';b.className='test ok'}catch(e){b.textContent='err';b.className='test bad'}}
$('#save').onclick=async()=>{try{let agents={};document.querySelectorAll('.agent').forEach(e=>agents[e.dataset.id]={modelId:e.querySelector('select').value});await request('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agents})});$('#msg').textContent='saved';$('#msg').className='ok'}catch(e){$('#msg').textContent=e.message;$('#msg').className='bad'}};boot();</script></body></html>'''

def _no_link(path:Path)->None:
    try: mode=path.lstat().st_mode
    except FileNotFoundError: return
    if stat.S_ISLNK(mode): raise ValueError(f"refusing symlink: {path}")
def secure_dir(path:Path)->None:
    if not path.is_absolute(): raise ValueError("bindings path must be absolute")
    current=Path(path.anchor)
    for part in path.parts[1:]:
        current/=part; _no_link(current)
        try: current.mkdir(mode=0o700)
        except FileExistsError: pass
        if not stat.S_ISDIR(current.lstat().st_mode): raise ValueError(f"not a directory: {current}")
    os.chmod(path,0o700,follow_symlinks=False)
def private_save(path:Path,value:Any)->None:
    path=path.expanduser(); secure_dir(path.parent); _no_link(path)
    fd,tmp=tempfile.mkstemp(prefix=f".{path.name}.",dir=path.parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,"w",encoding="utf-8") as f: fd=-1; json.dump(value,f,sort_keys=True,separators=(",",":")); f.write("\n"); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,path); os.chmod(path,0o600,follow_symlinks=False)
    finally:
        if fd>=0: os.close(fd)
        try: os.unlink(tmp)
        except FileNotFoundError: pass
def load_bindings(path:Path)->dict[str,Any]:
    _no_link(path)
    try:
        fd=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
        with os.fdopen(fd,encoding="utf-8") as f: raw=json.load(f,object_pairs_hook=unique_object)
    except FileNotFoundError: return {"version":1,"agents":{}}
    except (OSError,UnicodeError,json.JSONDecodeError,DuplicateKeyError) as e: raise BindingLoadError(f"invalid bindings file: {e}") from e
    if not isinstance(raw,dict) or not isinstance(raw.get("agents"),dict): raise BindingLoadError("invalid bindings document")
    agents={}
    for aid,value in raw["agents"].items():
        if not isinstance(aid,str) or not isinstance(value,dict) or not isinstance(value.get("name"),str) or not value["name"].strip() or not isinstance(value.get("modelId"),str) or not MODEL_RE.fullmatch(value["modelId"]): raise BindingLoadError("invalid binding entry")
        item={"name":value["name"].strip()[:128],"modelId":value["modelId"],"provider":"grok"}
        if isinstance(value.get("hopBaseUrl"),str) and re.fullmatch(r"http://127\.0\.0\.1:\d{1,5}(?:/session/[A-Za-z0-9_-]{32,128})?/v1",value["hopBaseUrl"]): item["hopBaseUrl"]=value["hopBaseUrl"]
        if isinstance(value.get("maxMode"),bool): item["maxMode"]=value["maxMode"]
        params=[{"id":p["id"],"value":p["value"]} for p in value.get("parameters",[]) if isinstance(p,dict) and set(p)=={"id","value"} and all(isinstance(p[k],str) and len(p[k])<=64 for k in p)] if isinstance(value.get("parameters",[]),list) else []
        if params: item["parameters"]=params
        agents[aid]=item
    return {"version":1,"agents":agents}
def normalize_hop(hop:str)->str:
    p=urllib.parse.urlsplit(hop); path=p.path.rstrip("/")
    if p.scheme!="http" or p.hostname!="127.0.0.1" or p.username or p.password or p.query or p.fragment or not p.port or path and not re.fullmatch(r"/session/[A-Za-z0-9_-]{32,128}",path): raise ValueError("hop must be an explicit loopback origin with an optional session capability")
    return f"http://127.0.0.1:{p.port}{path}"
def fetch_health(hop:str)->tuple[list[str],dict[str,Any]|None]:
    try:
        req=urllib.request.Request(hop+"/health",headers={"Accept":"application/json"})
        with NO_REDIRECT_OPENER.open(req,timeout=HEALTH_TIMEOUT) as r:
            if r.status!=200 or r.headers.get_content_type()!="application/json": return [],None
            data=json.loads(r.read(MAX_POST).decode(),object_pairs_hook=unique_object)
    except urllib.error.HTTPError as e: e.close(); return [],None
    except (OSError,urllib.error.URLError,TimeoutError,UnicodeError,json.JSONDecodeError,DuplicateKeyError): return [],None
    models=data.get("models") if isinstance(data,dict) else None; fallback=data.get("fallback") if isinstance(data,dict) else None
    if not isinstance(models,list) or not isinstance(fallback,dict) or fallback.get("enabled") is not True: return [],data if isinstance(data,dict) else None
    exact=sorted({m for m in models if isinstance(m,str) and MODEL_RE.fullmatch(m)})
    return exact,data

class PickerServer(ThreadingHTTPServer):
    daemon_threads=True; allow_reuse_address=False
    def __init__(self,address,bindings:Path,hop:str,require_live:bool):
        self.bindings=bindings; self.hop=normalize_hop(hop); self.require_live=require_live; self.csrf=secrets.token_urlsafe(32)
        super().__init__(address,PickerHandler)
    def live_models(self): return fetch_health(self.hop)
class PickerHandler(BaseHTTPRequestHandler):
    server:PickerServer
    def log_message(self,*_): pass
    def expected(self): return f"{self.server.server_address[0]}:{self.server.server_address[1]}"
    def guard(self,post=False):
        host=self.expected(); origin=self.headers.get("Origin"); ok=self.headers.get("Host")==host
        ok=ok and (origin=="http://"+host if post else origin in {None,"http://"+host})
        if post: ok=ok and secrets.compare_digest(self.headers.get("X-CSRF-Token",""),self.server.csrf)
        if not ok: self.reply(403,{"error":"request rejected"})
        return ok
    def reply(self,status,value):
        body=json.dumps(value,separators=(",",":")).encode(); self.send_response(status); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(body))); self.send_header("Cache-Control","no-store"); self.send_header("X-Content-Type-Options","nosniff"); self.end_headers(); self.wfile.write(body)
    def body(self):
        if self.headers.get("Content-Type","").split(";",1)[0].strip().lower()!="application/json" or self.headers.get("Transfer-Encoding"): raise ValueError("JSON required")
        try: n=int(self.headers.get("Content-Length",""))
        except ValueError: n=-1
        if n<2 or n>MAX_POST: raise ValueError("invalid body length")
        value=json.loads(self.rfile.read(n).decode(),object_pairs_hook=unique_object)
        if not isinstance(value,dict): raise ValueError("object required")
        return value
    def do_GET(self):
        if not self.guard(): return
        if self.path=="/":
            body=PAGE.replace("__CSRF__",self.server.csrf).encode(); self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8"); self.send_header("Content-Length",str(len(body))); self.send_header("Cache-Control","no-store"); self.send_header("Content-Security-Policy","default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"); self.end_headers(); self.wfile.write(body); return
        if self.path=="/api/state":
            models,health=self.server.live_models()
            if self.server.require_live and not models: self.reply(503,{"error":"configured hop has no live shared models"}); return
            if not models: models=FALLBACK[:]
            try: bindings=load_bindings(self.server.bindings)
            except BindingLoadError as e: self.reply(409,{"error":str(e)}); return
            self.reply(200,{"agents":bindings["agents"],"models":models,"live":bool(health)}); return
        self.reply(404,{"error":"not found"})
    def do_POST(self):
        if not self.guard(True): return
        try: req=self.body()
        except (ValueError,UnicodeError,json.JSONDecodeError): self.reply(400,{"error":"invalid JSON request"}); return
        models,_=self.server.live_models()
        if not models: self.reply(503,{"error":"configured hop unavailable"}); return
        if self.path=="/api/test":
            if set(req)!={"model"} or req.get("model") not in models: self.reply(400,{"error":"live model required"}); return
            body=json.dumps({"model":req["model"],"messages":[{"role":"user","content":"Reply with OK only."}],"max_tokens":8}).encode(); request=urllib.request.Request(self.server.hop+"/v1/chat/completions",data=body,method="POST",headers={"Content-Type":"application/json"})
            try:
                with NO_REDIRECT_OPENER.open(request,timeout=25) as r: ok=r.status==200; r.read(256)
            except urllib.error.HTTPError as e: e.close(); ok=False
            except (OSError,urllib.error.URLError,TimeoutError): ok=False
            self.reply(200 if ok else 502,{"ok":ok}); return
        if self.path=="/api/save":
            if set(req)!={"agents"} or not isinstance(req["agents"],dict): self.reply(400,{"error":"agents required"}); return
            try: current=load_bindings(self.server.bindings)
            except BindingLoadError as e: self.reply(409,{"error":str(e)}); return
            existing=current["agents"]
            if set(req["agents"])!=set(existing): self.reply(400,{"error":"bind set owns agent creation"}); return
            for aid,update in req["agents"].items():
                if not isinstance(update,dict) or set(update)!={"modelId"} or update["modelId"] not in models: self.reply(400,{"error":"noncanonical binding"}); return
                existing[aid]["modelId"]=update["modelId"]; existing[aid]["provider"]="grok"
            private_save(self.server.bindings,{"version":1,"agents":{k:existing[k] for k in sorted(existing)}}); self.reply(200,{"ok":True}); return
        self.reply(404,{"error":"not found"})

def make_server(bindings:Path,hop:str,host:str="127.0.0.1",port:int=8766,require_live:bool=False)->PickerServer:
    if host!="127.0.0.1": raise ValueError("picker is loopback-only")
    return PickerServer((host,port),Path(bindings),hop,require_live)
def run_server(bindings:Path,hop:str,host:str="127.0.0.1",port:int=8766,require_live:bool=False)->None:
    server=make_server(bindings,hop,host,port,require_live); print(f"korg-i picker listening on http://{host}:{server.server_address[1]}",flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
def main(argv=None):
    p=argparse.ArgumentParser(); p.add_argument("--port",type=int,default=8766); p.add_argument("--bindings",type=Path,required=True); p.add_argument("--hop",required=True); p.add_argument("--require-live",action="store_true"); a=p.parse_args(argv); run_server(a.bindings,a.hop,port=a.port,require_live=a.require_live)
if __name__=="__main__": main()
