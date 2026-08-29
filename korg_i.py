#!/usr/bin/env python3
"""OAuth-first local xAI bridge and model binding configurator."""
from __future__ import annotations
import argparse, dataclasses, datetime as dt, functools, hashlib, hmac, http.server, importlib.util
import json, os, re, secrets, shutil, stat, subprocess, sys, tempfile, threading
import urllib.error, urllib.request
from pathlib import Path
from typing import Any, Callable, Mapping

APP="korg-i"; HOST="127.0.0.1"; BRIDGE_PORT=18787; PICKER_PORT=8766
OAUTH_UPSTREAM="https://cli-chat-proxy.grok.com/v1"; API_UPSTREAM="https://api.x.ai/v1"
MAX_REQUEST=1<<20; MAX_RESPONSE=8<<20; DEFAULT_MODEL="grok-4.6"
MODEL_RE=re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
AGENT_RE=re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{1,127}$")
VERSION_RE=re.compile(r"(?<!\d)(\d+\.\d+\.\d+)(?!\d)")
QUOTA_CODES={"billing_hard_limit_reached","insufficient_quota","quota_exceeded","quota_exhausted","usage_limit_reached"}

class KorgError(RuntimeError): pass
class NetworkFailure(KorgError): pass
class DuplicateKeyError(ValueError): pass

def strict_json_loads(value:str)->Any:
    def unique(pairs):
        out={}
        for key,item in pairs:
            if key in out: raise DuplicateKeyError(f"duplicate JSON key: {key}")
            out[key]=item
        return out
    return json.loads(value,object_pairs_hook=unique)

@dataclasses.dataclass(frozen=True)
class Paths:
    config:Path; state:Path; cache:Path; bindings:Path; proof:Path; auth:Path; grok_config:Path; key_ref:Path

def ensure_private_dir(path:Path)->None:
    path=path.expanduser()
    if not path.is_absolute(): raise KorgError(f"private path must be absolute: {path}")
    cur=Path(path.anchor)
    for part in path.parts[1:]:
        cur/=part
        try: mode=cur.lstat().st_mode
        except FileNotFoundError: cur.mkdir(mode=0o700); mode=cur.lstat().st_mode
        if stat.S_ISLNK(mode): raise KorgError(f"refusing symlink: {cur}")
        if not stat.S_ISDIR(mode): raise KorgError(f"not a directory: {cur}")
    os.chmod(path,0o700,follow_symlinks=False)

def app_paths(create:bool=True)->Paths:
    home=Path.home(); x=lambda key,default: Path(os.environ.get(key) or home/default).expanduser()/APP
    c,s,k=x("XDG_CONFIG_HOME",".config"),x("XDG_STATE_HOME",".local/state"),x("XDG_CACHE_HOME",".cache")
    if create:
        for p in (c,s,k): ensure_private_dir(p)
    return Paths(c,s,k,c/"bindings.json",s/"model-proof.json",home/".grok/auth.json",home/".grok/config.toml",c/"api-key-ref")

def _no_link(path:Path)->None:
    try: mode=path.lstat().st_mode
    except FileNotFoundError: return
    if stat.S_ISLNK(mode): raise KorgError(f"refusing symlink: {path}")

def secure_read(path:Path,limit:int=MAX_RESPONSE)->bytes:
    _no_link(path); fd=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size>limit: raise KorgError(f"unsafe file: {path}")
        data=b""
        while len(data)<=limit:
            chunk=os.read(fd,min(65536,limit+1-len(data)))
            if not chunk: break
            data+=chunk
        if len(data)>limit: raise KorgError(f"file too large: {path}")
        return data
    finally: os.close(fd)

def atomic_private_write(path:Path,data:bytes)->None:
    ensure_private_dir(path.parent); _no_link(path); fd,tmp=tempfile.mkstemp(prefix=f".{path.name}.",dir=path.parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,"wb") as f: fd=-1; f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,path); os.chmod(path,0o600,follow_symlinks=False)
        dfd=os.open(path.parent,os.O_RDONLY|getattr(os,"O_DIRECTORY",0))
        try: os.fsync(dfd)
        finally: os.close(dfd)
    finally:
        if fd>=0: os.close(fd)
        try: os.unlink(tmp)
        except FileNotFoundError: pass

