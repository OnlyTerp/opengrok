#!/usr/bin/env node
'use strict';
// Voice-v5 watchdog. One failure per ping. 5s timeout.
// Never kill during in-flight speak. Never touch 18790/18791.
// Reclaim is taskkill /F + wait-until-port-free.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const HERE = __dirname;
const MARKER = path.join(HERE, 'watchdog-v5.marker');
const SUP = path.join(HERE, 'supervisor.cjs');
const NODE = process.execPath;
const LOG = path.join(HERE, 'watchdog-v5.log');
const PORT = Number(process.env.VOICE_GW_PORT || 18793);
const HEALTH = 'http://127.0.0.1:' + PORT + '/health';
const TIMEOUT_MS = 5000;

function wlog() {
  const line = new Date().toISOString() + ' ' + Array.from(arguments).join(' ') + '\n';
  try { fs.appendFile(LOG, line, function () {}); } catch (e) {}
}

function healthDecision(j) {
  if (j && j.speaking) return 'never-kill';
  if (j && j.ok) return 'ok';
  return 'fail';
}

function nodeProcs() {
  try {
    const raw = execSync(
      "powershell.exe -NoProfile -WindowStyle Hidden -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress\"",
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    );
    const j = JSON.parse(raw || '[]');
    return Array.isArray(j) ? j : (j ? [j] : []);
  } catch (e) {
    wlog('proc-list fail', e.message);
    return [];
  }
}

function listeningPids(port) {
  const out = [];
  try {
    const raw = execSync('netstat -ano', { encoding: 'utf8', timeout: 4000, windowsHide: true });
    const re = new RegExp('[:.]' + port + '\\s+.*LISTENING\\s+(\\d+)', 'i');
    raw.split(/\r?\n/).forEach(function (line) {
      const m = line.match(re);
      if (m) out.push(Number(m[1]));
    });
  } catch (e) {}
  return out;
}

function alreadyWatchdog() {
  try {
    if (!fs.existsSync(MARKER)) return false;
    const pid = parseInt(String(fs.readFileSync(MARKER, 'utf8')).trim(), 10);
    if (!pid || pid === process.pid) return false;
    const rows = nodeProcs();
    for (let i = 0; i < rows.length; i++) {
      const id = Number(rows[i].ProcessId);
      const cmd = String(rows[i].CommandLine || '');
      if (id === pid && /watchdog-v5/.test(cmd)) return true;
    }
  } catch (e) {}
  return false;
}

function isProtectedCmd(cmd) {
  // The restart routine only ever kills processes whose command line
  // matches isV5Cmd(), so nothing else can be touched. Hook kept for
  // operators who want extra exclusions.
  return false;
}

function isV5Cmd(cmd) {
  const c = String(cmd || '');
  return /voice-v5.(supervisor|ears|captain|mouth)\.cjs/.test(c);
}

function waitPortFree(port, ms) {
  const deadline = Date.now() + (ms || 10000);
  while (Date.now() < deadline) {
    try {
      const raw = execSync('netstat -ano', { encoding: 'utf8', timeout: 4000, windowsHide: true });
      const re = new RegExp('127\\.0\\.0\\.1:' + port + '\\s+.*LISTENING', 'i');
      if (!re.test(raw)) return true;
    } catch (e) { return true; }
    try { execSync('ping -n 2 127.0.0.1', { timeout: 3000, windowsHide: true }); } catch (e) {}
  }
  return false;
}

function restartV5() {
  wlog('restart begin port', PORT);
  const protect = {};
  listeningPids(18790).concat(listeningPids(18791)).forEach(function (id) { protect[id] = true; });
  const rows = nodeProcs();
  const pids = [];
  for (let i = 0; i < rows.length; i++) {
    const id = Number(rows[i].ProcessId);
    const cmd = String(rows[i].CommandLine || '');
    if (!id || id === process.pid) continue;
    if (protect[id]) continue;
    if (isProtectedCmd(cmd)) continue;
    if (!isV5Cmd(cmd)) continue;
    pids.push(id);
  }
  for (let i = 0; i < pids.length; i++) {
    wlog('taskkill /F pid', pids[i]);
    try { execSync('taskkill /F /PID ' + pids[i], { timeout: 5000, windowsHide: true }); }
    catch (e) { wlog('taskkill fail', e.message); }
  }
  const free = waitPortFree(PORT, 10000);
  wlog('port-free', PORT, free);
  if (!free) {
    wlog('port still bound; refuse start');
    return;
  }
  try {
    const child = spawn(NODE, [SUP], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: HERE,
      env: Object.assign({}, process.env, { VOICE_GW_PORT: String(PORT) })
    });
    child.unref();
    wlog('started supervisor port', PORT);
  } catch (e) {
    wlog('start fail', e.message);
  }
}

function startWatchdog() {
  if (alreadyWatchdog()) {
    wlog('already-running; exit');
    process.exit(0);
  }
  try { fs.mkdirSync(HERE, { recursive: true }); } catch (e) {}
  try { fs.writeFileSync(MARKER, String(process.pid) + '\n'); } catch (e) {}
  wlog('watchdog-v5 start pid', process.pid, 'port', PORT);

  let fails = 0;

  function ping() {
    let settled = false;
    function ok() {
      if (settled) return;
      settled = true;
      fails = 0;
    }
    function fail(why) {
      if (settled) return; // one ping → one count
      settled = true;
      fails += 1;
      wlog('health-fail', fails, why);
      if (fails >= 2) {
        fails = 0;
        restartV5();
      }
    }
    const req = http.get(HEALTH, { timeout: TIMEOUT_MS }, function (res) {
      const chunks = [];
      res.on('data', function (d) { chunks.push(d); });
      res.on('end', function () {
        if (res.statusCode !== 200) return fail('status ' + res.statusCode);
        let j = {};
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return fail('nonjson'); }
        const d = healthDecision(j);
        if (d === 'never-kill') {
          wlog('health-ok speaking; never-kill');
          return ok();
        }
        if (d === 'ok') return ok();
        fail('ok=false');
      });
    });
    req.on('error', function (e) { fail(e.message); });
    req.on('timeout', function () {
      try { req.destroy(); } catch (e) {}
      fail('timeout');
    });
  }

  setInterval(ping, 8000);
  ping();
}

if (require.main === module) startWatchdog();

module.exports = {
  healthDecision, isProtectedCmd, isV5Cmd, waitPortFree, restartV5, startWatchdog
};
