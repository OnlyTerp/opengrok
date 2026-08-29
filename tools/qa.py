#!/usr/bin/env python3
"""qa.py — repo self-check: compile, parse, cross-refs, leak-scan, tests.

    python tools/qa.py        # full pass; exit 1 on anything broken

Runs the checks a reviewer would run by hand, so PRs stay honest:
  1. every .py compiles, every .cjs passes node --check, every .json parses
  2. every docs/README cross-reference resolves to a real file
  3. leak scan: no tailnet/private IPs, no key-shaped strings in code
  4. map tests green (if node available)
  5. Python behavioral tests green
"""
import json, re, shutil, subprocess, sys

def shutil_which():
    return shutil.which("node")
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent   # repo root
fails, warns = [], []

# 1a. python compiles
for p in sorted(HERE.rglob("*.py")):
    if "__pycache__" in str(p):
        continue
    r = subprocess.run([sys.executable, "-m", "py_compile", str(p)], capture_output=True, text=True)
    if r.returncode:
        fails.append(f"compile: {p.name}: {r.stderr[-120:]}")

# 1b. cjs syntax
node = shutil_which()
for p in sorted(HERE.rglob("*.cjs")):
    if not node:
        warns.append("node not found - cjs syntax unchecked")
        break
    r = subprocess.run([node, "--check", str(p)], capture_output=True, text=True)
    if r.returncode:
        fails.append(f"syntax: {p.name}: {r.stderr[-120:]}")

# 1c. json parses
for p in sorted(HERE.rglob("*.json")):
    try:
        json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        fails.append(f"json: {p.name}: {e}")

# 2. cross-references resolve
for md in sorted(HERE.rglob("*.md")):
    txt = md.read_text(encoding="utf-8")
    for ref in re.findall(r"(?<!:)(?:docs|tools|examples)/[A-Za-z0-9_./-]+", txt):
        if not (HERE / ref).exists():
            fails.append(f"dangling ref in {md.name}: {ref}")

# 3. leak scan
IPV4 = re.compile(r"\b(?!127\.0\.0\.1|0\.0\.0\.0)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b")
KEYISH = re.compile(r"\b(sk|xai|Bearer|hsk|ak)[-_][A-Za-z0-9]{16,}\b", re.I)
for p in sorted(x for x in HERE.rglob("*") if x.is_file()):
    if p.suffix in (".png", ".ico"):
        continue
    try:
        txt = p.read_text(encoding="utf-8")
    except Exception:
        continue
    for m in IPV4.finditer(txt):
        ip = m.group(1)
        if ip.startswith(("10.", "192.168.", "172.", "100.")) and not ip.startswith("127."):
            fails.append(f"private-IP leak in {p.relative_to(HERE)}: {ip}")
    if p.suffix in (".py", ".cjs"):
        for m in KEYISH.finditer(txt):
            fails.append(f"key-shaped string in {p.relative_to(HERE)}: {m.group(0)[:24]}")

# 4. map tests
node = shutil_which()
if node:
    r = subprocess.run([node, str(HERE / "tools" / "test-provider-maps.cjs")], capture_output=True, text=True)
    tail = ((r.stdout or "").strip().splitlines() or ["?"])[-1]
    if r.returncode:
        fails.append(f"map tests: {tail}")
    else:
        print(f"map tests: {tail}")
else:
    warns.append("node not found - map tests skipped")

# 5. Python behavioral tests
tests = HERE / "tests"
if tests.is_dir():
    r = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", str(tests), "-p", "test_*.py"],
        capture_output=True, text=True,
    )
    tail = (((r.stdout or "") + (r.stderr or "")).strip().splitlines() or ["?"])[-1]
    if r.returncode:
        fails.append(f"Python tests: {tail}")
    else:
        print(f"Python tests: {tail}")

print()
for w in warns:
    print(f"[WARN] {w}")
for f in fails:
    print(f"[FAIL] {f}")
print()
print(f"QA: {len(fails)} fail, {len(warns)} warn")
sys.exit(1 if fails else 0)