def read_json(path:Path,default:Any)->Any:
    try: return strict_json_loads(secure_read(path).decode())
    except (FileNotFoundError,UnicodeError,json.JSONDecodeError,DuplicateKeyError): return default

def write_json(path:Path,value:Any)->None:
    atomic_private_write(path,json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()+b"\n")
def valid_model(x:Any)->bool: return isinstance(x,str) and MODEL_RE.fullmatch(x) is not None
def valid_agent(x:Any)->bool: return isinstance(x,str) and AGENT_RE.fullmatch(x) is not None and x.lower() not in {"real","example","placeholder","agent-id"}

def canonical_bindings(raw:Any)->dict[str,Any]:
    out={}; source=raw.get("agents",{}) if isinstance(raw,dict) else {}
    if not isinstance(source,dict): source={}
    for aid in sorted(source):
        v=source[aid]
        if not valid_agent(aid) or not isinstance(v,dict) or not isinstance(v.get("name"),str) or not v["name"].strip() or len(v["name"])>128 or not valid_model(v.get("modelId")): continue
        item={"name":v["name"].strip(),"modelId":v["modelId"],"provider":"grok"}; base=v.get("hopBaseUrl")
        if isinstance(base,str) and re.fullmatch(r"http://127\.0\.0\.1:\d{1,5}(?:/session/[A-Za-z0-9_-]{32,128})?/v1",base): item["hopBaseUrl"]=base
        if isinstance(v.get("maxMode"),bool): item["maxMode"]=v["maxMode"]
        params=[]
        for p in v.get("parameters",[]) if isinstance(v.get("parameters",[]),list) else []:
            if isinstance(p,dict) and set(p)=={"id","value"} and all(isinstance(p[k],str) and len(p[k])<=64 for k in p): params.append({"id":p["id"],"value":p["value"]})
        if params: item["parameters"]=params
        out[aid]=item
    return {"version":1,"agents":out}

def load_bindings(paths:Paths|None=None)->dict[str,Any]:
    p=paths or app_paths()
    try: raw=strict_json_loads(secure_read(p.bindings).decode())
    except FileNotFoundError: raw={"agents":{}}
    except (UnicodeError,json.JSONDecodeError,DuplicateKeyError) as e: raise KorgError(f"invalid bindings JSON: {e}") from e
    if not isinstance(raw,dict) or not isinstance(raw.get("agents"),dict): raise KorgError("invalid bindings document")
    clean=canonical_bindings(raw)
    if set(clean["agents"])!=set(raw["agents"]): raise KorgError("invalid binding entry")
    return clean
def save_bindings(value:Any,paths:Paths|None=None)->dict[str,Any]:
    p=paths or app_paths(); clean=canonical_bindings(value); write_json(p.bindings,clean); return clean

def bind_set(aid:str,name:str,model:str,port:int=BRIDGE_PORT)->dict[str,Any]:
    if not valid_agent(aid): raise KorgError("agent id is not a real stable identifier")
    if not name.strip() or len(name)>128: raise KorgError("name must be 1..128 characters")
    if not valid_model(model): raise KorgError("invalid model identifier")
    p=app_paths(); data=load_bindings(p); data["agents"][aid]={"name":name.strip(),"modelId":model,"provider":"grok","hopBaseUrl":f"http://{HOST}:{port}/v1"}; return save_bindings(data,p)

def configured_models(paths:Paths)->set[str]:
    models={DEFAULT_MODEL}|{v["modelId"] for v in load_bindings(paths)["agents"].values()}
    try: text=secure_read(paths.grok_config,1<<20).decode()
    except (FileNotFoundError,UnicodeError,KorgError): return models
    for pat in (r'(?m)^\s*(?:default|fork_secondary_model)\s*=\s*"([^"]+)"\s*$',r"(?m)^\s*\[model\.([^\]]+)\]\s*$"):
        for m in re.finditer(pat,text):
            if valid_model(m.group(1)): models.add(m.group(1))
    return models

def oauth_record(paths:Paths)->tuple[str|None,dict[str,Any]|None]:
    raw=read_json(paths.auth,{}); found=[]
    if isinstance(raw,dict):
        for account,record in raw.items():
            if isinstance(account,str) and account.startswith("https://auth.x.ai::") and isinstance(record,dict):
                key=record.get("key")
                if isinstance(key,str) and len(key.strip())>20 and record.get("oidc_issuer")=="https://auth.x.ai" and record.get("auth_mode") in {"oidc","oauth","browser","device"}: found.append((key.strip(),record))
    return found[0] if len(found)==1 else (None,None)
