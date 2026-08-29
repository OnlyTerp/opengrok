#!/usr/bin/env node
'use strict';
// Voice-v5 captain. Isolated process: OpenAI realtime TEXT ONLY.
// output_modalities: ['text']. Never set audio.input. Skip audio.delta.
// Speakable text from output_text, output_audio_transcript, AND response.done.
const tls = require('tls');
const http = require('http');
const crypto = require('crypto');
const { log, readCodexToken, resolveConsult, parentSend, CONSULT_DEFAULT } = require('./lib/shared.cjs');
const { FrameDecoder, armSocketIdle, wsSendPing, wsSendPong } = require('./lib/ws-raw.cjs');

const HOSTNAME = 'api.openai.com';
const REALTIME_PATH = '/v1/realtime?model=gpt-realtime-2.1';
const FALLBACK_SPEAK = 'still here, say that again';

const LIFEOS_HOST = process.env.VOICE_CONTEXT_HOST || '';
const LIFEOS_PORT = Number(process.env.VOICE_CONTEXT_PORT || 0);
const LIFEOS_KEY_FILE = process.env.VOICE_CONTEXT_KEY_FILE || '';
const LIFEOS_EVENTS_PATH = process.env.VOICE_CONTEXT_PATH || '/events';

function readLifeosKey() {
  try { return require('fs').readFileSync(LIFEOS_KEY_FILE, 'utf8').trim(); }
  catch (e) { return ''; }
}

function parsePayload(r) {
  let p = r && r.payload;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (e) { p = {}; }
  }
  if (!p || typeof p !== 'object') p = {};
  return p;
}

function isChatRow(r, p) {
  if (r.event_type === 'dictation') return false;
  if (r.event_type === 'guild_message') return true;
  if (p.engine) return false;
  return !!(p.author_name && p.text);
  return false;
}

function isVoiceRow(r, p) {
  if (r.event_type === 'dictation') return true;
  if (p.engine && (p.text || r.summary)) return true;
  return false;
}

function fetchStreamContext(cb) {
  const key = readLifeosKey();
  if (!LIFEOS_HOST) return cb(new Error('no live context configured (set VOICE_CONTEXT_HOST / VOICE_CONTEXT_PORT)'));
  if (!key) return cb(new Error('no context key (set VOICE_CONTEXT_KEY_FILE)'));
  const req = http.get({
    host: LIFEOS_HOST, port: LIFEOS_PORT, path: LIFEOS_EVENTS_PATH,
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }
  }, function (res) {
    const chunks = [];
    res.on('data', function (d) { chunks.push(d); });
    res.on('end', function () {
      let rows = [];
      try { rows = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { return cb(new Error('lifeos nonjson')); }
      if (!Array.isArray(rows)) return cb(new Error('lifeos bad shape'));
      const chat = [];
      const voice = [];
      const seenChat = {};
      const seenVoice = {};
      rows.forEach(function (r) {
        const p = parsePayload(r);
        const text = String((p && p.text) || r.summary || '').trim();
        if (!text) return;
        if (isChatRow(r, p)) {
          const id = p.msg_id || r.dedupe_key || r.id || text;
          if (seenChat[id]) return;
          seenChat[id] = true;
          const author = p.author_name || '?';
          const body = p.text || text.replace(/^[^:]+:\s*/, '');
          chat.push(author + ': ' + body);
        } else if (isVoiceRow(r, p)) {
          const id = r.dedupe_key || r.id || text;
          if (seenVoice[id]) return;
          seenVoice[id] = true;
          voice.push('you said: ' + (p.text || text));
        }
      });
      const missing = chat.length === 0;
      log('captain', 'stream.context metrics',
        'chat=' + chat.length,
        'voice=' + voice.length,
        'rows=' + rows.length,
        missing ? 'CHAT_MISSING' : 'chat_ok');
      const out = [];
      if (chat.length) out.push('LIVE CHAT (most recent first):\n' + chat.slice(0, 20).join('\n'));
      else out.push('LIVE CHAT: no chat lines in the last ' + rows.length + ' events (only dictation). Ingest may be down.');
      if (voice.length) out.push('YOU (most recent first):\n' + voice.slice(0, 6).join('\n'));
      cb(null, out.join('\n\n'));
    });
  });
  req.on('error', function (e) { cb(e); });
  req.setTimeout(5000, function () { try { req.destroy(); } catch (e) {} cb(new Error('lifeos timeout')); });
}

