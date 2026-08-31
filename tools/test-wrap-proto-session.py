#!/usr/bin/env python3
"""Prove wrap_proto_session.py against the checked-in host fixtures."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import wrap_proto_session  # noqa: E402

RUNTIME = HERE / "opengrok-runtime.cjs"
FIXTURE = HERE / "fixtures" / "stock-host-mini.cjs"
RENAMED = HERE / "fixtures" / "stock-host-renamed.cjs"
ASYNC = HERE / "fixtures" / "stock-host-async.cjs"
PROP = HERE / "fixtures" / "stock-host-property.cjs"
PROVIDER = HERE / "fixtures" / "stock-host-provider.cjs"

# Live Grok Bot 0.30: factory returns ProtoSessionProvider with getSession().
LIVE_PROVIDER = """
function createProtoSessionProvider(client, requestedModel, modelConfig, inferenceReason) {
  return new ProtoSessionProvider(client, requestedModel, modelConfig, inferenceReason);
}
function outer(options2) {
  const client = createSandCursorBackendClient(InferenceService, options2);
  return createProtoSessionProvider(
    client,
    options2.requestedModel,
    void 0,
    options2.inferenceReason
  ).getSession(imageResizingMiddleware);
}
"""


def run(cmd, env=None, cwd=None):
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=cwd)
    if r.returncode != 0:
        sys.stderr.write(r.stdout + r.stderr)
        raise SystemExit(r.returncode)
    return r


def probe(wrapped: str, extra_js: str = "") -> None:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        host = td / "host.cjs"
        host.write_text(wrapped, encoding="utf-8")
        run(["node", "--check", str(host)])
        bindings = td / "model-bindings.json"
        bindings.write_text(json.dumps({
            "agents": {
                "*": {
                    "name": "fixture",
                    "modelId": "glm-5.3-flash",
                    "hopBaseUrl": "http://127.0.0.1:18790/v1",
                    "parameters": [{"id": "fast", "value": "true"}],
                }
            }
        }) + "\n", encoding="utf-8")
        env = os.environ.copy()
        env["OPENGROK_BINDINGS"] = str(bindings)
        probe_js = td / "probe.cjs"
        probe_js.write_text(
            "const m = require(%s);\n"
            "%s"
            "const s = m.ping();\n"
            "Promise.resolve(s).then((s) => {\n"
            "  if (!s || s.opengrok !== true) {\n"
            "    console.error('expected opengrok session', s);\n"
            "    process.exit(1);\n"
            "  }\n"
            "  if (s.modelId !== 'glm-5.3-flash') {\n"
            "    console.error('modelId', s.modelId);\n"
            "    process.exit(1);\n"
            "  }\n"
            "  if (typeof s.getSession !== 'function') {\n"
            "    console.error('missing getSession');\n"
            "    process.exit(1);\n"
            "  }\n"
            "  const ps = s.getSession();\n"
            "  if (!ps) {\n"
            "    console.error('getSession returned empty');\n"
            "    process.exit(1);\n"
            "  }\n"
            "  console.log('wrap-ok');\n"
            "});\n" % (json.dumps(str(host)), extra_js),
            encoding="utf-8",
        )
        out = run(["node", str(probe_js)], env=env)
        if "wrap-ok" not in out.stdout:
            raise SystemExit("missing wrap-ok: " + out.stdout)


def main():
    src = FIXTURE.read_text(encoding="utf-8")
    c = wrap_proto_session.census(src)
    assert c["function createProtoSession("] == 1, c
    assert c["function_defs"][0]["name"] == "createProtoSession", c
    assert c["already_wrapped"] is False, c

    wrapped = wrap_proto_session.wrap(src, str(RUNTIME))
    assert wrap_proto_session.MARKER in wrapped
    assert wrapped.count("function createProtoSession(") == 1
    assert wrapped.count("function createProtoSession_stock(") == 1
    again = wrap_proto_session.wrap(wrapped, str(RUNTIME))
    assert again == wrapped
    probe(wrapped)

    renamed_src = RENAMED.read_text(encoding="utf-8")
    rc = wrap_proto_session.census(renamed_src)
    assert rc["function createProtoSession("] == 0, rc
    assert rc["idents"].get("createProtoSession2") == 3, rc
    assert rc["function_defs"][0]["name"] == "createProtoSession2", rc
    renamed_wrapped = wrap_proto_session.wrap(renamed_src, str(RUNTIME))
    assert "function createProtoSession2_stock(" in renamed_wrapped
    assert renamed_wrapped.count("function createProtoSession2(") == 1
    probe(renamed_wrapped)

    async_src = ASYNC.read_text(encoding="utf-8")
    ac = wrap_proto_session.census(async_src)
    assert ac["function_defs"][0]["async"] is True, ac
    async_wrapped = wrap_proto_session.wrap(async_src, str(RUNTIME))
    assert "async function createProtoSession_stock(" in async_wrapped
    probe(async_wrapped)

    prop_src = PROP.read_text(encoding="utf-8")
    pc = wrap_proto_session.census(prop_src)
    assert pc["function_defs"] == [], pc
    assert pc["property_defs"][0]["name"] == "createProtoSession", pc
    prop_wrapped = wrap_proto_session.wrap(prop_src, str(RUNTIME))
    assert "createProtoSession_stock:" in prop_wrapped
    probe(prop_wrapped)

    live = wrap_proto_session.census(LIVE_PROVIDER)
    assert live["idents"].get("createProtoSessionProvider") == 2, live
    assert live["function_defs"][0]["name"] == "createProtoSessionProvider", live
    live_wrapped = wrap_proto_session.wrap(LIVE_PROVIDER, str(RUNTIME))
    assert "function createProtoSessionProvider_stock(" in live_wrapped

    provider_src = PROVIDER.read_text(encoding="utf-8")
    pr = wrap_proto_session.census(provider_src)
    assert pr["function_defs"][0]["name"] == "createProtoSessionProvider", pr
    provider_wrapped = wrap_proto_session.wrap(provider_src, str(RUNTIME))
    assert "function createProtoSessionProvider_stock(" in provider_wrapped
    probe(provider_wrapped)

    try:
        wrap_proto_session.wrap("function other(){}", str(RUNTIME))
        raise SystemExit("expected ValueError on missing factory")
    except ValueError:
        pass

    refuse = subprocess.run(
        [sys.executable, str(HERE / "apply-box-patch.py"), "--host", str(FIXTURE), "--dry-run"],
        capture_output=True, text=True,
    )
    if refuse.returncode == 0 or "install-stock-box.py" not in (refuse.stderr or ""):
        sys.stderr.write(refuse.stdout + refuse.stderr)
        raise SystemExit("apply-box-patch.py must refuse the stock fixture")

    print("wrap_proto_session: ok")


if __name__ == "__main__":
    main()