def expired(record:Mapping[str,Any]|None)->bool|None:
    if not record or not isinstance(record.get("expires_at"),str): return None
    try:
        when=dt.datetime.fromisoformat(record["expires_at"].replace("Z","+00:00")); when=when.replace(tzinfo=when.tzinfo or dt.timezone.utc)
        return when<=dt.datetime.now(dt.timezone.utc)
    except ValueError: return None

def op_reference(paths:Paths)->str|None:
    value=os.environ.get("KORG_I_XAI_API_KEY_REF","").strip()
    if not value:
        try: value=secure_read(paths.key_ref,4096).decode().strip()
        except (FileNotFoundError,UnicodeError,KorgError): return None
    return value if value.startswith("op://") and "\0" not in value and "\n" not in value and len(value)<=4096 else None

def minimal_env(op:bool=False)->dict[str,str]:
    allow={"HOME","PATH","USER","LOGNAME","SHELL","LANG","TMPDIR","XDG_CONFIG_HOME","XDG_CACHE_HOME"}
    return {k:v for k,v in os.environ.items() if k in allow or k.startswith("LC_") or (op and k.startswith("OP_"))}
def scrubbed_pack_env(extra:Mapping[str,str]|None=None)->dict[str,str]:
    allow={"COLORTERM","DBUS_SESSION_BUS_ADDRESS","DISPLAY","HOME","LANG","LOGNAME","PATH","PWD","SHELL","SSH_AUTH_SOCK","TERM","TMPDIR","USER","WAYLAND_DISPLAY","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_DATA_DIRS","XDG_DATA_HOME","XDG_RUNTIME_DIR","XDG_SESSION_TYPE","XDG_STATE_HOME"}
    env={k:v for k,v in os.environ.items() if k in allow or k.startswith("LC_")}; env["KORG_I_CONFIGURING"]="1"; env.update(extra or {}); return env

@functools.lru_cache(maxsize=1)
def grok_client_version()->str:
    v=os.environ.get("KORG_I_GROK_CLIENT_VERSION","")
    if VERSION_RE.fullmatch(v): return v
    if exe:=shutil.which("grok"):
        try:
            r=subprocess.run([exe,"--version"],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=5,check=False,env=minimal_env()); m=VERSION_RE.search(r.stdout)
            if r.returncode==0 and m: return m.group(1)
        except (OSError,subprocess.TimeoutExpired): pass
    return "1.0.6"

@dataclasses.dataclass(frozen=True)
class UpstreamResponse: status:int; body:bytes; content_type:str="application/json"
class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*_args,**_kwargs): return None
NO_REDIRECT_OPENER=urllib.request.build_opener(RejectRedirects)
def default_transport(method:str,path:str,body:bytes|None,token:str,lane:str)->UpstreamResponse:
    if path not in {"/models","/chat/completions","/responses"}: raise KorgError("upstream path rejected")
    base=OAUTH_UPSTREAM if lane=="oauth" else API_UPSTREAM if lane=="api" else None
    if base is None: raise KorgError("upstream lane rejected")
    req=urllib.request.Request(base+path,data=body,method=method); req.add_header("Accept","application/json"); req.add_header("Authorization",f"Bearer {token}")
    if lane=="oauth":
        version=grok_client_version(); req.add_header("User-Agent",f"grok/{version}"); req.add_header("x-grok-client-version",version); req.add_header("x-grok-client-identifier","grok-cli"); req.add_header("X-XAI-Token-Auth","xai-grok-cli")
        if body:
            try: model=strict_json_loads(body.decode()).get("model")
            except (UnicodeError,json.JSONDecodeError,DuplicateKeyError,AttributeError): model=None
            if valid_model(model): req.add_header("x-grok-model-override",model)
    if body is not None: req.add_header("Content-Type","application/json")
    try:
        with NO_REDIRECT_OPENER.open(req,timeout=45) as response:
            data=response.read(MAX_RESPONSE+1)
            if len(data)>MAX_RESPONSE: raise NetworkFailure("upstream response too large")
            return UpstreamResponse(response.status,data,response.headers.get_content_type())
    except urllib.error.HTTPError as e:
        with e:
            data=e.read(MAX_RESPONSE+1); return UpstreamResponse(e.code,data[:MAX_RESPONSE],e.headers.get_content_type() if e.headers else "application/json")
    except (urllib.error.URLError,TimeoutError,OSError) as e: raise NetworkFailure(type(e).__name__) from e

