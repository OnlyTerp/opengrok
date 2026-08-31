#!/usr/bin/env python3
"""Wrap stock proto-session factory so Grok Bot turns can hit a local OpenAI hop.

Stock `host-main.cjs` (issues #3, #5) has no OpenAI hop lane. The live factory
on Grok Bot 0.30 is `createProtoSessionProvider(client, requestedModel, ...)`
and returns `new ProtoSession(...)`. Older notes looked for `createProtoSession`
or a digit suffix (`createProtoSession2`); those are the wrong names.

This transform is idempotent:

  1. Find the unique `function` / `async function` definition, or the unique
     `name: function(` object property, whose name starts with
     `createProtoSession` (letters/digits after, e.g. Provider).
  2. Prepend a same-name wrapper that calls `opengrok-runtime.wrapSession`.
  3. Rename the original to `<name>_stock`.

Fails closed unless that definition is unique. Census always includes snippets
around every `createProtoSession*` hit so a miss is diagnosable on the box.
"""
from __future__ import annotations

import json
import re

MARKER = "/* opengrok-stock-wrap */"
DEF = "function createProtoSession("
STOCK_DEF = "function createProtoSession_stock("

# Live box: createProtoSessionProvider. Also createProtoSession / …2.
# `_stock` rename is excluded: `_` is a word char so \b will not fire mid-name.
NAME = r"createProtoSession[A-Za-z0-9]*"
IDENT_RE = re.compile(r"\b(" + NAME + r")\b")
DEF_RE = re.compile(r"(?P<prefix>(?:async\s+)?function\s+)(?P<name>" + NAME + r")\s*\(")
PROP_RE = re.compile(
    r"(?P<name>" + NAME + r")\s*:\s*(?P<async>async\s+)?function\s*\("
)


def snippets(src: str, limit: int = 8, radius: int = 90) -> list[dict]:
    """Raw windows around every `createProtoSession` substring (incl. Provider)."""
    out = []
    start = 0
    needle = "createProtoSession"
    while len(out) < limit:
        j = src.find(needle, start)
        if j < 0:
            break
        a = max(0, j - radius)
        b = min(len(src), j + len(needle) + radius)
        out.append({"at": j, "text": src[a:b]})
        start = j + 1
    return out


def ident_counts(src: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for m in IDENT_RE.finditer(src):
        n = m.group(1)
        counts[n] = counts.get(n, 0) + 1
    return counts


def function_defs(src: str) -> list[re.Match]:
    return [m for m in DEF_RE.finditer(src) if not m.group("name").endswith("_stock")]


def property_defs(src: str) -> list[re.Match]:
    return [m for m in PROP_RE.finditer(src) if not m.group("name").endswith("_stock")]


def census(src: str) -> dict:
    defs = function_defs(src)
    props = property_defs(src)
    return {
        "createProtoSession": src.count("createProtoSession"),
        "function createProtoSession(": src.count(DEF),
        "idents": ident_counts(src),
        "function_defs": [
            {"name": m.group("name"), "async": m.group("prefix").lstrip().startswith("async"), "at": m.start()}
            for m in defs
        ],
        "property_defs": [
            {"name": m.group("name"), "async": bool(m.group("async")), "at": m.start()}
            for m in props
        ],
        "createOpenAiHopSession": src.count("createOpenAiHopSession"),
        "resolvedOpenaiBaseUrl": src.count("resolvedOpenaiBaseUrl"),
        "hopBaseUrl": src.count("hopBaseUrl"),
        "model-bindings": src.count("model-bindings"),
        "already_wrapped": MARKER in src,
        "bytes": len(src.encode("utf-8")),
        "snippets": snippets(src),
    }


def _header(runtime_path: str, wrapper: str) -> str:
    return (
        MARKER + "\n"
        "var __opengrokRuntime = require(%s);\n"
        % json.dumps(runtime_path)
        + wrapper
    )


def wrap(src: str, runtime_path: str) -> str:
    if MARKER in src:
        return src

    defs = function_defs(src)
    props = property_defs(src)

    if len(defs) == 1 and len(props) == 0:
        m = defs[0]
        name = m.group("name")
        stock = name + "_stock"
        is_async = m.group("prefix").lstrip().startswith("async")
        kw = "async function" if is_async else "function"
        wrapper = (
            "%s %s() {\n"
            "  return __opengrokRuntime.wrapSession(%s, arguments);\n"
            "}\n" % (kw, name, stock)
        )
        renamed = m.group("prefix") + stock + "("
        patched = src[: m.start()] + renamed + src[m.end() :]
        return _header(runtime_path, wrapper) + patched

    if len(defs) == 0 and len(props) == 1:
        m = props[0]
        name = m.group("name")
        stock = name + "_stock"
        async_kw = m.group("async") or ""
        wrapper = ""  # runtime require still prepended; property is rewritten in-place
        rewritten = (
            "%s: function () { return __opengrokRuntime.wrapSession(this.%s, arguments); }, "
            "%s: %sfunction (" % (name, stock, stock, async_kw)
        )
        patched = src[: m.start()] + rewritten + src[m.end() :]
        return _header(runtime_path, wrapper) + patched

    extra = json.dumps(
        {
            "idents": ident_counts(src),
            "function_defs": census(src)["function_defs"],
            "property_defs": census(src)["property_defs"],
            "snippets": snippets(src),
        },
        indent=2,
    )
    raise ValueError(
        "need exactly 1 `function createProtoSession*(` (or "
        "`name: function(` property), found function_defs=%d property_defs=%d.\n%s"
        % (len(defs), len(props), extra)
    )