const DESK_INSTRUCTIONS =
  'Speak American English. You are the user\'s live captain on a voice call. Stay on the line. Sharp, technically fluent, like a senior friend on a call. Answer for real. Never mention being interrupted or that you stopped talking. Just answer what the user just said. ROUTING: use the consult_agent tool, cheap/fast assistants first. If you need tools, say a short \"one second\" and consult_agent. Do not pretend. Stay on the line. If the user talks while a consult is waiting, KEEP LISTENING and answer them - do not freeze, do not cancel the consult, do not dump their chatter as another consult unless they explicitly ask you to consult again. When a consult result arrives, speak it in your own voice even if you talked in between. dispatch_agent only for real work the user asked you to execute (files, implementation). NEVER dispatch greetings, say-hi, or small talk.';

const TEACH_INSTRUCTIONS =
  'You are the user\'s teaching partner. A screen recording is running. Speak American English. Be concise. Help the user narrate what they are doing. Remember details they say. Ask one short clarifying question if the skill would be incomplete. Do not dispatch work or start other agents. This is a lesson, not a job.';

function isAudioDeltaType(t) {
  return t === 'response.output_audio.delta' || t === 'response.audio.delta';
}

function isTextDeltaType(t) {
  return t === 'response.output_text.delta' || t === 'response.text.delta' ||
    t === 'response.output_audio_transcript.delta' || t === 'response.audio_transcript.delta';
}

function isOutputDoneType(t) {
  return t === 'response.output_text.done' || t === 'response.text.done' ||
    t === 'response.output_audio_transcript.done' || t === 'response.audio_transcript.done' ||
    t === 'response.output_audio.done' || t === 'response.output_item.done' ||
    t === 'response.content_part.done' || t === 'response.done';
}

function extractDoneText(j) {
  if (!j) return '';
  if (typeof j.transcript === 'string' && j.transcript.trim()) return j.transcript.trim();
  if (typeof j.text === 'string' && j.text.trim()) return j.text.trim();
  const item = j.item;
  if (item && item.formatted && typeof item.formatted.transcript === 'string' && item.formatted.transcript.trim()) {
    return item.formatted.transcript.trim();
  }
  if (item && Array.isArray(item.content)) {
    const fromItem = item.content.map(function (c) {
      return (c && (c.text || c.transcript || c.output_text)) || '';
    }).join('').trim();
    if (fromItem) return fromItem;
  }
  if (j.response && Array.isArray(j.response.output)) {
    return j.response.output.map(function (out) {
      if (!out) return '';
      if (typeof out.text === 'string') return out.text;
      if (typeof out.transcript === 'string') return out.transcript;
      if (Array.isArray(out.content)) {
        return out.content.map(function (c) {
          return (c && (c.text || c.transcript || c.output_text)) || '';
        }).join('');
      }
      return '';
    }).join('').trim();
  }
  return '';
}

