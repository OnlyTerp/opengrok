#!/usr/bin/env node
'use strict';
// Voice mouth. Isolated process: ElevenLabs TTS only.
// enqueueSpeak MUST run. pcm_24000 out. Barge = stop queue + bump gen.
const https = require('https');
const {
  log, readElevenKey, hasElevenKey, trimSeam, parentSend,
  EL_VOICE, EL_MODEL, EL_RATE, EL_PRONUNCIATION
} = require('./lib/shared.cjs');

function elevenSpeak(text, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts = opts || {};
  const key = readElevenKey();
  const body = {
    text: text,
    model_id: EL_MODEL,
    voice_settings: {
      stability: 0.45,
      similarity_boost: 0.85,
      style: 0.2,
      use_speaker_boost: true,
      speed: 1.0
    },
    apply_text_normalization: 'auto',
    language_code: 'en',
    pronunciation_dictionary_locators: EL_PRONUNCIATION
  };
  if (opts.previousText) body.previous_text = opts.previousText;
  if (opts.previousReqId) body.previous_request_ids = [opts.previousReqId];
  const payload = Buffer.from(JSON.stringify(body));
  const req = https.request({
    hostname: 'api.elevenlabs.io',
    path: '/v1/text-to-speech/' + EL_VOICE + '/stream?output_format=pcm_24000',
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'content-type': 'application/json',
      accept: 'application/octet-stream',
      'content-length': payload.length
    }
  }, function (res) {
    const chunks = [];
    res.on('data', function (d) { chunks.push(d); });
    res.on('end', function () {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const err = Buffer.concat(chunks).toString('utf8').slice(0, 240);
        return elDone(new Error('elevenlabs ' + res.statusCode + ' ' + err));
      }
      const ctype = String(res.headers['content-type'] || '');
      if (/mpeg|mp3|aac|json/i.test(ctype)) {
        return elDone(new Error('elevenlabs returned ' + ctype + ' not pcm'));
      }
      let pcm = Buffer.concat(chunks);
      if (pcm.length >= 3 && pcm[0] === 0x49 && pcm[1] === 0x44 && pcm[2] === 0x33) {
        return elDone(new Error('elevenlabs returned mp3/id3 not pcm'));
      }
      if (pcm.length % 2) pcm = pcm.slice(0, pcm.length - 1);
      pcm = trimSeam(pcm, 60);
      elDone(null, pcm, res.headers['request-id'] || null);
    });
  });
  let elSettled = false;
  function elDone(err, pcm, id) {
    if (elSettled) return;
    elSettled = true;
    cb(err, pcm, id);
  }
  req.on('error', function (e) { elDone(e); });
  req.setTimeout(20000, function () { try { req.destroy(); } catch (e) {} elDone(new Error('elevenlabs timeout')); });
  req.write(payload);
  req.end();
}

const state = {
  queue: [],
  speaking: false,
  speakGen: 0,
  lastElReqId: null,
  spoken: '',
  closed: false
};

function setSpeaking(v) {
  state.speaking = !!v;
  parentSend({ type: 'status', ready: true, speaking: state.speaking });
}

function enqueueSpeak(text) {
  text = String(text || '').trim();
  if (!text) return;
  // ChatGPT law C2/C3: one continuous mouth. Never shift() a queued reply
  // (that ate the real first sentence). Cap high; a multi-part reply must not drop.
  if (state.queue.length >= 32) state.queue.shift();
  state.queue.push(text);
  log('mouth', 'enqueue', text.slice(0, 80), 'q', state.queue.length);
  pumpSpeak();
}

function pumpSpeak() {
  if (state.speaking || !state.queue.length || state.closed) return;
  const text = state.queue.shift();
  const gen = state.speakGen;
  setSpeaking(true);
  parentSend({ type: 'speak.start', text: text });
  const prev = state.spoken.slice(-400);
  log('mouth', 'el.start', text.slice(0, 80));
  elevenSpeak(text, { previousText: prev || null, previousReqId: state.lastElReqId }, function (err, pcm, reqId) {
    if (state.speakGen !== gen) {
      setSpeaking(false);
      pumpSpeak();
      return;
    }
    if (err) {
      log('mouth', 'el err', err.message);
      setSpeaking(false);
      parentSend({ type: 'error', error: err.message });
      parentSend({ type: 'speak.done', error: err.message });
      pumpSpeak();
      return;
    }
    if (reqId) state.lastElReqId = reqId;
    state.spoken = (state.spoken + ' ' + text).slice(-2000);
    log('mouth', 'el.pcm bytes', pcm.length);
    // One buffer per generation. The UI fades every audio.delta, so 200ms
    // slices were pumping the volume 5 times a second.
    if (state.speakGen !== gen) {
      setSpeaking(false);
      pumpSpeak();
      return;
    }
    parentSend({ type: 'audio.delta', format: 'pcm16', rate: EL_RATE, delta: pcm.toString('base64') });
    const playMs = Math.max(400, Math.ceil(pcm.length / (EL_RATE * 2) * 1000) + 80);
    log('mouth', 'play.hold.ms', playMs);
    setTimeout(function () {
      if (state.speakGen !== gen) return;
      setSpeaking(false);
      parentSend({ type: 'speak.done', requestId: reqId || null, bytes: pcm.length });
      pumpSpeak();
    }, playMs);
  });
}

function bargeStop() {
  state.queue = [];
  state.speakGen = (state.speakGen || 0) + 1;
  setSpeaking(false);
  log('mouth', 'barge stop');
}

process.on('message', function (msg) {
  if (!msg || typeof msg !== 'object') return;
  try {
    if (msg.type === 'ping') parentSend({ type: 'pong', speaking: state.speaking });
    else if (msg.type === 'speak') enqueueSpeak(msg.text);
    else if (msg.type === 'stop' || msg.type === 'barge') bargeStop();
    else if (msg.type === 'session.start') {
      state.closed = false;
      parentSend({ type: 'session.ready' });
      parentSend({ type: 'status', ready: true, speaking: false });
    } else if (msg.type === 'session.stop') {
      bargeStop();
      state.closed = false;
      parentSend({ type: 'status', ready: true, speaking: false });
    }
  } catch (e) {
    log('mouth', 'ipc err', e.message);
    parentSend({ type: 'error', error: e.message });
  }
});

process.on('uncaughtException', function (e) {
  log('mouth', 'uncaught', e.message);
  parentSend({ type: 'error', error: e.message });
});
process.on('unhandledRejection', function (e) {
  log('mouth', 'unhandled', (e && e.message) || String(e));
});

let elReady = false;
try { readElevenKey(); elReady = true; } catch (e) {
  log('mouth', 'el key missing', e.message);
}
log('mouth', 'process up pid', process.pid, 'el=' + elReady, 'voice', EL_VOICE);
parentSend({ type: 'ready', elevenlabs: elReady });
parentSend({ type: 'status', ready: elReady, speaking: false, elevenlabs: elReady });

module.exports = { enqueueSpeak, bargeStop, state, pumpSpeak };
