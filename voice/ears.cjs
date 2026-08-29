#!/usr/bin/env node
'use strict';
// Voice-v5 ears. Isolated process: Grok/xAI streaming STT.
// Renderer sends pcm16/24k. Convert 24k→16k here once. Do not finalize at ~0.6s.
// Reset STT after each final so the next transcript cannot prepend the last one.
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');
const {
  log, readGrokJwt, pcm16_24k_to_16k, rms16, extractSttText, parentSend,
  STT_CHUNK, STT_RATE, RMS_SPEECH, SILENCE_MS_TO_FINALIZE,
  MIN_SPEECH_MS_TO_FINALIZE, REST_MIN_SPEECH_MS
} = require('./lib/shared.cjs');
const { FrameDecoder, wsSendBinary, wsSendText, wsSendPong, wsSendPing, armSocketIdle } = require('./lib/ws-raw.cjs');

const STT_HOST = 'api.x.ai';
const STT_PATH = '/v1/stt?encoding=pcm&sample_rate=16000&interim_results=true&language=en&endpointing=800&vad_threshold=0';

function restStt(pcm16, cb) {
  let jwt;
  try { jwt = readGrokJwt(); } catch (e) { return cb(e); }
  if (!pcm16 || pcm16.length < 1600) return cb(new Error('rest too short'));
  const boundary = '----stt' + Date.now();
  const parts = [
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="audio_format"\r\n\r\npcm\r\n'),
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="sample_rate"\r\n\r\n16000\r\n'),
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n'),
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="format"\r\n\r\ntrue\r\n'),
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="speech.pcm"\r\nContent-Type: application/octet-stream\r\n\r\n'),
    pcm16,
    Buffer.from('\r\n--' + boundary + '--\r\n')
  ];
  const body = Buffer.concat(parts);
  const req = https.request({
    hostname: 'api.x.ai',
    path: '/v1/stt',
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + jwt,
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'User-Agent': 'grok-cli/1.0.5',
      'x-grok-client-version': '1.0.5',
      'x-grok-client-identifier': 'grok-shell',
      'x-grok-client-mode': 'cli',
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length
    }
  }, function (res) {
    const chunks = [];
    res.on('data', function (d) { chunks.push(d); });
    res.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return cb(new Error('rest ' + res.statusCode + ' ' + raw.slice(0, 120)));
      }
      let j;
      try { j = JSON.parse(raw); } catch (e) { return cb(new Error('rest nonjson')); }
      cb(null, extractSttText(j));
    });
  });
  req.on('error', cb);
  req.setTimeout(5000, function () { try { req.destroy(); } catch (e) {} cb(new Error('rest timeout')); });
  req.write(body);
  req.end();
}

function stripPrevUtterance(text, prev) {
  if (!text) return '';
  const t = String(text).trim();
  const p = String(prev || '').trim();
  if (!p) return t;
  if (t === p) return '';
  if (t.indexOf(p) === 0) {
    return t.slice(p.length).replace(/^[\s,.:;!?\-]+/, '').trim();
  }
  // Longest shared prefix of at least 16 chars, then remainder.
  let i = 0;
  const n = Math.min(t.length, p.length);
  while (i < n && t.charAt(i).toLowerCase() === p.charAt(i).toLowerCase()) i++;
  if (i >= 16 && i >= Math.floor(p.length * 0.6)) {
    return t.slice(i).replace(/^[\s,.:;!?\-]+/, '').trim();
  }
  return t;
}

