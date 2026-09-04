#!/usr/bin/env node
'use strict';
// Voice-v5 supervisor. Thin mux + /health on 127.0.0.1.
// Live port: VOICE_GW_PORT=18793. If mouth or captain dies, ears stay.
// UI JSON protocol matches live v8 client.
const http = require('http');
const path = require('path');
const { fork } = require('child_process');
const { log, appendTeachNote, CONSULT_DEFAULT, EL_VOICE, EL_MODEL, EL_RATE } = require('./lib/shared.cjs');
const { FrameDecoder, wsAcceptKey, uiSendFrame } = require('./lib/ws-raw.cjs');

const PORT = Number(process.env.VOICE_GW_PORT || 18793);
const HOST = process.env.VOICE_GW_HOST || '127.0.0.1';
const ROOT = __dirname;

const kids = {
  ears: { name: 'ears', script: path.join(ROOT, 'ears.cjs'), proc: null, ready: false, sessionReady: false },
  captain: { name: 'captain', script: path.join(ROOT, 'captain.cjs'), proc: null, ready: false, sessionReady: false, responding: false, consultWaiting: false },
  mouth: { name: 'mouth', script: path.join(ROOT, 'mouth.cjs'), proc: null, ready: false, sessionReady: false, speaking: false, elevenlabs: false }
};

const status = {
  uiClients: 0,
  sessionActive: false,
  mode: 'desk',
  speaking: false,
  startedAt: Date.now()
};

let uiClient = null;
const pendingToCaptain = [];
const pendingToMouth = [];

function sendKid(name, msg) {
  const k = kids[name];
  if (k && k.proc && k.proc.connected) {
    try { k.proc.send(msg); return true; } catch (e) { return false; }
  }
  return false;
}

function sendToCaptain(msg) {
  if (sendKid('captain', msg)) return true;
  if (msg && msg.type === 'userText' && msg.text) {
    pendingToCaptain.push(msg);
    if (pendingToCaptain.length > 8) pendingToCaptain.shift();
    log('sup', 'captain.queue userText', String(msg.text).slice(0, 60), 'n', pendingToCaptain.length);
  }
  return false;
}

function flushCaptainQueue() {
  if (!kids.captain.proc || !kids.captain.proc.connected) return;
  while (pendingToCaptain.length) {
    const m = pendingToCaptain.shift();
    try {
      kids.captain.proc.send(m);
      log('sup', 'captain.queue.flush', String(m.text || '').slice(0, 60));
    } catch (e) {
      pendingToCaptain.unshift(m);
      break;
    }
  }
}

function sendToMouth(msg) {
  if (sendKid('mouth', msg)) return true;
  if (msg && msg.type === 'speak' && msg.text) {
    pendingToMouth.push(msg);
    if (pendingToMouth.length > 6) pendingToMouth.shift();
    log('sup', 'mouth.queue speak', String(msg.text).slice(0, 60));
  }
  return false;
}

function flushMouthQueue() {
  if (!kids.mouth.proc || !kids.mouth.proc.connected) return;
  while (pendingToMouth.length) {
    const m = pendingToMouth.shift();
    try { kids.mouth.proc.send(m); } catch (e) { pendingToMouth.unshift(m); break; }
  }
}

function uiSend(obj) {
  if (!uiClient || uiClient.readyState !== 1) return;
  try { uiClient.send(JSON.stringify(obj)); } catch (e) {}
}

function spawnKid(name) {
  const k = kids[name];
  if (k.proc && k.proc.exitCode === null && !k.proc.killed) return;
  log('sup', 'spawn', name);
  const proc = fork(k.script, [], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: Object.assign({}, process.env, { VOICE_ROLE: name })
  });
  k.proc = proc;
  k.ready = false;
  k.sessionReady = false;
  if (proc.stdout) proc.stdout.on('data', function (d) { log(name, 'stdout', String(d).trim().slice(0, 200)); });
  if (proc.stderr) proc.stderr.on('data', function (d) { log(name, 'stderr', String(d).trim().slice(0, 200)); });
  proc.on('message', function (msg) { onKidMsg(name, msg); });
  proc.on('exit', function (code, sig) {
    log('sup', name, 'exit', code, sig || '');
    k.proc = null;
    k.ready = false;
    k.sessionReady = false;
    if (name === 'mouth') { k.speaking = false; status.speaking = false; }
    if (name === 'captain') { k.responding = false; }
    if (!process._shuttingDown) {
      setTimeout(function () {
        spawnKid(name);
        if (status.sessionActive) {
          setTimeout(function () { sendKid(name, { type: 'session.start', mode: status.mode }); }, 300);
        }
      }, 400);
    }
  });
  proc.on('error', function (e) { log('sup', name, 'proc-error', e.message); });
}