class Captain {
  constructor(mode) {
    this.mode = mode === 'teach' ? 'teach' : 'desk';
    this.closed = false;
    this.pending = '';
    this.spoken = '';
    this._responding = false;
    this._consultWaiting = false;
    this._consult = null;
    this._sawDelta = false;
    this.dispatched = new Set();
    this.lastDispatchTask = '';
    this.lastDispatchAt = 0;
    this.socket = null;
    this._onSessionCreated = null;
    this._awaitingCreated = false;
    this._createdTimer = null;
    this._textTimer = null;
    this._flushedThisResponse = false;
    this._live = false;
    this._connecting = null;
    this._ensuring = false;
    this._outbox = [];
    this._ka = null;
    this._idle = null;
    this._lastSpoken = '';
    this._spokenThisResponse = [];
    this._firstSpoken = false;
    this._restBatch = '';
    this._consultTimer = null;
  }
  isBusy() {
    return !!(this._responding && !this._consultWaiting);
  }
  socketLive() {
    return !!(this.socket && this._live && !this.closed);
  }
  connect() {
    const self = this;
    this.closed = false;
    this._live = false;
    if (this._connecting) return this._connecting;
    this._connecting = new Promise(function (resolve, reject) {
      const key = crypto.randomBytes(16).toString('base64');
      let token;
      try { token = readCodexToken(); } catch (e) { self._connecting = null; return reject(e); }
      const req = 'GET ' + REALTIME_PATH + ' HTTP/1.1\r\nHost: ' + HOSTNAME + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ' + token + '\r\n\r\n';
      const socket = tls.connect({ host: HOSTNAME, port: 443, servername: HOSTNAME }, function () { socket.write(req); });
      self.socket = socket;
      if (self._idle) { try { self._idle.clear(); } catch (e) {} }
      // Idle 900s. Do not 20s-kill a quiet call. Ping keepalive keeps it honest.
      self._idle = armSocketIdle(socket, 'openai', function () {
        log('captain', 'openai idle-timeout; destroy for reconnect');
        try { socket.destroy(); } catch (e) {}
      }, log);
      let settled = false;
      const dec = new FrameDecoder(function (opcode, payload) { self.onFrame(opcode, payload); });
      let buf = Buffer.alloc(0);
      const readyTimer = setTimeout(function () {
        if (!settled) { settled = true; self._connecting = null; reject(new Error('captain session.created timeout')); }
      }, 8000);
      self._onSessionCreated = function () {
        if (!settled) { settled = true; clearTimeout(readyTimer); self._connecting = null; resolve(); }
      };
      socket.on('data', function (d) {
        if (!socket.__upgraded) {
          buf = Buffer.concat([buf, d]);
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const head = buf.slice(0, idx).toString();
          if (!/101/.test(head.split('\r\n')[0])) {
            socket.destroy();
            if (!settled) { settled = true; clearTimeout(readyTimer); self._connecting = null; reject(new Error('handshake: ' + head.split('\r\n')[0])); }
            return;
          }
          socket.__upgraded = true;
          socket.removeAllListeners('data');
          socket.on('data', function (dd) { dec.push(dd); });
          const rest = buf.slice(idx + 4);
          self.sendSessionUpdate();
          if (rest.length) dec.push(rest);
        }
      });
      socket.on('error', function (e) {
        if (!settled) { settled = true; clearTimeout(readyTimer); self._connecting = null; reject(e); }
        else log('captain', 'socket error', e.message);
      });
      socket.on('close', function () {
        if (self.socket === socket) {
          self.socket = null;
          self._live = false;
        }
        if (!self.closed) {
          parentSend({ type: 'status', ready: false, responding: false });
          log('captain', 'socket closed; will reconnect on next utterance');
        }
      });
    });
    return this._connecting;
  }
  ensureLive() {
    if (this.socketLive()) return Promise.resolve();
    if (this.closed) this.closed = false;
    return this.connect();
  }
  sendSessionUpdate() {
    const teach = this.mode === 'teach';
    // TEXT ONLY. Omit audio.input entirely so OpenAI does not stay on audio-out.
    // English is pinned in instructions, not a session field OpenAI rejects.
    const session = {
      type: 'realtime',
      model: 'gpt-realtime-2.1',
      reasoning: { effort: 'high' },
      instructions: teach ? TEACH_INSTRUCTIONS : DESK_INSTRUCTIONS,
      tools: teach ? [] : [{
        type: 'function',
        name: 'consult_agent',
        description: 'Ask another configured assistant a question and wait for their answer. Stay on this call. Default is the cheap/fast assistant. Reserve expensive assistants for real build/bugfix work. Do not call again for small talk while a consult is already waiting.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'What to ask the other agent' },
            agent: { type: 'string', description: 'Optional assistant name from your configured roster (VOICE_CONSULT_ROSTER). Omit the argument for the default.' }
          },
          required: ['question']
        }
      }, {
        type: 'function',
        name: 'dispatch_agent',
        description: 'Hand a real task to a Grok Bot agent to execute. Not for questions or greetings.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Clear task for the agent' },
            agent: { type: 'string', description: 'Optional agent name. Default is the selected sidebar agent.' }
          },
          required: ['task']
        }
      }, {
        type: 'function',
        name: 'read_stream_context',
        description: 'Read live context from your configured events source (VOICE_CONTEXT_* env): what chat is saying right now and recent dictations. Use when the user asks what chat is saying, did anyone react, or what they just said. Fast, local, no consult needed.',
        parameters: {
          type: 'object',
          properties: {
            minutes: { type: 'number', description: 'Optional. How far back to look (default: recent 30 events).' }
          }
        }
      }],
      output_modalities: ['text']
    };
    this.wsSend(JSON.stringify({ type: 'session.update', session: session }));
    log('captain', 'session.update text-only no-audio.input');
  }
  wsSend(payload) {
    const payloadBuf = Buffer.from(payload);
    const len = payloadBuf.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payloadBuf);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    if (!this.closed && this.socket) {
      try { this.socket.write(Buffer.concat([header, mask, masked])); return true; } catch (e) { return false; }
    }
    return false;
  }
  markDead() {
    this._live = false;
    if (this._ka) { try { clearInterval(this._ka); } catch (e) {} this._ka = null; }
    if (this._idle) { try { this._idle.clear(); } catch (e) {} }
    const sock = this.socket;
    this.socket = null;
    if (sock) { try { sock.destroy(); } catch (e) {} }
  }
  onFrame(opcode, payload) {
    if (opcode === 0x9) {
      wsSendPong(this.socket, payload);
      if (this._idle && this._idle.touch) this._idle.touch();
      return;
    }
    if (opcode === 0xA) {
      if (this._idle && this._idle.touch) this._idle.touch();
      return;
    }
    if (opcode === 0x8) { this.markDead(); return; }
    if (opcode !== 1) return;
    if (payload && payload.length > 400) {
      const head = payload.toString('utf8', 0, Math.min(96, payload.length));
      if (head.indexOf('output_audio.delta') !== -1 || (head.indexOf('"audio.delta"') !== -1 && head.indexOf('transcript') === -1)) {
        return;
      }
    }
    let j;
    try { j = JSON.parse(payload.toString()); } catch (e) { return; }
    const t = j.type || '';
    if (isAudioDeltaType(t)) return;

    if (t === 'session.created') {
      log('captain', 'session.created', this.mode);
      this._live = true;
      this.armKeepalive();
      if (this._onSessionCreated) this._onSessionCreated();
      return;
    }
    if (t === 'session.updated') { log('captain', 'session.updated'); return; }
    if (t === 'response.created') {
      this._ignoreCancelled = false;
      this._awaitingCreated = false;
      if (this._createdTimer) { clearTimeout(this._createdTimer); this._createdTimer = null; }
      this._responding = true;
      this._flushedThisResponse = false;
      parentSend({ type: 'status', ready: true, responding: true });
      return;
    }
    if (t === 'response.cancelled') {
      this._responding = false;
      this.pending = '';
      this.clearTextTimer();
      parentSend({ type: 'status', ready: true, responding: false });
      return;
    }
    if (isTextDeltaType(t)) {
      if (this._ignoreCancelled) return;
      const bit = j.delta || j.text || '';
      if (!this._sawDelta) { this._sawDelta = true; log('captain', 'delta.type', t); }
      if (bit) {
        this.pending += bit;
        parentSend({ type: 'transcript.delta', delta: bit });
        this.flushSentences(false);
      }
      return;
    }
    if (isOutputDoneType(t)) {
      if (this._ignoreCancelled) {
        if (t === 'response.done' || t === 'response.cancelled') this._ignoreCancelled = false;
        return;
      }
      // Never re-extract the full transcript after we already spoke. That replayed
      // the same sentences (and fragments like "roll.") on output_text.done.
      if (this._flushedThisResponse && !this.pending.trim() && !this._restBatch) {
        log('captain', 'output.done', t, 'already-flushed');
      } else {
        if (!this._flushedThisResponse && !this.pending.trim() && !this._restBatch) {
          const extra = extractDoneText(j);
          if (extra) this.pending = extra;
        }
        log('captain', 'output.done', t, 'pending', this.pending.length, 'rest', (this._restBatch || '').length);
        this.flushSentences(true);
      }
      if (t === 'response.done') {
        this._responding = false;
        this.clearTextTimer();
        parentSend({ type: 'status', ready: true, responding: false });
        parentSend({ type: 'response.done' });
      }
      return;
    }
    if (t === 'response.function_call_arguments.done') {
      this.onTool(j);
      return;
    }
    if (t === 'error') {
      const code = (j.error && j.error.code) || j.code || '';
      if (code === 'response_cancel_not_active' || /no active response/i.test(String((j.error && j.error.message) || j.message || ''))) {
        log('captain', 'cancel-not-active ignore');
        return;
      }
      log('captain', 'realtime error', JSON.stringify(j.error || j).slice(0, 400));
      parentSend({ type: 'state', state: 'error', error: (j.error && j.error.message) || 'realtime error' });
      return;
    }
    if (t && /(?:transcript|output_text|text)\.delta$/.test(t)) {
      const bit = j.delta || j.text || '';
      if (bit) {
        this.pending += bit;
        parentSend({ type: 'transcript.delta', delta: bit });
        this.flushSentences(false);
      }
      return;
    }
    if (t && !/delta|rate_limits/.test(t)) log('captain', 'rt', t, JSON.stringify(j).slice(0, 180));
  }
  onTool(j) {
    const name = j.name;
    const argsRaw = j.arguments || '{}';
    const callId = j.call_id || '';
    let args = {};
    try { args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : (argsRaw || {}); } catch (e) { args = {}; }
    if (name === 'consult_agent') {
      const question = String(args.question || args.task || argsRaw || '').trim();
      const who = resolveConsult(args.agent);
      const fp = require('crypto').createHash('sha1').update(String(who.id || '') + '\n' + question.toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 16);
      const open = this._consult;
      const pending = !!(this._consultWaiting && open && (open.status === 'queued' || open.status === 'in_progress'));
      if (pending) {
        const same = open.fp === fp;
        log('captain', 'consult.skip already-waiting', same ? 'same-fp' : 'other', who.name, question.slice(0, 120), 'id', open.id);
        if (callId) {
          this.wsSend(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: true, waiting: true, already: true, consult_id: open.id, status: open.status, note: 'consult already in flight; keep talking; do not start another' }) } }));
          if (!this._responding) {
            this._responding = true;
            this.wsSend(JSON.stringify({ type: 'response.create' }));
          }
        }
        return;
      }
      const consultId = 'c_' + Date.now().toString(36);
      this._consult = { id: consultId, fp: fp, agent: who.name, agentId: who.id, question: question, startedAt: Date.now(), status: 'in_progress' };
      this._consultWaiting = true;
      this._responding = false;
      log('captain', 'consult.queued', consultId, who.name, who.id, question.slice(0, 160));
      parentSend({ type: 'status', ready: true, responding: false, consultWaiting: true, consultId: consultId, consultStatus: 'in_progress' });
      parentSend({ type: 'consult', question: question, agent: who.name, agentId: who.id, consultId: consultId, status: 'in_progress' });
      parentSend({ type: 'dispatch', task: '[voice-consult] @' + who.name + ': ' + question, agent: who.name, agentId: who.id, consultId: consultId });
      if (callId) {
        this.wsSend(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: true, waiting: true, agent: who.name, agentId: who.id, consult_id: consultId, status: 'in_progress' }) } }));
      }
      return;
    }
    if (name === 'dispatch_agent') {
      const task = String(args.task || '').trim();
      const now = Date.now();
      const dup = (callId && this.dispatched.has(callId)) || (task && task === this.lastDispatchTask && now - this.lastDispatchAt < 4000);
      if (callId) this.dispatched.add(callId);
      if (!dup && task) {
        this.lastDispatchTask = task;
        this.lastDispatchAt = now;
        log('captain', 'dispatch', task.slice(0, 200));
        parentSend({ type: 'dispatch', task: task, agent: args.agent || '' });
      } else log('captain', 'dispatch-dup', task.slice(0, 120));
      if (callId) {
        this.wsSend(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: true, handed_off: !dup }) } }));
        if (!this._responding) {
          this._responding = true;
          this.wsSend(JSON.stringify({ type: 'response.create' }));
        }
      }
    }
    if (name === 'read_stream_context') {
      const self = this;
      log('captain', 'stream.context fetch');
      fetchStreamContext(function (err, text) {
        if (err) {
          log('captain', 'stream.context fail', err.message);
          text = 'Stream context unavailable right now (' + err.message + ').';
        }
        log('captain', 'stream.context ok', String(text).slice(0, 120));
        if (callId) {
          self.wsSend(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: true, context: text }) } }));
          if (!self._responding) {
            self._responding = true;
            self.wsSend(JSON.stringify({ type: 'response.create' }));
          }
        }
      });
      return;
    }
  }
  flushSentences(force) {
    // Never flush mid-reply. One generation per answer.
    // First-sentence flush still seamed the clone (R6).
    const re = /[.!?]\s+/;
    while (true) {
      const m = this.pending.match(re);
      if (!m) break;
      const end = m.index + m[0].length;
      const sentence = this.pending.slice(0, end).trim();
      this.pending = this.pending.slice(end);
      if (!sentence || sentence.length < 2) continue;
      this._restBatch = (this._restBatch ? this._restBatch + ' ' : '') + sentence;
    }
    if (force) {
      const tail = ((this._restBatch || '') + ' ' + (this.pending || '')).trim();
      this._restBatch = '';
      this.pending = '';
      if (tail) {
        this.enqueueSpeak(tail);
        this._firstSpoken = true;
      }
    }
  }
  alreadySpoken(norm) {
    if (!norm) return true;
    if (this._lastSpoken && this._lastSpoken === norm) return true;
    const said = this._spokenThisResponse || [];
    if (said.indexOf(norm) !== -1) return true;
    const joined = said.join(' ');
    if (joined && joined.indexOf(norm) !== -1) return true;
    if (norm.length < 24) {
      for (let i = 0; i < said.length; i++) {
        if (said[i].indexOf(norm) !== -1) return true;
      }
    }
    return false;
  }
  enqueueSpeak(text) {
    if (!text) return;
    const norm = String(text).trim();
    if (!norm) return;
    if (this.alreadySpoken(norm)) {
      log('captain', 'mouth.skip-dup', norm.slice(0, 80));
      return;
    }
    this._lastSpoken = norm;
    if (!this._spokenThisResponse) this._spokenThisResponse = [];
    this._spokenThisResponse.push(norm);
    this._flushedThisResponse = true;
    this.clearTextTimer();
    log('captain', 'mouth.enqueue', norm.slice(0, 80));
    parentSend({ type: 'speak', text: norm });
    this.spoken = (this.spoken + ' ' + norm).slice(-2000);
  }
  speakFallback(why) {
    log('captain', 'fallback.speak', why || '', FALLBACK_SPEAK);
    this.enqueueSpeak(FALLBACK_SPEAK);
    parentSend({ type: 'transcript.delta', delta: FALLBACK_SPEAK });
    parentSend({ type: 'response.done' });
    parentSend({ type: 'status', ready: true, responding: false });
  }
  barge() {
    if (this._consultWaiting && !this._responding) {
      log('captain', 'barge.skip consult-wait-no-mouth');
      return;
    }
    this._ignoreCancelled = true;
    this.pending = '';
    this._restBatch = '';
    this._firstSpoken = false;
    this._spokenThisResponse = [];
    this._flushedThisResponse = false;
    this._awaitingCreated = false;
    this.clearCreatedTimer();
    this.clearTextTimer();
    if (this._responding && !this.closed) {
      try { this.wsSend(JSON.stringify({ type: 'response.cancel' })); } catch (e) {}
      this._responding = false;
    }
    parentSend({ type: 'barge' });
    parentSend({ type: 'status', ready: true, responding: false });
    log('captain', 'barge response.cancel drop-pending');
  }
  consultResult(text, meta) {
    let body = String(text || '').trim();
    let status = (meta && meta.status) || 'completed';
    let consultId = (meta && (meta.consult_id || meta.consultId)) || (this._consult && this._consult.id) || '';
    let err = (meta && meta.error) || '';
    if (body.charAt(0) === '{') {
      try {
        const env = JSON.parse(body);
        if (env && (env.status || env.answer || env.consult_id || env.error)) {
          status = env.status || status;
          consultId = env.consult_id || env.consultId || consultId;
          err = env.error || err;
          if (env.answer || env.text || env.result) body = String(env.answer || env.text || env.result || '');
        }
      } catch (e) {}
    }
    status = String(status || 'completed').toLowerCase().replace(/[\s-]+/g, '_');
    if (status === 'queued' || status === 'in_progress') {
      if (this._consult) this._consult.status = status;
      this._consultWaiting = true;
      parentSend({ type: 'status', ready: true, consultWaiting: true, consultId: consultId, consultStatus: status });
      log('captain', 'consult.status', status, consultId || '-');
      return;
    }
    const started = this._consult && this._consult.startedAt ? this._consult.startedAt : 0;
    const rtt = started ? (Date.now() - started) : 0;
    this._consultWaiting = false;
    if (this._consult) this._consult.status = status;
    parentSend({ type: 'status', ready: true, consultWaiting: false, consultId: consultId, consultStatus: status, consultRttMs: rtt });
    if (status === 'failed') {
      log('captain', 'consult.fail', 'id', consultId || '-', 'rtt_ms=' + rtt, (err || body).slice(0, 120));
      this._consult = null;
      return;
    }
    if (!body) {
      log('captain', 'consult.fail empty-completed', 'id', consultId || '-', 'rtt_ms=' + rtt);
      this._consult = null;
      return;
    }
    log('captain', 'consult.completed', 'id', consultId || '-', 'rtt_ms=' + rtt, body.slice(0, 80));
    this._consult = null;
    this.userText('Here is the answer. Say it naturally. Do not mention a consult, retry, or that you were waiting. ' + body);
  }
  clearCreatedTimer() {
    if (this._createdTimer) { clearTimeout(this._createdTimer); this._createdTimer = null; }
  }
  clearTextTimer() {
    if (this._textTimer) { clearTimeout(this._textTimer); this._textTimer = null; }
  }
  _sendUserNow(text, isRetry) {
    if (this._responding && !this._consultWaiting) {
      try { this.wsSend(JSON.stringify({ type: 'response.cancel' })); } catch (e) {}
      this._responding = false;
    }
    const okItem = this.wsSend(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: text }] } }));
    this._responding = true;
    this._awaitingCreated = true;
    this._flushedThisResponse = false;
    this._lastSpoken = '';
    this._spokenThisResponse = [];
    this._firstSpoken = false;
    this._restBatch = '';
    const okCreate = this.wsSend(JSON.stringify({ type: 'response.create' }));
    parentSend({ type: 'status', ready: true, responding: true });
    if (!okItem || !okCreate) {
      log('captain', 'wsSend failed; treat socket dead');
      this.markDead();
      if (!isRetry) {
        const self = this;
        this.ensureLive().then(function () { self._sendUserNow(text, true); }).catch(function (e) {
          log('captain', 'retry connect fail', e.message);
          self.speakFallback('reconnect-fail');
        });
      } else {
        this.speakFallback('wsSend-fail-after-retry');
      }
      return;
    }
    const self = this;
    this.clearCreatedTimer();
    this._createdTimer = setTimeout(function () {
      self._createdTimer = null;
      if (!self._awaitingCreated) return;
      self._awaitingCreated = false;
      self._responding = false;
      parentSend({ type: 'status', ready: true, responding: false });
      log('captain', 'created-timeout no response.created in 8s', isRetry ? 'after-retry' : 'first');
      if (!isRetry) {
        log('captain', 'created-timeout retry reconnect');
        self.markDead();
        self.userText(text, true);
      } else {
        self.speakFallback('created-timeout-after-retry');
      }
    }, 8000);
    this.clearTextTimer();
    this._textTimer = setTimeout(function () {
      self._textTimer = null;
      if (self._flushedThisResponse || self.pending.trim()) {
        if (self.pending.trim()) self.flushSentences(true);
        return;
      }
      if (!self._responding && !self._awaitingCreated) return;
      // ChatGPT law C2: tool-wait is SILENT. No fallback speech on a slow reply.
      // A long silent gap made users think the assistant died and asked to retry;
      // heard. If the model never answers, the next utterance just starts a new turn.
      log('captain', 'no-text 20s silent-wait (no fallback speech)');
    }, 20000);
  }
  userText(text, isRetry) {
    if (!text || !String(text).trim()) return;
    const body = String(text).trim();
    if (this._consultWaiting) log('captain', 'consult.wait.user', body.slice(0, 80));
    const self = this;
    if (this._ensuring) {
      this._outbox.push({ text: body, isRetry: !!isRetry });
      if (this._outbox.length > 8) this._outbox.shift();
      log('captain', 'outbox', body.slice(0, 60), 'n', this._outbox.length);
      return;
    }
    const dead = !this.socketLive();
    if (dead) log('captain', 'reconnect before utterance', isRetry ? 'retry' : 'first');
    this._ensuring = true;
    this.ensureLive().then(function () {
      self._ensuring = false;
      log('captain', dead ? 'reconnected; sending' : 'live; sending', body.slice(0, 60));
      parentSend({ type: 'status', ready: true, responding: false });
      self._sendUserNow(body, !!isRetry);
      const rest = (self._outbox || []).splice(0);
      rest.forEach(function (item) { self.userText(item.text, item.isRetry); });
    }).catch(function (e) {
      self._ensuring = false;
      log('captain', 'reconnect fail', e.message);
      self.speakFallback('reconnect-fail');
    });
  }
  armKeepalive() {
    const self = this;
    if (this._ka) clearInterval(this._ka);
    this._ka = setInterval(function () {
      if (self.closed || !self.socket) return;
      if (self._idle && self._idle.touch) self._idle.touch();
      try { wsSendPing(self.socket); } catch (e) {}
    }, 15000);
  }
  stop() {
    if (this._ka) { clearInterval(this._ka); this._ka = null; }
    this.closed = true;
    this.pending = '';
    this._outbox = [];
    this._connecting = null;
    this._ensuring = false;
    this._live = false;
    this.clearCreatedTimer();
    this.clearTextTimer();
    this._awaitingCreated = false;
    if (this._idle) { try { this._idle.clear(); } catch (e) {} this._idle = null; }
    try { if (this.socket) this.socket.destroy(); } catch (e) {}
    this.socket = null;
  }
}

