#!/usr/bin/env node
'use strict';
// Voice doctor: pre-flight validation a stranger can run before/after setup.
// Usage: node voice/doctor.js

const fs = require('fs');
const path = require('path');
const os = require('os');

const voiceDir = __dirname;
const REPORT = [];
let hard = 0;

function ok(msg) { REPORT.push('  OK   ' + msg); }
function warn(msg) { REPORT.push('  WARN ' + msg); }
function bad(msg) { REPORT.push('  FAIL ' + msg); hard++; }

function readEnvFile() {
  const p = path.join(voiceDir, '.env');
  const env = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* no file yet */ }
  return env;
}

const fileEnv = readEnvFile();
function envGet(key) {
  if (process.env[key] && String(process.env[key]).trim()) return String(process.env[key]).trim();
  if (fileEnv[key] && fileEnv[key].trim()) return fileEnv[key];
  return '';
}

// --- node version ---
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10) || 0;
if (nodeMajor >= 18) ok('Node.js ' + process.versions.node);
else bad('Node.js 18+ required (found ' + process.versions.node + ')');

// --- .env present ---
if (fs.existsSync(path.join(voiceDir, '.env'))) ok('voice/.env present');
else bad('voice/.env missing - copy voice/.env.example to voice/.env and fill it in (see voice/SETUP.md)');

// --- elevenlabs (mouth) ---
const elKey = envGet('ELEVENLABS_API_KEY') || envGet('ELEVEN_API_KEY');
const elVoice = envGet('ELEVENLABS_VOICE_ID');
if (elKey && elVoice) ok('ElevenLabs key + voice id configured');
else if (elKey) bad('ELEVENLABS_VOICE_ID missing in voice/.env (any voice id from your ElevenLabs dashboard)');
else if (elVoice) bad('ELEVENLABS_API_KEY missing in voice/.env');
else bad('ElevenLabs not configured - set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in voice/.env (voice/SETUP.md step 1)');

// --- openai realtime (captain) ---
let openaiOk = false;
if (envGet('VOICE_OPENAI_TOKEN') || envGet('VOICE_CODEX_TOKEN')) {
  openaiOk = true;
  ok('OpenAI realtime token configured via env');
}
if (!openaiOk) {
  const codexAuth = path.join(os.homedir(), '.codex', 'auth.json');
  if (fs.existsSync(codexAuth)) {
    try {
      const j = JSON.parse(fs.readFileSync(codexAuth, 'utf8'));
      if (j && (j.access_token || j.id_token || j.tokens)) {
        openaiOk = true;
        ok('OpenAI realtime via ~/.codex/auth.json (Codex CLI login found)');
      } else {
        warn('~/.codex/auth.json exists but has no recognizable token - run: npx codex login');
      }
    } catch (e) { warn('~/.codex/auth.json unreadable - run: npx codex login'); }
  } else {
    bad('OpenAI realtime not configured - run: npx codex login  (or set VOICE_OPENAI_TOKEN in voice/.env)  (voice/SETUP.md step 2)');
  }
}

// --- grok/xai (ears) ---
let grokOk = false;
if (envGet('VOICE_GROK_JWT') || envGet('GROK_API_KEY')) {
  grokOk = true;
  ok('Grok/xAI token configured via env');
}
if (!grokOk) {
  const grokAuth = path.join(os.homedir(), '.grok', 'auth.json');
  if (fs.existsSync(grokAuth)) {
    try {
      const j = JSON.parse(fs.readFileSync(grokAuth, 'utf8'));
      const flat = JSON.stringify(j);
      if (j && (j.access_token || j.id_token || j.token || (j.keys && j.keys.api_key) || /eyJ/.test(flat))) {
        grokOk = true;
        ok('Grok/xAI auth via ~/.grok/auth.json');
      } else {
        warn('~/.grok/auth.json exists but no recognizable token field');
      }
    } catch (e) { warn('~/.grok/auth.json unreadable'); }
  } else {
    bad('Grok/xAI auth not found - log into the Grok CLI so ~/.grok/auth.json exists, or set VOICE_GROK_JWT in voice/.env (voice/SETUP.md step 3)');
  }
}

// --- optional lanes ---
if (envGet('VOICE_CONSULT_ROSTER')) ok('consult roster configured');
else warn('no consult roster (optional) - the voice brain answers everything itself');
if (envGet('VOICE_CONTEXT_HOST')) ok('live-context source configured');
else warn('no live-context source (optional) - the read_live_context tool reports none configured');

// --- verdict ---
console.log('GrokBot Voice doctor');
console.log(REPORT.join('\n'));
console.log('');
if (hard === 0) {
  console.log('READY. Start with: powershell -ExecutionPolicy Bypass -File voice/scripts/start-voice.ps1');
} else {
  console.log(hard + ' blocking issue(s). Fix the FAIL lines above, then re-run this doctor.');
  process.exit(1);
}
