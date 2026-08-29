import http.client, http.server, importlib.util, json, os, stat, tempfile, threading, unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("model_picker",ROOT/"tools/korg-i-picker.py")
picker=importlib.util.module_from_spec(spec); spec.loader.exec_module(picker)

class Hop(http.server.BaseHTTPRequestHandler):
    tests=0
    def log_message(self,*_): pass
    def send_json(self,status,value):
        body=json.dumps(value).encode(); self.send_response(status); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path=="/health": self.send_json(200,{"ok":True,"fallback":{"enabled":True},"models":["grok-4.5","grok-4.6"]})
        else: self.send_json(404,{})
    def do_POST(self):
        Hop.tests+=1
        if self.path=="/v1/chat/completions": self.send_json(200,{"choices":[{"message":{"content":"OK"}}]})
        else: self.send_json(404,{})

class PickerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name); self.bindings=self.root/"config/korg-i/bindings.json"
        picker.private_save(self.bindings,{"version":1,"agents":{"remote-agent-42":{"name":"Executor","modelId":"grok-4.6","provider":"grok","hopBaseUrl":"http://127.0.0.1:18787/v1"}}})
        self.hop=http.server.ThreadingHTTPServer(("127.0.0.1",0),Hop); self.hop_thread=threading.Thread(target=self.hop.serve_forever); self.hop_thread.start()
        self.server=picker.make_server(self.bindings,f"http://127.0.0.1:{self.hop.server_address[1]}",port=0,require_live=True); self.thread=threading.Thread(target=self.server.serve_forever); self.thread.start(); Hop.tests=0
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        if self.hop_thread is not None:
            self.hop.shutdown(); self.hop.server_close(); self.hop_thread.join()
        self.tmp.cleanup()
    def request(self,method,path,value=None,host=None,origin=None,csrf=None,content_type="application/json"):
        conn=http.client.HTTPConnection("127.0.0.1",self.server.server_address[1],timeout=3); body=None if value is None else json.dumps(value).encode()
        conn.putrequest(method,path,skip_host=True); expected=f"127.0.0.1:{self.server.server_address[1]}"; conn.putheader("Host",host or expected)
        actual_origin=("http://"+expected if method=="POST" and origin is None else origin)
        if actual_origin is not None: conn.putheader("Origin",actual_origin)
        if csrf is not None: conn.putheader("X-CSRF-Token",csrf)
        if body is not None: conn.putheader("Content-Type",content_type); conn.putheader("Content-Length",str(len(body)))
        conn.endheaders(body); response=conn.getresponse(); data=response.read(); conn.close(); return response.status,json.loads(data)
    def test_exact_host_origin_and_csrf_are_required(self):
        good_origin=f"http://127.0.0.1:{self.server.server_address[1]}"
        self.assertEqual(self.request("GET","/api/state",host="localhost:8766")[0],403)
        self.assertEqual(self.request("POST","/api/test",{"model":"grok-4.6"},origin="http://evil.invalid",csrf=self.server.csrf)[0],403)
        self.assertEqual(self.request("POST","/api/test",{"model":"grok-4.6"},origin=good_origin,csrf="wrong")[0],403)
        self.assertEqual(self.request("POST","/api/test",{"model":"grok-4.6"},origin=good_origin,csrf=self.server.csrf)[0],200)
    def test_test_endpoint_rejects_ssrf_fields_and_uses_configured_hop(self):
        status,_=self.request("POST","/api/test",{"model":"grok-4.6","baseUrl":"http://169.254.169.254/latest"},csrf=self.server.csrf)
        self.assertEqual(status,400); self.assertEqual(Hop.tests,0)
        status,_=self.request("POST","/api/test",{"model":"grok-4.6"},csrf=self.server.csrf)
        self.assertEqual(status,200); self.assertEqual(Hop.tests,1)
    def test_json_only_and_bounded_posts(self):
        self.assertEqual(self.request("POST","/api/test",{"model":"grok-4.6"},csrf=self.server.csrf,content_type="text/plain")[0],400)
        conn=http.client.HTTPConnection("127.0.0.1",self.server.server_address[1]); conn.putrequest("POST","/api/test"); conn.putheader("Origin",f"http://127.0.0.1:{self.server.server_address[1]}"); conn.putheader("X-CSRF-Token",self.server.csrf); conn.putheader("Content-Type","application/json"); conn.putheader("Content-Length",str(picker.MAX_POST+1)); conn.endheaders(); response=conn.getresponse(); response.read(); conn.close(); self.assertEqual(response.status,400)
    def test_duplicate_json_keys_are_rejected(self):
        body=b'{"model":"grok-4.5","model":"grok-4.6"}'; expected=f"127.0.0.1:{self.server.server_address[1]}"
        conn=http.client.HTTPConnection("127.0.0.1",self.server.server_address[1],timeout=3)
        conn.putrequest("POST","/api/test",skip_host=True); conn.putheader("Host",expected); conn.putheader("Origin","http://"+expected); conn.putheader("X-CSRF-Token",self.server.csrf); conn.putheader("Content-Type","application/json"); conn.putheader("Content-Length",str(len(body))); conn.endheaders(body)
        response=conn.getresponse(); response.read(); conn.close()
        self.assertEqual(response.status,400); self.assertEqual(Hop.tests,0)
    def test_malformed_binding_file_cannot_be_overwritten(self):
        original=b'{"agents":{},"agents":{"remote-agent-42":{}}}'; self.bindings.write_bytes(original)
        self.assertEqual(self.request("GET","/api/state")[0],409)
        self.assertEqual(self.request("POST","/api/save",{"agents":{}},csrf=self.server.csrf)[0],409)
        self.assertEqual(self.bindings.read_bytes(),original)
    def test_session_capability_hop_is_preserved(self):
        capability="A"*43; hop=f"http://127.0.0.1:18787/session/{capability}"
        self.assertEqual(picker.normalize_hop(hop),hop)
    def test_health_probe_never_follows_redirects(self):
        class Sink(http.server.BaseHTTPRequestHandler):
            hits=0
            def log_message(self,*_): pass
            def do_GET(self): Sink.hits+=1; self.send_response(200); self.end_headers()
        class Redirect(http.server.BaseHTTPRequestHandler):
            target=""
            def log_message(self,*_): pass
            def do_GET(self): self.send_response(302); self.send_header("Location",Redirect.target); self.end_headers()
        sink=http.server.ThreadingHTTPServer(("127.0.0.1",0),Sink); redirect=http.server.ThreadingHTTPServer(("127.0.0.1",0),Redirect)
        Redirect.target=f"http://127.0.0.1:{sink.server_port}/capture"; threads=[threading.Thread(target=s.serve_forever,daemon=True) for s in (sink,redirect)]
        for thread in threads: thread.start()
        try:
            self.assertEqual(picker.fetch_health(f"http://127.0.0.1:{redirect.server_port}"),([],None)); self.assertEqual(Sink.hits,0)
        finally:
            for server in (redirect,sink): server.shutdown(); server.server_close()
            for thread in threads: thread.join(timeout=2)
    def test_save_is_canonical_and_cannot_create_agent_ids(self):
        create={"agents":{"remote-agent-42":{"modelId":"grok-4.5"},"invented":{"modelId":"grok-4.5"}}}
        self.assertEqual(self.request("POST","/api/save",create,csrf=self.server.csrf)[0],400)
        update={"agents":{"remote-agent-42":{"modelId":"grok-4.5"}}}
        self.assertEqual(self.request("POST","/api/save",update,csrf=self.server.csrf)[0],200)
        saved=json.loads(self.bindings.read_text()); self.assertEqual(saved["agents"]["remote-agent-42"]["modelId"],"grok-4.5")
        self.assertEqual(set(saved["agents"]["remote-agent-42"]),{"name","modelId","provider","hopBaseUrl"})
        self.assertEqual(stat.S_IMODE(self.bindings.stat().st_mode),0o600); self.assertEqual(stat.S_IMODE(self.bindings.parent.stat().st_mode),0o700)
    def test_require_live_never_falls_back_to_catalog(self):
        self.hop.shutdown(); self.hop.server_close(); self.hop_thread.join(); self.hop_thread=None
        status,body=self.request("GET","/api/state"); self.assertEqual(status,503); self.assertIn("configured hop",body["error"])

if __name__=="__main__": unittest.main()