let captain = null;
let pendingConsult = null;

function flushPendingConsult() {
  if (!pendingConsult || !captain) return;
  const m = pendingConsult;
  pendingConsult = null;
  log('captain', 'consult.result flush-after-session', String((m && m.consult_id) || ''));
  captain.consultResult((m && (m.text || m.answer)) || '', m);
}

function sessionStart(mode) {
  if (captain) { try { captain.stop(); } catch (e) {} }
  captain = new Captain(mode);
  captain.connect().then(function () {
    log('captain', 'session ready', captain.mode);
    parentSend({ type: 'session.ready' });
    parentSend({ type: 'status', ready: true, responding: false });
    flushPendingConsult();
  }).catch(function (e) {
    log('captain', 'session fail', e.message);
    parentSend({ type: 'session.error', error: e.message || 'captain failed' });
    parentSend({ type: 'status', ready: false });
  });
}

function sessionStop() {
  if (captain) { try { captain.stop(); } catch (e) {} captain = null; }
  parentSend({ type: 'status', ready: false, responding: false });
}

function onIpc(msg) {
  if (!msg || typeof msg !== 'object') return;
  try {
    if (msg.type === 'ping') parentSend({ type: 'pong' });
    else if (msg.type === 'session.start') sessionStart(msg.mode);
    else if (msg.type === 'session.stop') sessionStop();
    else if (msg.type === 'userText') {
      if (captain) captain.userText(msg.text);
      else {
        log('captain', 'userText before session; boot desk and queue');
        sessionStart('desk');
        if (captain) captain.userText(msg.text);
      }
    } else if (msg.type === 'consult.result') {
      if (captain) captain.consultResult(msg.text, msg);
      else {
        pendingConsult = msg;
        log('captain', 'consult.result queued-no-session', String((msg && msg.consult_id) || ''));
        sessionStart('desk');
      }
    }
    else if (msg.type === 'agent.update') {
      if (captain) {
        if (captain._consultWaiting) captain.consultResult(msg.text);
        else captain.userText('Agent update: ' + (msg.text || ''));
      }
    } else if (msg.type === 'barge') { if (captain) captain.barge(); }
  } catch (e) {
    log('captain', 'ipc err', e.message);
    parentSend({ type: 'error', error: e.message });
  }
}

process.on('message', onIpc);

process.on('uncaughtException', function (e) {
  log('captain', 'uncaught', e.message);
  parentSend({ type: 'error', error: e.message });
});
process.on('unhandledRejection', function (e) {
  log('captain', 'unhandled', (e && e.message) || String(e));
});

log('captain', 'process up pid', process.pid, 'default-consult', CONSULT_DEFAULT.id);
parentSend({ type: 'ready' });
parentSend({ type: 'status', ready: false, responding: false });

module.exports = {
  Captain, isTextDeltaType, isOutputDoneType, extractDoneText, isAudioDeltaType,
  FALLBACK_SPEAK, onIpc, sessionStart, sessionStop
};