def fallback_allowed(r:UpstreamResponse)->bool:
    if r.status in (401,403): return True
    if r.status!=429 or r.content_type.lower().split(";",1)[0].strip() not in {"application/json","application/problem+json"}: return False
    try: payload=strict_json_loads(r.body.decode())
    except (UnicodeError,json.JSONDecodeError,DuplicateKeyError): return False
    error=payload.get("error") if isinstance(payload,dict) else None
    return isinstance(error,dict) and bool({str(error.get(k,"")).strip().lower() for k in ("code","type","reason")}&QUOTA_CODES)
def response_models(r:UpstreamResponse)->set[str]:
    if r.status!=200: return set()
    try: rows=strict_json_loads(r.body.decode()).get("data")
    except (UnicodeError,json.JSONDecodeError,DuplicateKeyError,AttributeError): return set()
    return {x["id"] for x in rows if isinstance(x,dict) and valid_model(x.get("id"))} if isinstance(rows,list) else set()
def probe_succeeded(r:UpstreamResponse)->bool:
    if r.status!=200: return False
    try: payload=strict_json_loads(r.body.decode()); content=payload["choices"][0]["message"]["content"]
    except (UnicodeError,json.JSONDecodeError,DuplicateKeyError,KeyError,IndexError,TypeError): return False
    return isinstance(content,str) and content.strip()=="KORG_I_PROBE"