function onKidMsg(name, msg) {
  if (!msg || typeof msg !== 'object') return;
  const k = kids[name];
  try {
    if (msg.type === 'ready') {
      k.ready = true;
      if (name === 'mouth') k.elevenlabs = !!msg.elevenlabs || k.elevenlabs;
      log('sup', name, 'ready');
      if (name === 'captain') flushCaptainQueue();
      if (name === 'mouth') flushMouthQueue();
      return;
    }
    if (msg.type === 'status') {
      if (msg.ready === true) k.ready = true; // idle session.stop must not mark process down
      if (name === 'mouth') {
        if (typeof msg.speaking === 'boolean') {
          k.speaking = msg.speaking;
          status.speaking = msg.speaking;
        }
        if (typeof msg.elevenlabs === 'boolean') k.elevenlabs = msg.elevenlabs;
        if (k.ready) flushMouthQueue();
      }
      if (name === 'captain') {
        if (typeof msg.responding === 'boolean') k.responding = msg.responding;
        if (typeof msg.consultWaiting === 'boolean') k.consultWaiting = msg.consultWaiting;
        if (k.ready) flushCaptainQueue();
      }
      return;
    }
    if (msg.type === 'session.ready') {
      k.sessionReady = true;
      if (name === 'captain') flushCaptainQueue();
      if (name === 'mouth') flushMouthQueue();
      maybeSessionReady();
      return;
    }
    if (msg.type === 'session.error') {
      k.sessionReady = false;
      log('sup', name, 'session.error', msg.error || '');
      if (name === 'ears' || name === 'captain') {
        uiSend({ type: 'state', state: 'error', error: (name + ': ' + (msg.error || 'failed')) });
      }
      return;
    }
    if (name === 'ears') {
      if (msg.type === 'user.partial') uiSend({ type: 'user.partial', text: msg.text, final: !!msg.final, speech_final: !!msg.speech_final });
      else if (msg.type === 'user.utterance') {
        // ALWAYS forward to captain. barge.skip must never drop a follow-up.
        uiSend({ type: 'user.utterance', text: msg.text, mode: status.mode });
        log('sup', 'user.utterance -> captain', String(msg.text || '').slice(0, 80));
        sendToCaptain({ type: 'userText', text: msg.text });
      } else if (msg.type === 'speech.start') maybeBarge();
      else if (msg.type === 'error') log('sup', 'ears.error', msg.error || '');
      return;
    }
    if (name === 'captain') {
      if (msg.type === 'transcript.delta') uiSend({ type: 'transcript.delta', delta: msg.delta || '' });
      else if (msg.type === 'response.done') uiSend({ type: 'response.done' });
      else if (msg.type === 'consult') uiSend({ type: 'consult', question: msg.question, agent: msg.agent, agentId: msg.agentId });
      else if (msg.type === 'dispatch') uiSend({ type: 'dispatch', task: msg.task, agent: msg.agent || '', agentId: msg.agentId || '' });
      else if (msg.type === 'speak') sendToMouth({ type: 'speak', text: msg.text });
      else if (msg.type === 'barge') {
        sendKid('mouth', { type: 'stop' });
        uiSend({ type: 'barge' });
      } else if (msg.type === 'state') uiSend({ type: 'state', state: msg.state, error: msg.error });
      else if (msg.type === 'error') log('sup', 'captain.error', msg.error || '');
      return;
    }
    if (name === 'mouth') {
      if (msg.type === 'audio.delta') uiSend({ type: 'audio.delta', format: msg.format || 'pcm16', rate: msg.rate || EL_RATE, delta: msg.delta });
      else if (msg.type === 'speak.start') { status.speaking = true; k.speaking = true; }
      else if (msg.type === 'speak.done') { status.speaking = false; k.speaking = false; }
      else if (msg.type === 'error') log('sup', 'mouth.error', msg.error || '');
      return;
    }
  } catch (e) {
    log('sup', 'kid-msg err', name, e.message);
  }
}