class GrokStt {
  constructor() {
    this.closed = false;
    this.ready = false;
    this._everReady = false;
    this.raw24 = Buffer.alloc(0);
    this.pcmBuf = Buffer.alloc(0);
    this.preReady = [];
    this.lastUtterance = '';
    this.lastUtteranceAt = 0;
    this.inTurn = false;
    this.reconnectTimer = null;
    this.socket = null;
    this._inChunks = 0;
    this._outChunks = 0;
    this.authMode = 'bearer+cli';
    this._onCreated = null;
    this.gotPartial = false;
    this.hadSpeech = false;
    this.speechMs = 0;
    this.lowMs = 0;
    this.restFired = false;
    this.restBuf = Buffer.alloc(0);
    this.lastFinalizeAt = 0;
    this._signaledSpeech = false;
    this._ignoreUntilEnergy = true;
    this._ka = null;
    this._idle = null;
    this._resetAfterFinal = false;
    this._lastReconnectAt = 0;
  }
  resetTurn(reason) {
    this.hadSpeech = false;
    this.speechMs = 0;
    this.lowMs = 0;
    this.gotPartial = false;
    this.inTurn = false;
    this._signaledSpeech = false;
    this.restFired = false;
    this.restBuf = Buffer.alloc(0);
    this._ignoreUntilEnergy = true;
    log('ears', 'turn.reset', reason || '');
  }
  dropAudioBuffers() {
    this.raw24 = Buffer.alloc(0);
    this.pcmBuf = Buffer.alloc(0);
    this.preReady = [];
    this.restBuf = Buffer.alloc(0);
  }
  connect() {
    const self = this;
    return new Promise(function (resolve, reject) {
      self._connectOnce().then(resolve).catch(function (e) {
        if (self.closed) return reject(e);
        if (self.authMode === 'bearer+cli' && /401/.test(String(e.message || ''))) {
          self.authMode = 'bearer';
          log('ears', 'stt.retry bearer-only');
          self._connectOnce().then(resolve).catch(reject);
        } else reject(e);
      });
    });
  }
  _connectOnce() {
    const self = this;
    return new Promise(function (resolve, reject) {
      let jwt;
      try { jwt = readGrokJwt(); } catch (e) { return reject(e); }
      const key = crypto.randomBytes(16).toString('base64');
      const cli = self.authMode === 'bearer+cli'
        ? 'X-XAI-Token-Auth: xai-grok-cli\r\nUser-Agent: grok-cli/1.0.5\r\nx-grok-client-version: 1.0.5\r\nx-grok-client-identifier: grok-shell\r\nx-grok-client-mode: cli\r\n'
        : '';
      const req = 'GET ' + STT_PATH + ' HTTP/1.1\r\nHost: ' + STT_HOST + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ' + jwt + '\r\n' + cli + '\r\n';
      const socket = tls.connect({ host: STT_HOST, port: 443, servername: STT_HOST }, function () { socket.write(req); });
      self.socket = socket;
      if (self._idle) { try { self._idle.clear(); } catch (e) {} }
      // 900s idle. Silent rms 0 must NOT tear the session. Ping instead of destroy.
      self._idle = armSocketIdle(socket, 'stt', function () {
        log('ears', 'stt.idle ping-keep (no teardown)');
        try { wsSendPing(socket); } catch (e) {}
        if (self._idle && self._idle.touch) self._idle.touch();
      }, log);
      let settled = false;
      const dec = new FrameDecoder(function (opcode, payload) { self.onFrame(opcode, payload); });
      let buf = Buffer.alloc(0);
      const timer = setTimeout(function () {
        if (!settled) { settled = true; try { socket.destroy(); } catch (e) {} reject(new Error('stt handshake timeout')); }
      }, 8000);
      self._onCreated = function () {
        if (!settled) { settled = true; clearTimeout(timer); resolve(); }
      };
      socket.on('data', function (d) {
        if (!socket.__upgraded) {
          buf = Buffer.concat([buf, d]);
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const head = buf.slice(0, idx).toString();
          const line = head.split('\r\n')[0];
          if (!/101/.test(line)) {
            try { socket.destroy(); } catch (e) {}
            if (!settled) { settled = true; clearTimeout(timer); reject(new Error('stt handshake: ' + line)); }
            return;
          }
          socket.__upgraded = true;
          const rest = buf.slice(idx + 4);
          socket.removeAllListeners('data');
          socket.on('data', function (dd) { dec.push(dd); });
          if (rest.length) dec.push(rest);
        }
      });
      socket.on('error', function (e) {
        if (!settled) { settled = true; clearTimeout(timer); reject(e); }
        else self.onSocketDead(e);
      });
      socket.on('close', function () {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('stt closed before ready')); }
        else self.onSocketDead(null);
      });
    });
  }
  onSocketDead(err) {
    this.ready = false;
    if (this.closed) return;
    if (!this._everReady) return;
    log('ears', 'stt.reconnect', err ? err.message : 'closed');
    parentSend({ type: 'status', ready: false });
    if (this.reconnectTimer) return;
    const now = Date.now();
    const wait = (now - this._lastReconnectAt < 2000) ? 2000 : 800;
    const self = this;
    this.reconnectTimer = setTimeout(function () {
      self.reconnectTimer = null;
      if (self.closed) return;
      self._lastReconnectAt = Date.now();
      self.dropAudioBuffers();
      self.resetTurn('reconnect');
      self.connect().then(function () {
        log('ears', 'stt.created reconnected');
        parentSend({ type: 'status', ready: true });
      }).catch(function (e) {
        log('ears', 'stt.error', e.message);
        self.onSocketDead(e);
      });
    }, wait);
  }
  armKeepalive() {
    const self = this;
    if (this._ka) clearInterval(this._ka);
    this._ka = setInterval(function () {
      if (self.closed || !self.socket || !self.ready) return;
      if (self._idle && self._idle.touch) self._idle.touch();
      try { wsSendPing(self.socket); } catch (e) {}
    }, 15000);
  }
  onFrame(opcode, payload) {
    if (opcode === 0x8) { this.onSocketDead(null); return; }
    if (opcode === 0x9) { wsSendPong(this.socket, payload); if (this._idle && this._idle.touch) this._idle.touch(); return; }
    if (opcode === 0xA) { if (this._idle && this._idle.touch) this._idle.touch(); return; }
    if (opcode !== 1 && opcode !== 2) return;
    let raw = '';
    try { raw = payload.toString('utf8'); } catch (e) { return; }
    let j;
    try { j = JSON.parse(raw); } catch (e) { return; }
    const emptyPartial = (j.type === 'transcript.partial' && !extractSttText(j));
    if (!emptyPartial) log('ears', 'stt.evt', j.type || 'unknown', raw.slice(0, 160));
    if (j.type === 'transcript.created') {
      this.ready = true;
      this._everReady = true;
      this.armKeepalive();
      this.flushPreReady();
      if (this._onCreated) this._onCreated();
      return;
    }
    if (j.type === 'transcript.partial') {
      let text = extractSttText(j);
      text = stripPrevUtterance(text, this.lastUtterance);
      if (this._ignoreUntilEnergy && !this.hadSpeech) {
        // leftover / replay after reconnect or final — do not barge or finalize
        if (!text) return;
        log('ears', 'stt.ignore-until-energy', text.slice(0, 60));
        return;
      }
      if (text) {
        this.gotPartial = true;
        if (!this.inTurn) this.inTurn = true;
        if (!this._signaledSpeech) {
          this._signaledSpeech = true;
          parentSend({ type: 'speech.start' });
        }
        parentSend({ type: 'user.partial', text: text, final: !!j.is_final, speech_final: !!j.speech_final });
        if (j.speech_final || (j.is_final && j.speech_final)) this.finalizeUtterance(text);
      }
      if (j.speech_final) this.inTurn = false;
      return;
    }
    if (j.type === 'transcript.done') {
      let text = stripPrevUtterance(extractSttText(j), this.lastUtterance);
      if (this._ignoreUntilEnergy && !this.hadSpeech) {
        log('ears', 'stt.done-ignore-until-energy', (text || '').slice(0, 60));
        this.inTurn = false;
        return;
      }
      if (text) this.finalizeUtterance(text);
      this.inTurn = false;
      return;
    }
    if (j.type === 'error') {
      const msg = ((j.message || (j.error && j.error.message) || JSON.stringify(j.error || j)) + '').slice(0, 200);
      log('ears', 'stt.error', msg);
      parentSend({ type: 'error', error: msg });
    }
  }
  finalizeUtterance(text) {
    if (!text) return;
    text = stripPrevUtterance(text, this.lastUtterance) || text;
    const now = Date.now();
    if (text === this.lastUtterance && now - this.lastUtteranceAt < 1500) return;
    this.lastUtterance = text;
    this.lastUtteranceAt = now;
    this.inTurn = false;
    this.gotPartial = true;
    this._signaledSpeech = false;
    log('ears', 'stt.final', text.slice(0, 80));
    parentSend({ type: 'user.utterance', text: text });
    this.resetAfterFinal();
  }
  resetAfterFinal() {
    this.resetTurn('after-final');
    if (!this.ready || !this.socket || this.closed) return;
    // xAI STT has no `reset` variant. Reconnect below is the real reset.
    log('ears', 'stt.reset after-final reconnect-only');
    // Fresh stream so the next partial cannot prepend the last utterance.
    const self = this;
    if (this._resetAfterFinal) return;
    this._resetAfterFinal = true;
    setTimeout(function () {
      self._resetAfterFinal = false;
      if (self.closed || !self._everReady) return;
      try { if (self.socket) self.socket.destroy(); } catch (e) {}
      // onSocketDead will reconnect with clean buffers
    }, 120);
  }
  sendFinalize() {
    if (!this.ready || !this.socket || this.closed) return;
    const now = Date.now();
    if (now - this.lastFinalizeAt < 300) return;
    this.lastFinalizeAt = now;
    log('ears', 'stt.finalize energy-silence');
    wsSendText(this.socket, JSON.stringify({ type: 'finalize' }));
  }
  maybeRestFallback(reason) {
    // Live Grok STT owns the turn. REST mid-utterance is how we cut
    // "Can you see what's going on in my" before he finished.
    if (this.ready && this.socket && !this.closed) return;
    if (this.gotPartial || this.restFired || this.closed) return;
    if (this.speechMs < REST_MIN_SPEECH_MS) return;
    this.restFired = true;
    const pcm = Buffer.from(this.restBuf);
    const self = this;
    log('ears', 'stt.rest fallback', reason || '', 'bytes', pcm.length, 'speechMs', this.speechMs);
    restStt(pcm, function (err, text) {
      if (err) { log('ears', 'stt.rest err', err.message); return; }
      if (text) {
        const cleaned = stripPrevUtterance(text, self.lastUtterance);
        log('ears', 'stt.rest text', (cleaned || text).slice(0, 80));
        if (cleaned) self.finalizeUtterance(cleaned);
      } else log('ears', 'stt.rest empty');
    });
  }
  feed(base64Pcm16) {
    if (!base64Pcm16) return;
    this._inChunks = (this._inChunks || 0) + 1;
    if (this._inChunks === 1 || this._inChunks % 40 === 0) log('ears', 'mic chunks', this._inChunks);
    const pcm24 = Buffer.from(base64Pcm16, 'base64');
    this.raw24 = Buffer.concat([this.raw24, pcm24]);
    const usable = this.raw24.length - (this.raw24.length % 6);
    if (usable > 0) {
      const chunk24 = this.raw24.slice(0, usable);
      this.raw24 = this.raw24.slice(usable);
      this.pcmBuf = Buffer.concat([this.pcmBuf, pcm16_24k_to_16k(chunk24)]);
    }
    this.flushChunks();
  }
  flushChunks() {
    while (this.pcmBuf.length >= STT_CHUNK) {
      const slice = this.pcmBuf.slice(0, STT_CHUNK);
      this.pcmBuf = this.pcmBuf.slice(STT_CHUNK);
      this._outChunks = (this._outChunks || 0) + 1;
      const energy = rms16(slice);
      const isSpeech = energy > RMS_SPEECH;
      if (isSpeech) {
        if (!this.hadSpeech) {
          this.gotPartial = false;
          this.restFired = false;
          this.restBuf = Buffer.alloc(0);
          this.speechMs = 0;
          this._signaledSpeech = false;
          this.inTurn = true;
          this._ignoreUntilEnergy = false;
          this._signaledSpeech = true;
          parentSend({ type: 'speech.start' });
        }
        this.hadSpeech = true;
        this.speechMs += 100;
        this.lowMs = 0;
        this.restBuf = Buffer.concat([this.restBuf, slice]);
        if (this.restBuf.length > STT_RATE * 2 * 8) {
          this.restBuf = this.restBuf.slice(this.restBuf.length - STT_RATE * 2 * 8);
        }
      } else if (this.hadSpeech) {
        this.lowMs += 100;
      }
      if (this._outChunks === 1 || this._outChunks % 40 === 0) {
        log('ears', 'mic energy rms', Math.round(energy), 'speechMs', this.speechMs, 'lowMs', this.lowMs, 'partial', !!this.gotPartial);
      }
      if (this.ready && this.socket && !this.closed) wsSendBinary(this.socket, slice);
      else {
        this.preReady.push(slice);
        if (this.preReady.length > 50) this.preReady.shift();
      }
      if (!this.gotPartial && this.speechMs >= REST_MIN_SPEECH_MS) {
        this.maybeRestFallback('speech-1.6s-no-partial');
      }
      // Real utterance end: 900ms silence after >=1600ms speech, or server speech_final.
      if (this.hadSpeech && this.lowMs >= SILENCE_MS_TO_FINALIZE && this.speechMs >= MIN_SPEECH_MS_TO_FINALIZE) {
        this.sendFinalize();
        if (!this.gotPartial) this.maybeRestFallback('silence-after-speech');
        this.hadSpeech = false;
        this.lowMs = 0;
        this.speechMs = 0;
        this._signaledSpeech = false;
      }
    }
  }
  flushPreReady() {
    while (this.preReady.length && this.ready && this.socket && !this.closed) {
      wsSendBinary(this.socket, this.preReady.shift());
    }
    this.flushChunks();
  }
  stop() {
    this.closed = true;
    this.ready = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this._ka) { clearInterval(this._ka); this._ka = null; }
    if (this._idle) { try { this._idle.clear(); } catch (e) {} this._idle = null; }
    try { if (this.socket) this.socket.destroy(); } catch (e) {}
    this.socket = null;
  }
}