class Bridge:
    def __init__(self,paths:Paths|None=None,transport:Callable[...,UpstreamResponse]=default_transport):
        self.paths=paths or app_paths(); self.transport=transport; self.lock=threading.Lock(); self.live_models:set[str]=set()
        self.credential_proof:tuple[bytes,bytes,bytes]|None=None; self.capability=secrets.token_urlsafe(32)
    def oauth(self): return oauth_record(self.paths)
    def api_source(self):
        return "KORG_I_XAI_API_KEY" if len(os.environ.get("KORG_I_XAI_API_KEY","").strip())>20 else "XAI_API_KEY" if len(os.environ.get("XAI_API_KEY","").strip())>20 else "1password" if op_reference(self.paths) else None
    def api_identity(self)->bytes|None:
        for name in ("KORG_I_XAI_API_KEY","XAI_API_KEY"):
            if len(value:=os.environ.get(name,"").strip())>20: return self.fingerprint(name+"\0"+value)
        ref=op_reference(self.paths)
        return self.fingerprint("1password\0"+ref) if ref and shutil.which("op") else None
    def api_secret(self):
        for name in ("KORG_I_XAI_API_KEY","XAI_API_KEY"):
            if (v:=os.environ.get(name,"")) and len(v.strip())>20: return v.strip()
        ref=op_reference(self.paths)
        if not ref or not shutil.which("op"): return None
        try: r=subprocess.run(["op","read",ref],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=15,check=False,env=minimal_env(True))
        except (OSError,subprocess.TimeoutExpired): return None
        return r.stdout.strip() if r.returncode==0 and len(r.stdout.strip())>20 else None
    @staticmethod
    def fingerprint(value:str)->bytes: return hashlib.sha256(value.encode()).digest()
    def source_matches(self,token:str)->bool:
        if not self.credential_proof or not (identity:=self.api_identity()): return False
        oauth_fingerprint,_,source_fingerprint=self.credential_proof
        return hmac.compare_digest(oauth_fingerprint,self.fingerprint(token)) and hmac.compare_digest(source_fingerprint,identity)
    def credentials_match(self,token:str,secret:str)->bool:
        return self.source_matches(token) and hmac.compare_digest(self.credential_proof[1],self.fingerprint(secret))
    def proof(self):
        p=read_json(self.paths.proof,{})
        return p if isinstance(p,dict) and isinstance(p.get("models"),list) and all(valid_model(x) for x in p["models"]) else {}
    def health(self):
        token,record=self.oauth(); disk_proof=self.proof(); persisted=set(disk_proof.get("models",[])); models=sorted(self.live_models or persisted); source=self.api_source()
        secret=self.api_secret() if token and source and self.live_models and self.credential_proof else None
        enabled=bool(token and secret and self.live_models and self.credentials_match(token,secret)); secret=None
        reason="OAuth primary; one credential-matched API replay allowed for classified failures" if enabled else "OAuth credential unavailable or ambiguous" if not token else "API credential unavailable" if not source else "no exact model overlap has been proven in this process" if not self.live_models else "credential pair changed or unavailable; run probe again"
        proof_state="live" if enabled else "stale" if self.live_models else "persisted" if persisted else None
        return {"ok":True,"service":APP,"oauth":{"configured":bool(token),"expired":expired(record)},"api":{"configured":bool(source),"source":source},"fallback":{"enabled":enabled,"reason":reason,"credentialCheck":"health-and-request"},"models":models,"modelProof":proof_state,"proofUpdatedAt":disk_proof.get("updatedAt")}
    def probe(self):
        token,_=self.oauth(); ares=None; proven=set(); am=set(); oe=ae=None; api_fingerprint=None; source_fingerprint=self.api_identity()
        candidates=configured_models(self.paths)
        if token:
            statuses=[]
            for model in sorted(candidates):
                body=json.dumps({"model":model,"messages":[{"role":"user","content":"Reply with KORG_I_PROBE only."}],"max_tokens":16},separators=(",",":")).encode()
                try:
                    response=self.transport("POST","/chat/completions",body,token,"oauth"); statuses.append(response.status)
                    if probe_succeeded(response): proven.add(model)
                except NetworkFailure as e: oe=str(e); statuses.append(None)
            oauth_status=200 if proven and len(proven)==len(candidates) else next((x for x in statuses if x!=200),None)
        else: oe="credential unavailable or ambiguous"; oauth_status=None
        secret=self.api_secret()
        if secret:
            api_fingerprint=self.fingerprint(secret)
            try: ares=self.transport("GET","/models",None,secret,"api"); am=response_models(ares)
            except NetworkFailure as e: ae=str(e)
            finally: secret=None
        else: ae="credential unavailable"
        overlap=sorted(proven&am); self.live_models=set(overlap)
        self.credential_proof=(self.fingerprint(token),api_fingerprint,source_fingerprint) if overlap and token and api_fingerprint and source_fingerprint else None
        payload={"version":1,"updatedAt":dt.datetime.now(dt.timezone.utc).isoformat(),"models":overlap,"oauth":{"status":oauth_status,"count":len(proven),"error":oe},"api":{"status":ares.status if ares else None,"count":len(am),"error":ae}}
        with self.lock: write_json(self.paths.proof,payload)
        return {**payload,"fallbackEnabled":bool(self.credential_proof)}
    def request(self,path:str,body:bytes)->UpstreamResponse:
        if path not in {"/chat/completions","/responses"}: return UpstreamResponse(404,b'{"error":{"code":"not_found"}}')
        try: payload=strict_json_loads(body.decode())
        except (UnicodeError,json.JSONDecodeError,DuplicateKeyError): return UpstreamResponse(400,b'{"error":{"code":"invalid_json"}}')
        if not isinstance(payload,dict) or not valid_model(payload.get("model")): return UpstreamResponse(400,b'{"error":{"code":"model_required"}}')
        body=json.dumps(payload,separators=(",",":"),ensure_ascii=False).encode()
        token,_=self.oauth()
        if not token: return UpstreamResponse(503,b'{"error":{"code":"oauth_unavailable"}}')
        try: first=self.transport("POST",path,body,token,"oauth")
        except NetworkFailure: return UpstreamResponse(502,b'{"error":{"code":"oauth_network_failure"}}')
        if not fallback_allowed(first) or payload["model"] not in self.live_models: return first
        secret=self.api_secret()
        if not secret or not self.credentials_match(token,secret): return first
        try: return self.transport("POST",path,body,secret,"api")
        except NetworkFailure: return UpstreamResponse(502,b'{"error":{"code":"api_network_failure"}}')
        finally: secret=None

class BridgeServer(http.server.ThreadingHTTPServer):
    daemon_threads=True; allow_reuse_address=False
    def __init__(self,address,bridge): self.bridge=bridge; super().__init__(address,BridgeHandler)
class BridgeHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def guard(self):
        expected=f"{self.server.server_address[0]}:{self.server.server_address[1]}"; parts=self.path.split("/")
        local=self.headers.get("Host")==expected and self.headers.get("Origin") in {None,"http://"+expected}
        capability=len(parts)>=4 and parts[1]=="session" and secrets.compare_digest(parts[2],self.server.bridge.capability)
        if not local or not capability or "?" in self.path or "#" in self.path:
            self.json(403,{"error":{"code":"request_rejected"}}); return None
        return "/"+"/".join(parts[3:])
    def send_body(self,r):
        self.send_response(r.status); self.send_header("Content-Type",r.content_type); self.send_header("Content-Length",str(len(r.body))); self.send_header("Cache-Control","no-store"); self.send_header("X-Content-Type-Options","nosniff"); self.end_headers(); self.wfile.write(r.body)
    def json(self,status,value): self.send_body(UpstreamResponse(status,json.dumps(value,separators=(",",":")).encode()))
    def do_GET(self):
        path=self.guard()
        if path is None: return
        if path=="/health": self.json(200,self.server.bridge.health())
        elif path=="/v1/models": self.json(200,{"object":"list","data":[{"id":m,"object":"model","owned_by":"xai"} for m in self.server.bridge.health()["models"]]})
        else: self.json(404,{"error":{"code":"not_found"}})
    def do_POST(self):
        path=self.guard()
        if path is None: return
        if path not in {"/v1/chat/completions","/v1/responses"}: self.json(404,{"error":{"code":"not_found"}}); return
        if self.headers.get("Content-Type","").split(";",1)[0].strip().lower()!="application/json" or self.headers.get("Transfer-Encoding"): self.json(415,{"error":{"code":"json_required"}}); return
        try: size=int(self.headers.get("Content-Length",""))
        except ValueError: size=-1
        if size<2 or size>MAX_REQUEST: self.json(413,{"error":{"code":"invalid_length"}}); return
        self.send_body(self.server.bridge.request(path[3:],self.rfile.read(size)))
def bridge_base_url(bridge:Bridge,port:int)->str: return f"http://{HOST}:{port}/session/{bridge.capability}"
def activate_bindings(bridge:Bridge,port:int)->str:
    base=bridge_base_url(bridge,port); data=load_bindings(bridge.paths); changed=False
    for binding in data["agents"].values():
        hop=base+"/v1"
        if binding.get("hopBaseUrl")!=hop: binding["hopBaseUrl"]=hop; changed=True
    if changed: save_bindings(data,bridge.paths)
    return base
def make_bridge_server(bridge,port):
    if not 1<=port<=65535: raise KorgError("port out of range")
    return BridgeServer((HOST,port),bridge)

def load_picker():
    path=Path(__file__).resolve().parent/"tools/korg-i-picker.py"; spec=importlib.util.spec_from_file_location("korg_i_model_picker",path)
    if not spec or not spec.loader: raise KorgError("model picker unavailable")
    mod=importlib.util.module_from_spec(spec); sys.modules[spec.name]=mod; spec.loader.exec_module(mod); return mod
def wrapper_path():
    if configured:=os.environ.get("KORG_I_SET_GROK_WRAPPER"):
        p=Path(configured).expanduser(); _no_link(p)
        if p.is_file() and os.access(p,os.X_OK): return str(p)
        raise KorgError("KORG_I_SET_GROK_WRAPPER is not an executable regular file")
    if found:=shutil.which("set-grok-bot"): return found
    raise KorgError("set-grok-bot wrapper not found")
def wrapper_available():
    try: wrapper_path()
    except KorgError: return False
    return True
def configure(pack_args,bridge_port,picker_port):
    bridge=Bridge(); bridge.probe(); server=make_bridge_server(bridge,bridge_port); thread=None
    try:
        base=activate_bindings(bridge,bridge_port); thread=threading.Thread(target=server.serve_forever,name="korg-i-bridge"); thread.start()
        wrapper=wrapper_path() if os.environ.get("KORG_I_SET_GROK_WRAPPER") or shutil.which("set-grok-bot") else None
        if wrapper:
            env=scrubbed_pack_env({"KORG_I_BRIDGE_URL":base+"/v1","KORG_I_SET_GROK_WRAPPER":wrapper})
            result=subprocess.run([wrapper,"--cli","grok-bot","--no-inject",*pack_args],env=env,check=False)
            if result.returncode: return result.returncode
        else: print("INFO  set-grok-bot wrapper not installed; opening picker only",file=sys.stderr)
        load_picker().run_server(bindings=bridge.paths.bindings,hop=base,host=HOST,port=picker_port,require_live=True); return 0
    except KeyboardInterrupt: return 130
    finally:
        if thread is not None: server.shutdown(); thread.join(timeout=5)
        server.server_close()