function maybeBarge() {
  // Barge only if mouth is speaking or captain is producing a reply. Not silent consult-wait.
  // barge.skip does NOT drop user.utterance — that path is independent.
  if (kids.mouth.speaking || kids.captain.responding) {
    sendKid('mouth', { type: 'stop' });
    sendKid('captain', { type: 'barge' });
    uiSend({ type: 'barge' });
    log('sup', 'barge stop-mouth+response.cancel');
  } else {
    log('sup', 'barge.skip', 'no-mouth-no-responding');
  }
}

function maybeSessionReady() {
  if (!status.sessionActive) return;
  if (kids.ears.sessionReady && kids.captain.sessionReady) {
    uiSend({ type: 'state', state: 'ready' });
    log('sup', 'session ready (ears+captain); mouth', kids.mouth.ready);
  }
}

function tearSession() {
  status.sessionActive = false;
  sendKid('ears', { type: 'session.stop' });
  sendKid('captain', { type: 'session.stop' });
  sendKid('mouth', { type: 'session.stop' });
  kids.ears.sessionReady = false;
  kids.captain.sessionReady = false;
  kids.mouth.sessionReady = false;
  kids.mouth.speaking = false;
  kids.captain.responding = false;
  status.speaking = false;
  pendingToCaptain.length = 0;
  pendingToMouth.length = 0;
}

function startSession(mode) {
  // Teach is never auto-started. Only if the client sent mode=teach.
  status.mode = mode === 'teach' ? 'teach' : 'desk';
  status.sessionActive = true;
  kids.ears.sessionReady = false;
  kids.captain.sessionReady = false;
  kids.mouth.sessionReady = false;
  uiSend({ type: 'state', state: 'connecting' });
  sendKid('ears', { type: 'session.start', mode: status.mode });
  sendKid('captain', { type: 'session.start', mode: status.mode });
  sendKid('mouth', { type: 'session.start', mode: status.mode });
}

function healthBody() {
  return {
    ok: true,
    service: 'grokbot-voice-v5',
    port: PORT,
    ears: kids.ears.proc && kids.ears.proc.exitCode === null ? (kids.ears.ready ? 'up' : 'spawned') : 'down',
    captain: kids.captain.proc && kids.captain.proc.exitCode === null ? (kids.captain.ready ? 'up' : 'spawned') : 'down',
    mouth: kids.mouth.proc && kids.mouth.proc.exitCode === null ? (kids.mouth.ready ? 'up' : 'spawned') : 'down',
    ears_pid: kids.ears.proc ? kids.ears.proc.pid : 0,
    captain_pid: kids.captain.proc ? kids.captain.proc.pid : 0,
    mouth_pid: kids.mouth.proc ? kids.mouth.proc.pid : 0,
    supervisor_pid: process.pid,
    speaking: !!status.speaking,
    session: !!status.sessionActive,
    mode: status.mode,
    stt: 'wss://api.x.ai/v1/stt',
    stt_rate: 16000,
    input: 'pcm16-24k-to-16k-grok-stt',
    realtime: 'gpt-realtime-2.1',
    output_modalities: ['text'],
    elevenlabs: !!kids.mouth.elevenlabs,
    voice: EL_VOICE,
    model: EL_MODEL,
    rate: EL_RATE,
    barge: 'response.cancel+stop-mouth',
    consult: true,
    consult_default: (CONSULT_DEFAULT && CONSULT_DEFAULT.name) || null,
    consult_default_id: (CONSULT_DEFAULT && CONSULT_DEFAULT.id) || null,
    rest_min_speech_ms: 1600,
    silence_ms_to_finalize: 900,
    captain_idle_ms: 900000,
    stt_idle_ms: 900000,
    stt_reset_after_final: true,
    fallback_speak: true,
    pending_captain: pendingToCaptain.length
  };
}

function readJsonBody(req, cb) {
  const chunks = [];
  req.on('data', function (d) { chunks.push(d); if (Buffer.concat(chunks).length > 20000) req.destroy(); });
  req.on('end', function () {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch (e) { cb(e); }
  });
  req.on('error', cb);
}

