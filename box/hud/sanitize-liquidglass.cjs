#!/usr/bin/env node
/* eslint-fixture-leak-gate: this file scrubs/asserts absence of personal literals */
"use strict";
/* eslint-fixture-leak-gate: this file scrubs/asserts absence of personal literals */
/**
 * sanitize-liquidglass.cjs — derive box/hud/liquidglass.js (repo-safe) from the live HUD file.
 * Replaces the embedded personal bindings snapshot with generic example agents (same shape),
 * scrubs personal names, and asserts no UUID/name/handle leaks remain. Deterministic; exit 1 on leak.
 *
 * Usage: node sanitize-liquidglass.cjs <live-source.js> <repo-out.js>
 */
const fs = require("fs");
const path = require("path");

const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error("usage: sanitize-liquidglass.cjs <src> <dst>"); process.exit(2); }

let t = fs.readFileSync(src, "utf8");

// 1. Replace the embedded STATIC_BINDINGS snapshot with a tiny generic example set (same shape).
const start = t.indexOf("const STATIC_BINDINGS = {");
if (start < 0) { console.error("STATIC_BINDINGS anchor not found"); process.exit(1); }
let depth = 0, end = -1;
for (let i = start; i < t.length; i++) {
  const c = t[i];
  if (c === "{") depth++;
  else if (c === "}") {
    depth--;
    if (depth === 0 && t[i + 1] === ";") { end = i + 2; break; }
  }
}
if (end < 0) { console.error("STATIC_BINDINGS end not found"); process.exit(1); }
const generic = `const STATIC_BINDINGS = {
    "00000000-0000-4000-8000-000000000001": {
        "name": "Alpha Agent",
        "modelId": "grok-4.6",
        "provider": "grok-superheavy",
        "baseUrl": "http://127.0.0.1:18779/v1",
        "parameters": [
            { "id": "effort", "value": "high" }
        ]
    },
    "00000000-0000-4000-8000-000000000002": {
        "name": "GLM Agent",
        "modelId": "glm-5.3",
        "provider": "zai",
        "baseUrl": "http://127.0.0.1:18786/v1",
        "parameters": [
            { "id": "effort", "value": "medium" }
        ]
    }
};`;
t = t.slice(0, start) + generic + t.slice(end);

// 2. Scrub personal markers.
t = t.replace(/\bTerpbot\b/g, "Demo Bot").replace(/\bTerp\b/g, "the operator");

// 3. Leak assertions.
const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[1-57][0-9a-f]{3}-[0-9ab][0-9a-f]{3}-[0-9a-f]{12}/g;
const reserved = /^0{8}-0{4}-4000-8000-0{9}[0-9]{3}$/; // examples use this reserved-zero pool — not a leak
const uuids = (t.match(uuidRe) || []).filter(u => !reserved.test(u));
if (uuids.length) { console.error("UUID leak(s):", uuids.slice(0, 5)); process.exit(1); }
if (/\bTerp|onlyterp|Rob\b|Rosalie|terpbot/i.test(t)) { console.error("name leak"); process.exit(1); }

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, t);
console.log("sanitized ->", dst, t.length, "bytes");