def command_serve(a):
    bridge=Bridge(); bridge.probe(); server=make_bridge_server(bridge,a.port)
    try:
        activate_bindings(bridge,a.port); print(f"{APP} bridge listening on http://{HOST}:{a.port} (session capability active)",flush=True); server.serve_forever()
    except KeyboardInterrupt: return 130
    finally: server.server_close()
    return 0
def command_doctor(_):
    p=app_paths(); bridge=Bridge(p); bridge.probe(); h=bridge.health(); checks=[("private state directories",all(stat.S_IMODE(x.stat().st_mode)==0o700 for x in (p.config,p.state,p.cache))),("OAuth credential readable and unambiguous",h["oauth"]["configured"]),("API fallback credential configured",h["api"]["configured"]),("live credential-bound model overlap",h["fallback"]["enabled"])]
    for label,ok in checks: print(f"{'PASS' if ok else 'FAIL'}  {label}")
    print(f"INFO  set-grok-bot wrapper {'available' if wrapper_available() else 'not installed (optional)'}")
    if not h["fallback"]["enabled"]: print("FIX   run: korg-i probe")
    return 0 if all(ok for _,ok in checks) else 1
def command_models(a):
    models=Bridge().health()["models"]
    if a.json: print(json.dumps({"models":models},separators=(",",":")))
    elif models: print("\n".join(models))
    else: print("no exact OAuth/API model overlap; run: korg-i probe",file=sys.stderr)
    return 0 if models else 1
def command_probe(_):
    result=Bridge().probe(); print(json.dumps(result,sort_keys=True,separators=(",",":"))); return 0 if result["fallbackEnabled"] else 1
def command_auth(_):
    h=Bridge().health(); print(json.dumps({"oauth":h["oauth"],"api":h["api"]},sort_keys=True,separators=(",",":"))); return 0 if h["oauth"]["configured"] else 1
def command_show(_): print(json.dumps(load_bindings(),sort_keys=True,indent=2)); return 0
def command_set(a):
    result=bind_set(a.agent_id,a.name,a.model,a.bridge_port); print(json.dumps(result["agents"][a.agent_id],sort_keys=True,separators=(",",":"))); return 0
def parser():
    p=argparse.ArgumentParser(prog=APP); s=p.add_subparsers(dest="command",required=True)
    c=s.add_parser("configure"); c.add_argument("--bridge-port",type=int,default=BRIDGE_PORT); c.add_argument("--picker-port",type=int,default=PICKER_PORT); c.add_argument("pack_args",nargs=argparse.REMAINDER)
    v=s.add_parser("serve"); v.add_argument("--port",type=int,default=BRIDGE_PORT); v.set_defaults(handler=command_serve)
    s.add_parser("doctor").set_defaults(handler=command_doctor); m=s.add_parser("models"); m.add_argument("--json",action="store_true"); m.set_defaults(handler=command_models); s.add_parser("probe").set_defaults(handler=command_probe)
    s.add_parser("auth").add_subparsers(dest="auth_command",required=True).add_parser("status").set_defaults(handler=command_auth)
    b=s.add_parser("bind").add_subparsers(dest="bind_command",required=True); b.add_parser("show").set_defaults(handler=command_show); q=b.add_parser("set"); q.add_argument("--agent-id",required=True); q.add_argument("--name",required=True); q.add_argument("--model",required=True); q.add_argument("--bridge-port",type=int,default=BRIDGE_PORT,help=argparse.SUPPRESS); q.set_defaults(handler=command_set)
    return p
def main(argv=None):
    a=parser().parse_args(argv)
    try:
        if a.command=="configure": return configure(a.pack_args[1:] if a.pack_args[:1]==["--"] else a.pack_args,a.bridge_port,a.picker_port)
        return a.handler(a)
    except KorgError as e: print(f"{APP}: {e}",file=sys.stderr); return 2
if __name__=="__main__": raise SystemExit(main())
