#!/usr/bin/env node
'use strict';
// Repeatable leak-scan for the voice package (and the whole repo by default).
// Usage: node voice/scripts/leak-scan.js [paths...]
// Exits 1 if any structural leak pattern matches. Personal IDs are NOT hardcoded
// here — structural shapes (absolute user paths, key/JWT formats, committed env)
// are what this scan enforces, so the scanner itself stays generic and public.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = process.argv.slice(2).length
  ? process.argv.slice(2).map(function (p) { return path.resolve(ROOT, p); })
  : [ROOT];

const EXCLUDE = [
  /[\\\/]\.git[\\\/]/,
  /[\\\/]node_modules[\\\/]/,
  /voice[\\\/]\.env$/,          // never committed, but ignore if present locally
  /[\\\/]logs[\\\/]/,
  /[\\\/]__pycache__[\\\/]/
];

const EXT = /\.(js|cjs|mjs|py|md|html|css|ps1|cmd|sh|json|yaml|yml|example|txt)$/i;

// Structural patterns only (safe to publish):
const PATTERNS = [
  { name: 'absolute-user-path', re: /C:[\/\\]Users[\/\\][^"'\s]+|\/Users\/[a-z0-9_]+\//i },
  { name: 'msys-user-path', re: /\/c\/Users\/[a-z0-9_]+\//i },
  { name: 'openai-key', re: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'jwt-fragment', re: /eyJ[A-Za-z0-9_-]{10,}/ },
  { name: 'bearer-literal', re: /Bearer\s+[A-Za-z0-9_\-\.]{25,}/ },
  { name: 'private-ip-binding', re: /0\.0\.0\.0:(?!0\b)/ }
];

let hits = 0;
function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (EXCLUDE.some(function (rx) { return rx.test(full); })) continue;
    if (e.isDirectory()) { walk(full); continue; }
    if (!EXT.test(e.name)) continue;
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch (err) { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const p of PATTERNS) {
        if (p.re.test(lines[i])) {
          hits++;
          console.log('LEAK [' + p.name + '] ' + path.relative(ROOT, full) + ':' + (i + 1));
        }
      }
    }
  }
}

for (const d of SCAN_DIRS) walk(d);
if (hits > 0) {
  console.log('\n' + hits + ' structural leak hit(s). Fix before pushing.');
  process.exit(1);
}
console.log('leak-scan CLEAN (' + SCAN_DIRS.map(function (d) { return path.relative(ROOT, d) || '.'; }).join(', ') + ')');
