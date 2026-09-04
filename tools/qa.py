#!/usr/bin/env python3
"""qa.py — repo self-check: compile, parse, cross-refs, leak-scan, tests.

    python tools/qa.py        # full pass; exit 1 on anything broken

Runs the checks a reviewer would run by hand, so PRs stay honest:
  1. every .py compiles, every .cjs passes node --check, every .json parses
  2. every docs/README cross-reference resolves to a real file
  3. leak scan: no tailnet/private IPs, no key-shaped strings in code
  3b. leak scan: no real agent UUIDs (reserved-pool ids are fine), no personal
      name/handle markers anywhere in the tree
  4. map tests green (if node available)
"""
import json, os, re, shutil, subprocess, sys  # noqa-leak-gate (qa defines the banned literals)
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent   # repo root
fails, warns = [], []
node = shutil.which("node")

# 1a. python compiles
for p in sorted(HERE.rglob("*.py")):
    if "__pycache__" in str(p):
        continue
    r = subprocess.run([sys.executable, "-m", "py_compile", str(p)], capture_output=True, text=True)
    if r.returncode:
        fails.append(f"compile: {p.name}: {r.stderr[-120:]}")

# 1b. cjs syntax
if node:
    for p in sorted(HERE.rglob("*.cjs")):
        r = subprocess.run([node, "--check", str(p)], capture_output=True, text=True)
        if r.returncode:
            fails.append(f"syntax: {p.name}: {r.stderr[-120:]}")
else:
    warns.append("node not found - cjs syntax unchecked")

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

# 3. leak scan: private IPs + key-shaped strings
IPV4 = re.compile(r"\b(?!127\.0\.0\.1|0\.0\.0\.0)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b")
KEYISH = re.compile(r"\b(sk|xai|Bearer|hsk|ak)[-_][A-Za-z0-9]{16,}\b", re.I)
def is_private(ip):
    octets = [int(x) for x in ip.split(".")]
    return (octets[0] == 10 or octets[:2] == [192, 168] or
            octets[0] == 172 and 16 <= octets[1] <= 31 or
            octets[0] == 100 and 64 <= octets[1] <= 127)

for p in sorted(x for x in HERE.rglob("*") if x.is_file()):
    if p.suffix in (".png", ".ico") or "__pycache__" in str(p):
        continue
    try:
        txt = p.read_text(encoding="utf-8")
    except Exception:
        continue
    for m in IPV4.finditer(txt):
        ip = m.group(1)
        if is_private(ip):
            fails.append(f"private-IP leak in {p.relative_to(HERE)}: {ip}")
    if p.suffix in (".py", ".cjs"):
        for m in KEYISH.finditer(txt):
            fails.append(f"key-shaped string in {p.relative_to(HERE)}: {m.group(0)[:24]}")

# 3b. leak gate: real agent UUIDs + personal markers
# banned UUID list is machine-derived; reserved-pool (all-zero prefix) ids are allowed fixtures
_BANNED_UUID_FILE = HERE / "tools" / "banned-uuids.txt"
_BANNED_PATTERNS = [r"\bRosalie\b", r"\bTerpbot\b", r"\bonerobby\b", r"poke-work"]
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
_RESERVED_OK = re.compile(r"^0{8}-0{4}-4000-8000-0{9}[0-9a-f]{3}$")
_BANNED_UUIDS = set()
if _BANNED_UUID_FILE.exists():
    for line in _BANNED_UUID_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            _BANNED_UUIDS.add(line)
for p in sorted(x for x in HERE.rglob("*") if x.is_file()):
    if p.suffix in (".png", ".ico", ".map") or p.name == "banned-uuids.txt" or "__pycache__" in str(p):
        continue
    try:
        txt = p.read_text(encoding="utf-8", errors="replace")
    except Exception:
        continue
    if re.search(r"noqa-leak-gate|eslint-fixture-leak-gate", txt):
        continue  # leak-fixture/scrubber files legitimately contain the banned literals
    for u in _UUID_RE.findall(txt):
        if u in _BANNED_UUIDS:
            fails.append(f"leak (uuid) {u} in {p.relative_to(HERE)}")
    for pat in _BANNED_PATTERNS:
        m = re.search(pat, txt, re.I)
        if m:
            fails.append(f'leak (pattern) "{pat}" in {p.relative_to(HERE)}')

# 4. map tests
if node:
    r = subprocess.run([node, str(HERE / "tools" / "test-provider-maps.cjs")], capture_output=True, text=True)
    tail = ((r.stdout or "").strip().splitlines() or ["?"])[-1]
    if r.returncode:
        fails.append(f"map tests: {tail}")
    else:
        print(f"map tests: {tail}")
else:
    warns.append("node not found - map tests skipped")

print()
for w in warns:
    print(f"[WARN] {w}")
for f in fails:
    print(f"[FAIL] {f}")
print(f"QA: {len(fails)} fail, {len(warns)} warn")
sys.exit(1 if fails else 0)