let stt = null;

function sessionStart() {
  if (stt) { try { stt.stop(); } catch (e) {} }
  stt = new GrokStt();
  stt.connect().then(function () {
    log('ears', 'session ready');
    parentSend({ type: 'session.ready' });
    parentSend({ type: 'status', ready: true });
  }).catch(function (e) {
    log('ears', 'session fail', e.message);
    parentSend({ type: 'session.error', error: e.message || 'stt failed' });
    parentSend({ type: 'status', ready: false });
  });
}

function sessionStop() {
  if (stt) { try { stt.stop(); } catch (e) {} stt = null; }
  parentSend({ type: 'status', ready: false });
}

process.on('message', function (msg) {
  if (!msg || typeof msg !== 'object') return;
  try {
    if (msg.type === 'ping') parentSend({ type: 'pong' });
    else if (msg.type === 'session.start') sessionStart();
    else if (msg.type === 'session.stop') sessionStop();
    else if (msg.type === 'audio') { if (stt) stt.feed(msg.delta); }
  } catch (e) {
    log('ears', 'ipc err', e.message);
    parentSend({ type: 'error', error: e.message });
  }
});

process.on('uncaughtException', function (e) {
  log('ears', 'uncaught', e.message);
  parentSend({ type: 'error', error: e.message });
});
process.on('unhandledRejection', function (e) {
  log('ears', 'unhandled', (e && e.message) || String(e));
});

log('ears', 'process up pid', process.pid);
parentSend({ type: 'ready' });
parentSend({ type: 'status', ready: false });

module.exports = { GrokStt, stripPrevUtterance, restStt };
