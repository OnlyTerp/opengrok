#!/usr/bin/env node
"use strict";
/* run-all.cjs — run every box harness suite, report a single verdict.
 * Exit 0 = all suites pass. Exit 1 = any failure (per-suite status printed).
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SUITES = [
  "test-m1-context-guardian.cjs",
  "test-m2-full.cjs",
  "test-m2-adversarial-node.cjs",
  "test-m2-empirical-node.cjs",
  "test-m4-empirical-challenger.cjs",
  "test-m4-empirical-node.cjs",
];

let failed = 0;
const results = [];
for (const s of SUITES) {
  const p = path.resolve(__dirname, s);
  if (!fs.existsSync(p)) { results.push([s, "MISSING"]); failed++; continue; }
  const r = spawnSync(process.execPath, [p], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0) {
    results.push([s, `FAIL (exit ${r.status})`]);
    failed++;
    console.log(`\n--- ${s} output (tail) ---`);
    console.log(out.split("\n").slice(-25).join("\n"));
  } else {
    const passLine = (out.split("\n").filter((l) => /passed/i.test(l)).pop() || "").trim();
    results.push([s, passLine || "PASS"]);
  }
}
console.log("\n=== opengrok box harness run-all ===");
for (const [s, st] of results) console.log(`${/fail/i.test(st) && !/0 failed|FAILED:\s*0/i.test(st) ? "✗" : "✓"} ${s}: ${st}`);
console.log(`\nSUITES: ${SUITES.length} | FAILED SUITES: ${failed}`);
process.exit(failed ? 1 : 0);
