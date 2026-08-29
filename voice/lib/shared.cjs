#!/usr/bin/env node
'use strict';
// Shared helpers. Secrets come from environment variables or voice/.env (never committed).
// Never log tokens. Never scrape source for keys.
const fs = require('fs');
const path = require('path');
const os = require('os');

// Load voice/.env once at boot so every child (ears/captain/mouth) inherits all
// VOICE_* / ELEVENLABS_* / OPENAI_* / GROK_* keys. Process env always wins.
(function loadDotEnv() {
  const envFile = path.join(__dirname, '..', '.env');
  let txt = '';
  try { txt = fs.readFileSync(envFile, 'utf8'); } catch (e) { return; }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (val && !process.env[m[1]]) process.env[m[1]] = val;
  }
})();

const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || '';
const EL_MODEL = 'eleven_multilingual_v2';
const EL_RATE = 24000;
// Optional ElevenLabs pronunciation dictionary, env: VOICE_ELEVEN_PRONUNCIATION="<id>:<version>"
const EL_PRONUNCIATION = (function () {
  const v = String(process.env.VOICE_ELEVEN_PRONUNCIATION || '').trim();
  if (!v) return [];
  const parts = v.split(':');
  return [{ pronunciation_dictionary_id: parts[0], version_id: parts[1] || '' }];
})();
const STT_RATE = 16000;
const MIC_RATE = 24000;
const RMS_SPEECH = 250;
const SILENCE_MS_TO_FINALIZE = 900;
const MIN_SPEECH_MS_TO_FINALIZE = 1600;
const REST_MIN_SPEECH_MS = 1600;
const STT_CHUNK = 3200; // 100ms pcm16 mono @ 16k
const HERMES_CFG = process.env.VOICE_HERMES_CONFIG || '';
const HERMES_ENV = process.env.VOICE_HERMES_ENV || '';

const CONSULT_DEFAULT = {
  name: process.env.VOICE_CONSULT_DEFAULT_NAME || 'assistant',
  id: process.env.VOICE_CONSULT_DEFAULT_ID || ''
};
const CONSULT_ROSTER = String(process.env.VOICE_CONSULT_ROSTER || '')
  .split(',')
  .map(function (row) {
    const parts = String(row).trim().split('|');
    if (!parts[0]) return null;
    return { name: parts[0].trim(), id: (parts[1] || '').trim(), aliases: parts.slice(2).map(function (a) { return a.trim().toLowerCase(); }) };
  })
  .filter(Boolean);

function resolveConsult(agent) {
  const q = String(agent || '').trim().toLowerCase();
  if (!q) return CONSULT_DEFAULT;
  for (const row of CONSULT_ROSTER) {
    if (row.id.toLowerCase() === q) return { name: row.name, id: row.id };
    if (row.name.toLowerCase() === q) return { name: row.name, id: row.id };
    if (row.aliases.indexOf(q) !== -1) return { name: row.name, id: row.id };
  }
  return CONSULT_DEFAULT;
}

function defaultLogPath() {
  if (process.env.VOICE_V5_LOG) return process.env.VOICE_V5_LOG;
  return path.join(__dirname, '..', 'voice.events.log');
  return path.join(__dirname, '..', 'v5.events.log');
}

