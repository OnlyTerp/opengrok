import http.client, http.server, json, os, stat, sys, tempfile, threading, unittest
from pathlib import Path
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import korg_i

TOKEN="oauth-"+"x"*40
API="api-"+"y"*40

def fixture_paths(root:Path):
    config=root/"config/korg-i"; state=root/"state/korg-i"; cache=root/"cache/korg-i"
    for p in (config,state,cache): p.mkdir(parents=True,mode=0o700)
    grok=root/"home/.grok"; grok.mkdir(parents=True)
    auth=grok/"auth.json"; auth.write_text(json.dumps({"https://auth.x.ai::client":{"key":TOKEN,"auth_mode":"oidc","oidc_issuer":"https://auth.x.ai","expires_at":"2999-01-01T00:00:00Z"}}))
    cfg=grok/"config.toml"; cfg.write_text('[models]\ndefault = "grok-4.5"\n[model.grok-4.6]\nreasoning_effort = "high"\n')
    key_ref=config/"api-key-ref"; key_ref.write_text("op://vault/item/field\n")
    return korg_i.Paths(config,state,cache,config/"bindings.json",state/"model-proof.json",auth,cfg,key_ref)

class Transport:
    def __init__(self,oauth_status=200,api_status=200,raise_oauth=False): self.oauth_status=oauth_status; self.api_status=api_status; self.raise_oauth=raise_oauth; self.calls=[]
    def __call__(self,method,path,body,token,lane):
        self.calls.append((method,path,lane,json.loads(body) if body else None))
        if lane=="oauth":
            if self.raise_oauth: raise korg_i.NetworkFailure("offline")
            return korg_i.UpstreamResponse(self.oauth_status,b'{"choices":[{"message":{"content":"KORG_I_PROBE"}}]}')
        if method=="GET": return korg_i.UpstreamResponse(200,json.dumps({"data":[{"id":"grok-4.5"},{"id":"grok-4.6"},{"id":"other"}]}).encode())
        return korg_i.UpstreamResponse(self.api_status,b'{"choices":[{"message":{"content":"api"}}]}')

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name); self.paths=fixture_paths(self.root)
        self.env=mock.patch.dict(os.environ,{"KORG_I_XAI_API_KEY":API},clear=False); self.env.start()
    def tearDown(self): self.env.stop(); self.tmp.cleanup()
    def prime(self,bridge):
        result=bridge.probe(); self.assertEqual(result["models"],["grok-4.5","grok-4.6"]); return result
    def test_oauth_success_never_calls_api_for_completion(self):
        tx=Transport(); bridge=korg_i.Bridge(self.paths,tx); self.prime(bridge); tx.calls.clear()
        result=bridge.request("/chat/completions",b'{"model":"grok-4.6","messages":[]}')
        self.assertEqual(result.status,200); self.assertEqual([c[2] for c in tx.calls],["oauth"])
    def test_bridge_http_requires_process_session_capability(self):
        tx=Transport(); bridge=korg_i.Bridge(self.paths,tx); server=korg_i.BridgeServer(("127.0.0.1",0),bridge); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        body=b'{"model":"grok-4.6","messages":[]}'
        def post(path):
            conn=http.client.HTTPConnection("127.0.0.1",server.server_port,timeout=3); conn.request("POST",path,body,{"Content-Type":"application/json"}); response=conn.getresponse(); status=response.status; response.read(); conn.close(); return status
        try:
            self.assertEqual(post("/v1/chat/completions"),403); self.assertEqual(tx.calls,[])
            self.assertEqual(post(f"/session/{bridge.capability}/v1/chat/completions"),200); self.assertEqual([call[2] for call in tx.calls],["oauth"])
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)
    def test_fallback_proof_is_bound_to_exact_credential_pair(self):
        tx=Transport(); bridge=korg_i.Bridge(self.paths,tx); self.prime(bridge); tx.oauth_status=401; tx.calls.clear()
        rotated={"https://auth.x.ai::client":{"key":TOKEN+"r","auth_mode":"oidc","oidc_issuer":"https://auth.x.ai","expires_at":"2999-01-01T00:00:00Z"}}
        self.paths.auth.write_text(json.dumps(rotated)); result=bridge.request("/chat/completions",b'{"model":"grok-4.6"}')
        self.assertEqual(result.status,401); self.assertEqual([call[2] for call in tx.calls],["oauth"]); self.assertFalse(bridge.health()["fallback"]["enabled"])
        rotated["https://auth.x.ai::client"]["key"]=TOKEN; self.paths.auth.write_text(json.dumps(rotated)); tx.calls.clear()
        with mock.patch.dict(os.environ,{"KORG_I_XAI_API_KEY":API+"r"},clear=False):
            result=bridge.request("/chat/completions",b'{"model":"grok-4.6"}'); enabled=bridge.health()["fallback"]["enabled"]
        self.assertEqual(result.status,401); self.assertEqual([call[2] for call in tx.calls],["oauth"]); self.assertFalse(enabled)
        tx.calls.clear(); source_identity=bridge.credential_proof[2]
        with mock.patch.object(bridge,"api_identity",return_value=source_identity), mock.patch.object(bridge,"api_secret",return_value=API+"r"):
            result=bridge.request("/chat/completions",b'{"model":"grok-4.6"}'); enabled=bridge.health()["fallback"]["enabled"]
        self.assertEqual(result.status,401); self.assertEqual([call[2] for call in tx.calls],["oauth"]); self.assertFalse(enabled)
    def test_401_403_and_structured_quota_429_allow_one_replay(self):
        for response in (korg_i.UpstreamResponse(401,b'{}'),korg_i.UpstreamResponse(403,b'{}'),korg_i.UpstreamResponse(429,b'{"error":{"code":"quota_exhausted"}}')):
            with self.subTest(status=response.status):
                tx=Transport(); bridge=korg_i.Bridge(self.paths,tx); self.prime(bridge); tx.calls.clear()
                tx.oauth_status=response.status
                if response.status==429:
                    def call(method,path,body,token,lane,base=tx):
                        base.calls.append((method,path,lane,json.loads(body) if body else None))
                        return response if lane=="oauth" else korg_i.UpstreamResponse(200,b'{}')
                    bridge.transport=call
                result=bridge.request("/chat/completions",b'{"model":"grok-4.5","messages":[]}')
                self.assertEqual(result.status,200); self.assertEqual([c[2] for c in tx.calls],["oauth","api"])
    def test_generic_429_network_and_5xx_fail_closed(self):
        cases=[korg_i.UpstreamResponse(429,b'{"error":{"code":"rate_limit_exceeded"}}'),korg_i.UpstreamResponse(500,b'{}')]
        for response in cases:
            with self.subTest(status=response.status):
                tx=Transport(); bridge=korg_i.Bridge(self.paths,tx); self.prime(bridge); tx.calls.clear()
                def call(method,path,body,token,lane,base=tx): base.calls.append((method,path,lane,None)); return response
                bridge.transport=call; result=bridge.request("/chat/completions",b'{"model":"grok-4.6"}')
                self.assertEqual(result.status,response.status); self.assertEqual([c[2] for c in tx.calls],["oauth"])
        tx=Transport(); bridge=korg_i.Bridge(self.paths,tx); self.prime(bridge); tx.calls.clear(); bridge.transport=lambda *a: (_ for _ in ()).throw(korg_i.NetworkFailure("tls"))
        self.assertEqual(bridge.request("/chat/completions",b'{"model":"grok-4.6"}').status,502)
    def test_probe_preserves_external_auth_files(self):
        before_auth=self.paths.auth.read_bytes(); before_config=self.paths.grok_config.read_bytes()
        self.prime(korg_i.Bridge(self.paths,Transport()))
        self.assertEqual(self.paths.auth.read_bytes(),before_auth); self.assertEqual(self.paths.grok_config.read_bytes(),before_config)
    def test_ambiguous_oauth_entries_are_rejected(self):
        record={"key":TOKEN,"auth_mode":"oidc","oidc_issuer":"https://auth.x.ai"}
        self.paths.auth.write_text(json.dumps({"https://auth.x.ai::one":record,"https://auth.x.ai::two":record}))
        self.assertEqual(korg_i.oauth_record(self.paths),(None,None))
    def test_atomic_private_files_and_symlink_refusal(self):
        value={"version":1,"agents":{"agent-123":{"name":"Scout","modelId":"grok-4.6"}}}; korg_i.save_bindings(value,self.paths)
        self.assertEqual(stat.S_IMODE(self.paths.bindings.stat().st_mode),0o600)
        self.assertEqual(stat.S_IMODE(self.paths.config.stat().st_mode),0o700)
        self.paths.bindings.unlink(); target=self.root/"target"; target.write_text("unchanged"); self.paths.bindings.symlink_to(target)
        with self.assertRaises(korg_i.KorgError): korg_i.save_bindings(value,self.paths)
        self.assertEqual(target.read_text(),"unchanged")
    def test_bind_set_never_replaces_malformed_existing_bindings(self):
        original=b'{"agents":{},"agents":{"bad":{}}}'; self.paths.bindings.write_bytes(original)
        with mock.patch.object(korg_i,"app_paths",return_value=self.paths), self.assertRaises(korg_i.KorgError):
            korg_i.bind_set("remote-agent-42","Executor","grok-4.6")
        self.assertEqual(self.paths.bindings.read_bytes(),original)
    def test_pack_environment_scrubs_all_secrets(self):
        with mock.patch.dict(os.environ,{"XAI_API_KEY":"secret","KORG_I_XAI_API_KEY":"secret2","ANTHROPIC_API_KEY":"secret3","TERM":"xterm"},clear=False):
            env=korg_i.scrubbed_pack_env()
        self.assertEqual(env["KORG_I_CONFIGURING"],"1"); self.assertEqual(env["TERM"],"xterm")
        self.assertNotIn("XAI_API_KEY",env); self.assertNotIn("KORG_I_XAI_API_KEY",env); self.assertNotIn("ANTHROPIC_API_KEY",env)
    def test_configure_without_optional_wrapper_opens_korg_picker(self):
        bridge=mock.Mock(); bridge.paths=self.paths; bridge.capability="A"*43; server=mock.Mock(); picker=mock.Mock()
        with mock.patch.dict(os.environ,{},clear=True), mock.patch.object(korg_i,"Bridge",return_value=bridge), mock.patch.object(korg_i,"make_bridge_server",return_value=server), mock.patch.object(korg_i,"load_picker",return_value=picker), mock.patch.object(korg_i,"app_paths",return_value=self.paths), mock.patch.object(korg_i.shutil,"which",return_value=None), mock.patch.object(korg_i.subprocess,"run") as run:
            result=korg_i.configure([],18787,8766)
        self.assertEqual(result,0); run.assert_not_called(); server.shutdown.assert_called_once(); server.server_close.assert_called_once()
        picker.run_server.assert_called_once_with(bindings=self.paths.bindings,hop=f"http://127.0.0.1:18787/session/{'A'*43}",host="127.0.0.1",port=8766,require_live=True)
    def test_oauth_transport_sets_captured_client_identity_and_model_override(self):
        captured={}
        class Response:
            status=200
            headers=type("Headers",(),{"get_content_type":lambda self:"application/json"})()
            def __enter__(self): return self
            def __exit__(self,*_): return False
            def read(self,_): return b'{"ok":true}'
        def open_request(request,timeout):
            captured["request"]=request; captured["timeout"]=timeout; return Response()
        body=b'{"model":"grok-4.6","messages":[]}'
        with mock.patch.object(korg_i,"grok_client_version",return_value="1.0.6"), mock.patch.object(korg_i.NO_REDIRECT_OPENER,"open",side_effect=open_request):
            response=korg_i.default_transport("POST","/chat/completions",body,TOKEN,"oauth")
        headers={k.lower():v for k,v in captured["request"].header_items()}
        self.assertEqual(response.status,200); self.assertEqual(headers["x-grok-client-version"],"1.0.6")
        self.assertEqual(headers["x-grok-client-identifier"],"grok-cli"); self.assertEqual(headers["x-xai-token-auth"],"xai-grok-cli")
        self.assertEqual(headers["x-grok-model-override"],"grok-4.6"); self.assertEqual(headers["user-agent"],"grok/1.0.6")
    def test_credentialed_transport_never_follows_redirects(self):
        class Capture(http.server.BaseHTTPRequestHandler):
            hits=0
            def do_GET(self): type(self).hits+=1; self.send_response(204); self.end_headers()
            def do_POST(self): type(self).hits+=1; self.send_response(204); self.end_headers()
            def log_message(self,*_): pass
        capture=http.server.ThreadingHTTPServer(("127.0.0.1",0),Capture)
        class Redirect(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(302); self.send_header("Location",f"http://127.0.0.1:{capture.server_port}/capture"); self.end_headers()
            def log_message(self,*_): pass
        source=http.server.ThreadingHTTPServer(("127.0.0.1",0),Redirect)
        threads=[threading.Thread(target=s.serve_forever,daemon=True) for s in (capture,source)]
        for thread in threads: thread.start()
        try:
            with mock.patch.object(korg_i,"OAUTH_UPSTREAM",f"http://127.0.0.1:{source.server_port}"):
                response=korg_i.default_transport("POST","/chat/completions",b'{"model":"grok-4.6"}',TOKEN,"oauth")
            self.assertEqual(response.status,302); self.assertEqual(Capture.hits,0)
        finally:
            for server in (source,capture): server.shutdown(); server.server_close()
            for thread in threads: thread.join(timeout=2)
    def test_duplicate_model_key_is_rejected_before_transport(self):
        tx=Transport(); bridge=korg_i.Bridge(self.paths,tx)
        result=bridge.request("/chat/completions",b'{"model":"grok-4.5","model":"grok-4.6"}')
        self.assertEqual(result.status,400); self.assertEqual(tx.calls,[])
    def test_persisted_proof_cannot_authorize_api_fallback(self):
        bridge=korg_i.Bridge(self.paths,Transport()); self.prime(bridge)
        tx=Transport(oauth_status=401); restarted=korg_i.Bridge(self.paths,tx)
        result=restarted.request("/chat/completions",b'{"model":"grok-4.6"}')
        self.assertEqual(result.status,401); self.assertEqual([c[2] for c in tx.calls],["oauth"])
        self.assertEqual(restarted.health()["modelProof"],"persisted"); self.assertFalse(restarted.health()["fallback"]["enabled"])
    def test_doctor_requires_live_credential_bound_proof(self):
        bridge=mock.Mock(); bridge.health.return_value={"oauth":{"configured":True},"api":{"configured":True},"fallback":{"enabled":False},"models":["grok-4.6"],"modelProof":"persisted"}
        with mock.patch.object(korg_i,"app_paths",return_value=self.paths), mock.patch.object(korg_i,"Bridge",return_value=bridge), mock.patch.object(korg_i,"wrapper_available",return_value=False), mock.patch("builtins.print"):
            result=korg_i.command_doctor(None)
        self.assertEqual(result,1); bridge.probe.assert_called_once()
    def test_bind_set_is_only_creation_path_and_is_canonical(self):
        with mock.patch.object(korg_i,"app_paths",return_value=self.paths):
            result=korg_i.bind_set("remote-agent-42","Executor","grok-4.6")
        self.assertEqual(result["agents"]["remote-agent-42"]["provider"],"grok")
        self.assertEqual(set(result["agents"]["remote-agent-42"]),{"name","modelId","provider","hopBaseUrl"})
        bridge=korg_i.Bridge(self.paths,Transport()); bridge.capability="A"*43; base=korg_i.activate_bindings(bridge,18787)
        self.assertEqual(base,f"http://127.0.0.1:18787/session/{'A'*43}")
        self.assertEqual(korg_i.load_bindings(self.paths)["agents"]["remote-agent-42"]["hopBaseUrl"],base+"/v1")

if __name__=="__main__": unittest.main()
