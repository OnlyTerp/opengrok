# Consult API

The voice brain can hand a question to another assistant ("consult") and speak the
answer when it arrives. Two HTTP surfaces, both localhost-only.

## Consult gateway (port 18795, default)

Open a consult and let the voice brain know one is in flight:

```
POST http://127.0.0.1:18795/consult
{ "question": "top news today", "agent": "Fast", "agent_id": "<your agent id>" }
```

Check status:

```
GET http://127.0.0.1:18795/consult            # current open consult
GET http://127.0.0.1:18795/consult/status?id=c_xxx
```

Deliver an answer (the gateway pushes it to the captain, which speaks it):

```
POST http://127.0.0.1:18795/consult/complete
{ "status": "completed", "text": "the answer", "consult_id": "c_xxx" }

POST http://127.0.0.1:18795/consult/complete
{ "status": "failed", "error": "why it failed", "consult_id": "c_xxx" }
```

Health:

```
GET http://127.0.0.1:18795/health
```

## Who answers

Anything that can call the endpoints above can answer a consult — your own scripts,
another model lane, a human. The roster (`VOICE_CONSULT_ROSTER` in voice/.env) is just
the directory of names the voice brain is allowed to request; each entry is
`NAME|agent-id|alias,alias`. The agent-id is opaque to the gateway; whatever you use to
route it must understand it.

## Direct-to-captain (no gateway)

You can also push results straight to the captain's HTTP endpoint on the gateway:

```
POST http://127.0.0.1:18793/consult.result
{ "status": "completed", "text": "the answer", "consult_id": "c_xxx" }
```

The gateway lane (18795) is preferred: it dedupes (one open consult at a time,
fingerprinted) so the captain never speaks a stale or repeated answer.