const server = http.createServer(function (req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(healthBody()));
    return;
  }
  if (req.method === 'POST' && (req.url === '/consult.result' || req.url === '/consult-result' || req.url === '/consult/ping' || req.url === '/consult/complete')) {
    readJsonBody(req, function (err, body) {
      if (err) { res.writeHead(400); res.end('bad json'); return; }
      body = body || {};
      const status = String(body.status || 'completed').toLowerCase();
      const text = String(body.text || body.result || body.answer || '').trim();
      if (status === 'completed' && !text && !(body.text && String(body.text).charAt(0) === '{')) { res.writeHead(400); res.end('missing text'); return; }
      log('sup', 'http consult.ping', status, (body.consult_id || ''), (text || body.error || '').slice(0, 80));
      sendToCaptain({ type: 'consult.result', text: text || JSON.stringify(body), status: status, consult_id: body.consult_id || body.consultId || '', error: body.error || '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: status, consult_id: body.consult_id || '' }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on('upgrade', function (req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = wsAcceptKey(key);
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const client = { socket: socket, readyState: 1 };
  client.send = function (data) { uiSendFrame(socket, data); };
  if (uiClient && uiClient.readyState === 1) {
    try { uiClient.socket.destroy(); } catch (e) {}
  }
  uiClient = client;
  status.uiClients = 1;

  function handleMessage(payload) {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
    try {
      if (msg.type === 'start') startSession(msg.mode);
      else if (msg.type === 'stop') {
        tearSession();
        client.send(JSON.stringify({ type: 'state', state: 'idle' }));
      } else if (msg.type === 'input_text') {
        log('sup', 'ui input_text -> captain', String(msg.text || '').slice(0, 80));
        sendToCaptain({ type: 'userText', text: msg.text });
      } else if (msg.type === 'input_audio') sendKid('ears', { type: 'audio', delta: msg.delta, format: msg.format || 'pcm16', rate: msg.rate || 24000 });
      else if (msg.type === 'commit_audio') { /* Grok STT owns turns */ }
      else if (msg.type === 'assistant.speak') sendToMouth({ type: 'speak', text: String(msg.text || '') });
      else if (msg.type === 'teach.note') appendTeachNote(msg);
      else if (msg.type === 'consult.result') sendToCaptain({ type: 'consult.result', text: msg.text });
      else if (msg.type === 'agent.update') sendToCaptain({ type: 'agent.update', text: msg.text });
    } catch (e) {
      log('sup', 'ui-msg err', e.message);
    }
  }

  const dec = new FrameDecoder(function (opcode, payload) {
    if (opcode === 0x8) {
      client.readyState = 3;
      tearSession();
      try { socket.destroy(); } catch (e) {}
      if (uiClient === client) { uiClient = null; status.uiClients = 0; }
      return;
    }
    if (opcode === 0x1) handleMessage(payload);
  });
  socket.on('data', function (d) { dec.push(d); });
  socket.on('close', function () {
    client.readyState = 3;
    tearSession();
    if (uiClient === client) { uiClient = null; status.uiClients = 0; }
  });
  socket.on('error', function () {});
});

function boot() {
  spawnKid('ears');
  spawnKid('captain');
  spawnKid('mouth');
  server.listen(PORT, HOST, function () {
    log('sup', 'listening v5', PORT, 'split ears/captain/mouth');
    console.log(new Date().toISOString(), 'grokbot-voice-v5 listening on ws://' + HOST + ':' + PORT);
  });
  server.on('error', function (e) {
    log('sup', 'listen err', e.code || '', e.message);
    console.error('listen failed', e.message);
    process.exit(1);
  });
}

function shutdown() {
  process._shuttingDown = true;
  try { server.close(); } catch (e) {}
  ['ears', 'captain', 'mouth'].forEach(function (name) {
    const k = kids[name];
    if (k.proc) {
      try { k.proc.kill(); } catch (e) {}
    }
  });
  setTimeout(function () { process.exit(0); }, 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', function (e) {
  log('sup', 'uncaught', e.message);
});

if (require.main === module) boot();

module.exports = { sendToCaptain, sendToMouth, healthBody, maybeBarge, kids, status };