const LOG = defaultLogPath();
const _logQ = [];
let _logBusy = false;
function log() {
  _logQ.push(new Date().toISOString() + ' ' + Array.from(arguments).join(' ') + '\n');
  if (!_logBusy) _flushLog();
}
function _flushLog() {
  if (!_logQ.length) { _logBusy = false; return; }
  _logBusy = true;
  const chunk = _logQ.splice(0, _logQ.length).join('');
  try {
    const dir = path.dirname(LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
  fs.appendFile(LOG, chunk, function () { _flushLog(); });
}

function readCodexToken() {
  if (process.env.VOICE_CODEX_TOKEN) return process.env.VOICE_CODEX_TOKEN.trim();
  const cands = [
    path.join(os.homedir(), '.grokbot', 'voice', 'codex-token'),
    path.join(os.homedir(), '.grokbot', 'codex-token'),
    path.join(os.homedir(), '.codex', 'auth.json')
  ];
  for (const p of cands) {
    try { const t = fs.readFileSync(p, 'utf8').trim(); if (t.length > 20) return t; } catch (e) {}
  }
  throw new Error('no OpenAI realtime token. Set VOICE_OPENAI_TOKEN (or VOICE_CODEX_TOKEN), or log in with the Codex CLI so ~/.codex/auth.json exists. See voice/SETUP.md.');
}

function readGrokJwt() {
  const p = process.env.VOICE_GROK_AUTH || path.join(os.homedir(), '.grok', 'auth.json');
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    throw new Error('no Grok/xAI credentials. Set VOICE_GROK_JWT (or GROK_API_KEY), or log in to the Grok CLI so ~/.grok/auth.json exists. See voice/SETUP.md.');
  }
  if (j && typeof j.key === 'string' && j.key.length > 20) return j.key.trim();
  if (j && typeof j === 'object') {
    for (const v of Object.values(j)) {
      if (v && typeof v.key === 'string' && v.key.length > 20) return v.key.trim();
      if (typeof v === 'string' && v.length > 20) return v.trim();
    }
  }
  throw new Error('Grok auth file has no recognizable token/key field. See voice/SETUP.md.');
}

let _elKey = '';
function readElevenKey() {
  if (_elKey) return _elKey;
  if (process.env.ELEVENLABS_API_KEY) return (_elKey = process.env.ELEVENLABS_API_KEY.trim());
  if (process.env.ELEVEN_API_KEY) return (_elKey = process.env.ELEVEN_API_KEY.trim());
  // Optional dotenv-style file next to the voice module (never committed).
  const envFile = path.join(__dirname, '..', '.env');
  try {
    const txt = fs.readFileSync(envFile, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*(ELEVENLABS_API_KEY|ELEVEN_API_KEY|VOICE_[A-Z_]+|OPENAI_|GROK_)\S*\s*=\s*(.+)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
    }
  } catch (e) {}
  if (process.env.ELEVENLABS_API_KEY) return (_elKey = process.env.ELEVENLABS_API_KEY.trim());
  if (process.env.ELEVEN_API_KEY) return (_elKey = process.env.ELEVEN_API_KEY.trim());
  throw new Error('no ElevenLabs key. Set ELEVENLABS_API_KEY or put it in voice/.env. See voice/SETUP.md.');
}

function hasElevenKey() {
  try { readElevenKey(); return true; } catch (e) { return false; }
}

function pcm16_24k_to_16k(buf) {
  if (!buf || buf.length < 6) return Buffer.alloc(0);
  const inSamples = Math.floor(buf.length / 2);
  const groups = Math.floor(inSamples / 3);
  const out = Buffer.alloc(groups * 4);
  for (let g = 0; g < groups; g++) {
    const s0 = buf.readInt16LE((g * 3) * 2);
    const s1 = buf.readInt16LE((g * 3 + 1) * 2);
    const s2 = buf.readInt16LE((g * 3 + 2) * 2);
    out.writeInt16LE(s0, g * 4);
    let mid = Math.round((s1 + s2) / 2);
    if (mid > 32767) mid = 32767;
    if (mid < -32768) mid = -32768;
    out.writeInt16LE(mid, g * 4 + 2);
  }
  return out;
}

function rms16(buf) {
  if (!buf || buf.length < 2) return 0;
  const n = Math.floor(buf.length / 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

function extractSttText(j) {
  if (!j) return '';
  if (typeof j.text === 'string' && j.text.trim()) return j.text.trim();
  if (typeof j.transcript === 'string' && j.transcript.trim()) return j.transcript.trim();
  if (j.alternatives && j.alternatives[0]) {
    const a = j.alternatives[0];
    if (typeof a.transcript === 'string' && a.transcript.trim()) return a.transcript.trim();
    if (typeof a.text === 'string' && a.text.trim()) return a.text.trim();
  }
  return '';
}

function trimSeam(pcm, keepMs) {
  const bytesPerMs = (EL_RATE * 2) / 1000;
  const keep = Math.floor(keepMs * bytesPerMs) & ~1;
  function silent(buf, i) { return Math.abs(buf.readInt16LE(i)) < 180; }
  let start = 0;
  while (start + 2 <= pcm.length && silent(pcm, start)) start += 2;
  start = Math.max(0, start - keep);
  let end = pcm.length - (pcm.length % 2);
  while (end >= 2 && silent(pcm, end - 2)) end -= 2;
  end = Math.min(pcm.length, end + keep);
  if (end <= start) return pcm;
  return pcm.slice(start, end);
}

function appendTeachNote(msg) {
  try {
    const dir = process.platform === 'win32'
      ? path.join(__dirname, '..', 'teach-notes')
      : path.join(__dirname, '..', 'teach-notes');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const id = (msg && msg.agentId) ? String(msg.agentId).replace(/[^a-zA-Z0-9_-]/g, '_') : 'unknown';
    const line = JSON.stringify({ ts: (msg && msg.ts) || new Date().toISOString(), text: (msg && msg.text) || '', agentId: id }) + '\n';
    fs.appendFileSync(path.join(dir, id + '.jsonl'), line);
    log('teach.note', id, ((msg && msg.text) || '').slice(0, 80));
  } catch (e) { log('teach.note fail', e.message); }
}

function parentSend(obj) {
  if (process.send) {
    try { process.send(obj); } catch (e) {}
  }
}

module.exports = {
  EL_VOICE, EL_MODEL, EL_RATE, EL_PRONUNCIATION, STT_RATE, MIC_RATE, RMS_SPEECH,
  SILENCE_MS_TO_FINALIZE, MIN_SPEECH_MS_TO_FINALIZE, REST_MIN_SPEECH_MS, STT_CHUNK,
  HERMES_CFG, HERMES_ENV, CONSULT_DEFAULT, CONSULT_ROSTER,
  resolveConsult, log, readCodexToken, readGrokJwt, readElevenKey, hasElevenKey,
  pcm16_24k_to_16k, rms16, extractSttText, trimSeam, appendTeachNote, parentSend
};
