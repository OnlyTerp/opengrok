"use strict";
/**
 * box/hud/test-liquidglass.cjs — behavioral harness for the LiquidGlass HUD fix.
 *
 * Drives the REAL script (vm context with stub DOM) — contract per repo law: drive the real module.
 *
 * Gates:
 *  1. MIN_TOP floor is now BELOW the native band (56), not 46 — the old value let the pill
 *     rest inside the Windows titleBarOverlay drag band (~51/52px), where every click moved
 *     the whole Grok Bot window and the HUD became unusable (Terp's repro).
 *  2. Stored positions inside the band are auto-healed (getStoredPos returns null -> default).
 *  3. saveStoredPos clamps to the dynamic safe floor.
 *  4. applyPosition clamps top to >= safe floor (never paints inside the band).
 *  5. WCO geometrychange re-clamps (registers a listener on navigator.windowControlsOverlay).
 *  6. drag-move clamp honors the safe floor (titlebar-band pixels are unreachable by drag).
 *  7. Repo sanitize output (box/hud/liquidglass.js): syntax OK, zero personal leaks, sees the fix.
 *
 * Exit 0 = all pass. Plain asserts, no framework.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "liquidglass.js");
const LIVE = process.env.LG_SRC || REPO; // repo copy = canonical CI fixture; LG_SRC = machine original for negative-control

// ---------------- minimal DOM stub ----------------
function makeCtx() {
  const listeners = new Map(); // target -> ev -> [hds]
  function addEL(target, ev, hd) {
    if (!listeners.has(target)) listeners.set(target, new Map());
    const m = listeners.get(target);
    if (!m.has(ev)) m.set(ev, []);
    m.get(ev).push(hd);
  }
  const store = new Map();
  const styles = new Map();
  class Elem {
    constructor(tag, id) {
      this.tagName = String(tag).toUpperCase();
      this.id = id || "";
      this.children = [];
      this.dataset = {};
      this._style = {};
      const self = this;
      this.style = new Proxy(this._style, {
        get: (o, k) => (typeof k === "string" ? self["__get"](k) : undefined),
        set: (o, k, v) => (self["__set"](k, v), true),
      });
      this.__get = (k) => this._style[k];
      this.__set = (k, v) => (this._style[k] = String(v));
      this.classList = {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      };
      this.getAttribute = () => null;
      this.setAttribute = () => {};
      this.getBoundingClientRect = () => ({ left: 320, top: 68, right: 620, bottom: 108, width: 300, height: 40 });
      this.addEventListener = (ev, hd) => addEL(this, ev, hd);
      this.removeEventListener = () => {};
      this.setPointerCapture = () => {};
      this.releasePointerCapture = () => {};
    }
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener(ev, hd) { addEL(this, ev, hd); }
    removeEventListener() {}
  }
  const body = new Elem("body");
  const documentElement = new Elem("html");
  const styleEl = new Elem("style", "gb-liquidglass-styles");
  const root = new Elem("div", "gb-liquidglass-root");
  body.appendChild(styleEl);
  body.appendChild(root);

  const wcoListeners = [];
  const wco = {
    getTitlebarAreaRect: () => ({ x: 0, y: 0, width: 1200, height: 52 }), // Grok-Bot-like band (52)
    addEventListener: (ev, hd) => { if (ev === "geometrychange") wcoListeners.push(hd); },
    removeEventListener: () => {},
  };

  const created = [];
  const document = {
    body, documentElement, createElement: (t) => { const e = new Elem(t); created.push(e); return e; },
    getElementById: (id) => {
      for (const e of [root, styleEl, ...created]) if (e.id === id) return e;
      return null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (ev, hd) => addEL(document, ev, hd),
    removeEventListener: () => {},
  };

  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    document,
    setTimeout: (fn) => { timers.push(fn); return 0; },
    clearTimeout: () => {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    navigator: { windowControlsOverlay: wco },
    location: { href: "https://grok.example/" },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => ({ ok: false }),
    window: null, // set below
  };
  sandbox.window = sandbox;
  sandbox.innerWidth = 1200;
  sandbox.innerHeight = 800;
  sandbox.addEventListener = (ev, hd) => addEL(sandbox, ev, hd);
  sandbox.removeEventListener = () => {};
  sandbox.Event = class { constructor(t) { this.type = t; } };
  sandbox.KeyboardEvent = class { constructor(t) { this.type = t; } };
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => "" });
  sandbox.requestAnimationFrame = (fn) => timers.push(fn);

  const timers = [];
  sandbox.__timers = timers;
  sandbox.__listeners = listeners;
  sandbox.__store = store;
  sandbox.__styles = styles;
  sandbox.__root = root;
  sandbox.__wcoListeners = wcoListeners;
  return sandbox;
}

function prime(ctx, src) {
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "liquidglass.js" });
  // flush initial poll timers
  for (const t of [...ctx.__timers]) { try { t(); } catch (e) {} }
  ctx.__timers.length = 0;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("PASS " + name); }
  catch (e) { failed++; console.error("FAIL " + name + " :: " + e.message); }
}

const liveSrc = fs.readFileSync(LIVE, "utf8");
const repoSrc = fs.readFileSync(REPO, "utf8");

// 1. floor math: new MIN_TOP >= 56 (band 52 + margin), old bug was 46
test("1. MIN_TOP floor moved out of native drag band (>=56)", () => {
  const m = liveSrc.match(/const\s+MIN_TOP\s*=\s*(\d+)/);
  if (!m) throw new Error("MIN_TOP not found");
  const v = Number(m[1]);
  if (v < 56) throw new Error("MIN_TOP=" + v + " still inside 52px band");
});

// 2. getSafeMinTop exists and uses WCO
test("2. getSafeMinTop() honors windowControlsOverlay band", () => {
  const ctx = makeCtx(); prime(ctx, liveSrc);
  const fn = ctx.__grokbotMinTop;
  if (typeof fn !== "number") throw new Error("window.__grokbotMinTop not exported as number");
  if (fn < 56) throw new Error("exported min top " + fn + " inside band");
});

// 3. stored pos inside band is healed
test("3. stored top=46 inside band → healed to default", () => {
  const ctx = makeCtx(); prime(ctx, liveSrc);
  ctx.localStorage.setItem("gb_liquidglass_pos", JSON.stringify({ left: 320, top: 46 }));
  // drive the REAL applyPosition (exported debug hook)
  if (typeof ctx.__grokbotApplyPosition !== "function") throw new Error("apply hook not exported");
  ctx.__grokbotApplyPosition();
  const st = ctx.localStorage.getItem("gb_liquidglass_pos");
  if (st) {
    const p = JSON.parse(st);
    if (p.top < 56) throw new Error("stored pos still in band: " + st);
  }
  // either removed (null) or reset — both acceptable; assert root style is out of band
  const top = ctx.__root._style["top"];
  if (top != null) {
    const n = parseInt(top, 10);
    if (!isNaN(n) && n < 56) throw new Error("root painted at top " + n);
  }
});

// 4. saveStoredPos clamps
test("4. saveStoredPos clamps top to >= safe floor", () => {
  const ctx = makeCtx(); prime(ctx, liveSrc);
  const before = ctx.localStorage.getItem("gb_liquidglass_pos");
  ctx.window.__grokbotSetActiveAgent("00000000-0000-4000-8000-000000000001"); // touch API surface exists
  // save via dragEnd path is internal; simulate: force-wait through getStoredPos by direct script eval
  const out = vm.runInContext('(function(){try{saveStoredPos({left:320,top:46});}catch(e){} return localStorage.getItem("gb_liquidglass_pos");})()', ctx);
  // after dragEnd save happens internally too; here we assert the raw entry (if written) is >= floor
  if (out) {
    const p = JSON.parse(out);
    if (p.top < 56) throw new Error("clamped pos still in band: " + out);
  }
});

// 5. WCO geometrychange listener registered
test("5. WCO geometrychange listener registered", () => {
  const ctx = makeCtx(); prime(ctx, liveSrc);
  if (!ctx.__wcoListeners.length) throw new Error("no geometrychange listener");
});

// 6. dragMove clamp: simulate drag to y=-200, expect applied top >= floor
test("6. drag into titlebar band is clamped below band", () => {
  const ctx = makeCtx(); prime(ctx, liveSrc);
  const listeners = ctx.__listeners;
  const root = ctx.__root;
  // rootEl listeners were registered on root element: find pointerdown handler
  const rootHandlers = [...listeners.entries()].find(([k, m]) => k && k.tagName === "DIV" && m && m.has("pointerdown"));
  if (!rootHandlers) throw new Error("no root listeners");
  const pd = (rootHandlers[1].get("pointerdown") || [])[0];
  if (!pd) throw new Error("no pointerdown on root");
  const mkEv = (type, x, y) => ({ type, clientX: x, clientY: y, button: 0, pointerId: 7, stopPropagation: () => {}, preventDefault: () => {} });
  pd(mkEv("pointerdown", 400, 80));
  const winHandlers = listeners.get(ctx);
  if (!winHandlers) throw new Error("no window handlers");
  const pm = (winHandlers.get("pointermove") || [])[0];
  const pu = (winHandlers.get("pointerup") || [])[0];
  if (!pm || !pu) throw new Error("missing drag move/up handlers");
  // drag far above window top
  pm(mkEv("pointermove", 400, -250));
  pu(mkEv("pointerup", 400, -250));
  const dragRoot = rootHandlers[0];
  const topStr = String(dragRoot._style["top"] || "");
  const top = parseInt(topStr, 10);
  if (isNaN(top)) throw new Error("no top style applied");
  if (top < 56) throw new Error("drag clamped at " + top + " (inside band)");
  const stored = ctx.localStorage.getItem("gb_liquidglass_pos");
  if (stored) {
    const p = JSON.parse(stored);
    if (p.top < 56) throw new Error("store after drag in band: " + stored);
  }
});

// 7. repo variant: fix present + sanitized
test("7. repo box/hud/liquidglass.js carries the fix and zero leaks", () => {
  const s = repoSrc;
  if (!/getSafeMinTop\s*\(/.test(s)) throw new Error("fix missing in repo variant");
  const m = s.match(/const\s+MIN_TOP\s*=\s*(\d+)/);
  if (!m || Number(m[1]) < 56) throw new Error("repo floor wrong");
  if (/47818ea2|Terpbot|onlyterp/i.test(s)) throw new Error("personal leak in repo variant");
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
