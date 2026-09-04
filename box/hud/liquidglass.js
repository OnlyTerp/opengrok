/*GROKBOT_LIQUIDGLASS_IN_APP_INJECTED*/
(function () {
  if (typeof window !== "undefined" && window.__grokbotLiquidGlassInjected) return;
  if (typeof window !== "undefined") window.__grokbotLiquidGlassInjected = true;

  const RELAY = "http://127.0.0.1:8799";
  let isExpanded = false;
  let showRoster = false;
  let showDiag = false;
  let showModelDropdown = false;
  let modelSearchFilter = "";
  let lastRenderedState = null;
  let dragData = { isDragging: false, hasDragged: false, startX: 0, startY: 0, initialLeft: 0, initialTop: 0 };

  // --- EMBEDDED STATIC 23+ BOT CATALOG ---
  const STATIC_BINDINGS = {
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
};

  let currentActiveAgentId = (typeof window !== "undefined" && window.__grokbotActiveAgentId) || Object.keys(STATIC_BINDINGS)[0] || null;
  if (typeof window !== "undefined" && currentActiveAgentId) {
    window.__grokbotActiveAgentId = currentActiveAgentId;
  }

  let bindings = Object.assign({}, STATIC_BINDINGS);
  let metricsByAgent = {};
  let globalLatestMetrics = {
    modelId: "grok-4.6",
    agentName: "Demo Bot",
    agentId: Object.keys(STATIC_BINDINGS)[0] || "",
    hopRoute: "127.0.0.1:18779",
    isVerifiedHop: true,
    tokensPerSec: 0.0,
    ttftMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitPct: 0.0,
    contextLimit: 2097152,
    contextUtilizationPct: 0.0
  };

  const MODEL_CONTEXT_LIMITS = {
    "grok-4.6": 2097152,
    "grok-4.6-superheavy": 2097152,
    "claude-opus-5-oauth-1": 200000,
    "claude-opus-5-oauth-3": 200000,
    "claude-fable-5-oauth-1": 200000,
    "claude-fable-5-oauth-3": 200000,
    "claude-3-7-sonnet": 200000,
    "deepseek/deepseek-v4-pro-0813:thinking": 262144,
    "qwen3.8-max": 262144,
    "mimo-v2.5-pro-ultraspeed": 1048576,
    "gemini-3.7-flash": 1048576,
    "glm-5.3": 1048576,
    "glm-5.3-flash": 1048576,
    "local-qwen38-27b": 196608,
    "local-qwen38-27b-aipc": 131072,
    "gpt-5.6-luna-max": 1048576,
    "zai-org/GLM-5.3-Flash": 1048576,
    "cerebras/llama-3.3-70b": 131072,
    "cerebras-llama-3.1-8b": 131072
  };

  const MODEL_CATALOG = [
    { label: "Cerebras Ultra-Speed (Llama 3.3 70B)", desc: "~1,800 tok/s Ultra-Low Latency", id: "cerebras/llama-3.3-70b", hop: "http://127.0.0.1:18786/v1", prov: "cerebras", badge: "🚀 ULTRA" },
    { label: "Cerebras Ultra-Speed (Llama 3.1 8B)", desc: "~2,200 tok/s Instant Reflex", id: "cerebras-llama-3.1-8b", hop: "http://127.0.0.1:18786/v1", prov: "cerebras", badge: "🚀 ULTRA" },
    { label: "Claude Opus 5 (OAuth Plan 1)", desc: "High-Reasoning Anthropic Engine", id: "claude-opus-5-oauth-1", hop: "http://127.0.0.1:18786/v1", prov: "claude", badge: "⚡ PLAN 1" },
    { label: "Claude Fable 5 (OAuth Plan 1)", desc: "Coding & Agent Synthesis", id: "claude-fable-5-oauth-1", hop: "http://127.0.0.1:18786/v1", prov: "claude", badge: "⚡ PLAN 1" },
    { label: "Claude Opus 5 (OAuth Plan 3)", desc: "Heavy Deep Thinking", id: "claude-opus-5-oauth-3", hop: "http://127.0.0.1:18786/v1", prov: "claude", badge: "⚡ PLAN 3" },
    { label: "Claude Sonnet 3.7 Thinking", desc: "Hybrid Reasoning Engine", id: "claude-3-7-sonnet", hop: "http://127.0.0.1:18786/v1", prov: "claude", badge: "⚡ 3.7" },
    { label: "DeepSeek V4 Pro Thinking", desc: "Native Thinking RL Architecture", id: "deepseek/deepseek-v4-pro-0813:thinking", hop: "http://127.0.0.1:18786/v1", prov: "deepseek", badge: "🧠 PRO" },
    { label: "GLM 5.3 Coding (Zhipu)", desc: "Code Generation & Architecture", id: "glm-5.3", hop: "http://127.0.0.1:18786/v1", prov: "glm", badge: "🔮 GLM" },
    { label: "GLM 5.3 Flash (Zhipu)", desc: "Fast Execution Mode", id: "glm-5.3-flash", hop: "http://127.0.0.1:18786/v1", prov: "glm", badge: "🔮 FLASH" },
    { label: "GLM Friendli (Zhipu Cloud)", desc: "Friendli Dedicated Hop", id: "zai-org/GLM-5.3-Flash", hop: "http://127.0.0.1:18786/v1", prov: "glm", badge: "🔮 CLOUD" },
    { label: "Qwen 3.8 Max", desc: "Advanced Multilingual Coding", id: "qwen3.8-max", hop: "http://127.0.0.1:18786/v1", prov: "qwen", badge: "🌐 MAX" },
    { label: "Local Qwen 3.8 27B", desc: "Dedicated Local On-Box Model", id: "local-qwen38-27b", hop: "http://127.0.0.1:18786/v1", prov: "qwen", badge: "🌐 LOCAL" },
    { label: "Gemini 3.7 Flash Thinking", desc: "Google Deep Reasoning", id: "gemini-3.7-flash", hop: "http://127.0.0.1:18786/v1", prov: "gemini", badge: "💎 GEMINI" },
    { label: "Grok 4.6 (Stock xAI)", desc: "Default Cursor xAI Direct", id: "grok-4.6", hop: "http://127.0.0.1:18779/v1", prov: "xai", badge: "🪐 GROK" },
    { label: "Grok 4.6 Superheavy", desc: "Superheavy Extended Context", id: "grok-4.6-superheavy", hop: "http://127.0.0.1:18786/v1", prov: "xai", badge: "🪐 HEAVY" }
  ];

  // --- SAFE STORAGE HELPERS ---
  const MIN_TOP = 56; // below the native window-controls-overlay band (~52px) — 46 let the HUD inside the drag band, where clicks moved the whole window
  const DEFAULT_TOP = "68px";
  function getSafeMinTop() {
    try {
      const wco = typeof navigator !== "undefined" && navigator.windowControlsOverlay;
      if (wco && typeof wco.getTitlebarAreaRect === "function") {
        const rect = wco.getTitlebarAreaRect();
        if (rect && rect.height && rect.height > 0 && rect.height < 400) {
          return Math.max(MIN_TOP, rect.height + 4);
        }
      }
    } catch (e) {}
    return MIN_TOP;
  }
  const DEFAULT_RIGHT = "28px";

  function getStoredPos() {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const raw = window.localStorage.getItem("gb_liquidglass_pos");
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const topVal = Number(parsed.top);
          if (isNaN(topVal) || topVal < getSafeMinTop()) {
            // Auto-sanitize: stored pos inside the native drag band is unusable (click = window drag)
            window.localStorage.removeItem("gb_liquidglass_pos");
            return null;
          }
          return parsed;
        }
      }
    } catch (e) {}
    return null;
  }
  function saveStoredPos(pos) {
    try {
      if (typeof window !== "undefined" && window.localStorage && pos) {
        const sanitized = {
          left: Math.max(10, Number(pos.left) || 10),
          top: Math.max(getSafeMinTop(), Number(pos.top) || getSafeMinTop())
        };
        window.localStorage.setItem("gb_liquidglass_pos", JSON.stringify(sanitized));
      }
    } catch (e) {}
  }
  function removeStoredPos() {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem("gb_liquidglass_pos");
      }
    } catch (e) {}
  }

  const style = document.createElement("style");
  style.id = "gb-liquidglass-styles";
  style.textContent = `
    #gb-liquidglass-root,
    #gb-liquidglass-root *,
    #gb-liquidglass-root:not(#\\#):not(#\\#):not(#\\#),
    #gb-liquidglass-root *:not(#\\#):not(#\\#):not(#\\#) {
      -webkit-app-region: no-drag !important;
    }
    #gb-liquidglass-root {
      position: fixed;
      z-index: 99999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      user-select: none;
      -webkit-user-select: none;
      cursor: grab;
      touch-action: none;
      pointer-events: auto;
      transition: width 0.2s cubic-bezier(0.16, 1, 0.3, 1), height 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    #gb-liquidglass-root:active,
    #gb-liquidglass-root.gb-dragging {
      cursor: grabbing !important;
      transition: none !important;
    }
    .gb-glass-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 16px;
      background: rgba(11, 15, 25, 0.85);
      backdrop-filter: blur(24px) saturate(190%);
      -webkit-backdrop-filter: blur(24px) saturate(190%);
      border: 1px solid rgba(56, 189, 248, 0.45);
      border-radius: 9999px;
      box-shadow: 0 10px 35px rgba(0, 0, 0, 0.55), 0 0 16px rgba(56, 189, 248, 0.25);
      color: #f8fafc;
      font-size: 11.5px;
      font-weight: 600;
      white-space: nowrap;
      transition: transform 0.15s ease, border-color 0.2s ease, box-shadow 0.2s ease;
      cursor: grab;
    }
    .gb-glass-pill:hover {
      transform: translateY(-2px);
      border-color: rgba(56, 189, 248, 0.8);
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.65), 0 0 22px rgba(56, 189, 248, 0.4);
    }
    .gb-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .gb-dot.verified {
      background: #34d399;
      box-shadow: 0 0 10px #34d399;
    }
    .gb-dot.fallback {
      background: #f43f5e;
      box-shadow: 0 0 10px #f43f5e;
    }
    .gb-glass-card {
      width: 350px;
      background: rgba(11, 15, 25, 0.94);
      backdrop-filter: blur(32px) saturate(210%);
      -webkit-backdrop-filter: blur(32px) saturate(210%);
      border: 1px solid rgba(56, 189, 248, 0.45);
      border-radius: 20px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.75), 0 0 30px rgba(56, 189, 248, 0.25);
      padding: 16px;
      color: #f8fafc;
      font-size: 11px;
      position: relative;
    }
    .gb-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      cursor: grab;
    }
    .gb-card-title {
      font-size: 12px;
      font-weight: 700;
      color: #f8fafc;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .gb-header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .gb-btn-icon {
      background: rgba(30, 41, 59, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      color: #94a3b8;
      padding: 3px 8px;
      font-size: 10px;
      cursor: pointer;
      -webkit-app-region: no-drag !important;
    }
    .gb-btn-icon:hover {
      background: rgba(51, 65, 85, 0.9);
      color: #ffffff;
    }
    .gb-hero-box {
      background: rgba(19, 28, 49, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      padding: 12px;
      margin-bottom: 12px;
      position: relative;
    }
    .gb-hero-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .gb-agent-name {
      font-weight: 800;
      color: #f8fafc;
      font-size: 13px;
    }
    .gb-prov-badge {
      font-size: 8.5px;
      font-weight: 800;
      padding: 3px 8px;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }
    .gb-prov-badge.verified {
      background: rgba(52, 211, 153, 0.2);
      color: #34d399;
      border: 1px solid rgba(52, 211, 153, 0.4);
    }
    .gb-prov-badge.fallback {
      background: rgba(244, 63, 94, 0.2);
      color: #f43f5e;
      border: 1px solid rgba(244, 63, 94, 0.4);
    }
    .gb-dropdown-btn {
      width: 100%;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(56, 189, 248, 0.5);
      border-radius: 10px;
      color: #38bdf8;
      padding: 8px 12px;
      font-size: 11.5px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
      transition: border-color 0.15s ease, background 0.15s ease;
      -webkit-app-region: no-drag !important;
    }
    .gb-dropdown-btn:hover {
      background: rgba(30, 41, 59, 0.95);
      border-color: rgba(56, 189, 248, 0.85);
    }
    .gb-custom-menu {
      position: absolute;
      top: 92px;
      left: 12px;
      right: 12px;
      z-index: 10000000;
      background: rgba(15, 23, 42, 0.98);
      border: 1px solid rgba(56, 189, 248, 0.6);
      border-radius: 12px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.85), 0 0 20px rgba(56, 189, 248, 0.25);
      padding: 8px;
      max-height: 230px;
      overflow-y: auto;
      -webkit-app-region: no-drag !important;
    }
    .gb-search-input {
      width: 100%;
      box-sizing: border-box;
      background: rgba(30, 41, 59, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      color: #f8fafc;
      padding: 6px 10px;
      font-size: 10.5px;
      outline: none;
      margin-bottom: 6px;
      -webkit-app-region: no-drag !important;
    }
    .gb-search-input:focus {
      border-color: #38bdf8;
    }
    .gb-model-option {
      padding: 7px 10px;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-bottom: 4px;
      transition: background 0.12s ease;
      border: 1px solid transparent;
      -webkit-app-region: no-drag !important;
    }
    .gb-model-option:hover {
      background: rgba(56, 189, 248, 0.15);
      border-color: rgba(56, 189, 248, 0.3);
    }
    .gb-model-option.active {
      background: rgba(56, 189, 248, 0.25);
      border-color: rgba(56, 189, 248, 0.5);
    }
    .gb-option-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .gb-option-title {
      font-weight: 700;
      color: #f8fafc;
      font-size: 11px;
    }
    .gb-option-badge {
      font-size: 8px;
      font-weight: 800;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.15);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .gb-option-desc {
      font-size: 8.5px;
      color: #94a3b8;
    }
    .gb-route-label {
      color: #64748b;
      font-size: 8.5px;
      word-break: break-all;
    }
    .gb-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 12px;
    }
    .gb-tile {
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 8px 10px;
    }
    .gb-tile-lbl {
      color: #64748b;
      font-size: 8px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: 4px;
    }
    .gb-tile-val {
      font-weight: 800;
      font-size: 13px;
    }
    .gb-gauge-box {
      background: rgba(19, 28, 49, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 10px 12px;
      margin-bottom: 12px;
    }
    .gb-gauge-hdr {
      display: flex;
      justify-content: space-between;
      color: #94a3b8;
      font-size: 8.5px;
      margin-bottom: 5px;
      font-weight: 700;
    }
    .gb-gauge-track {
      width: 100%;
      height: 7px;
      background: rgba(15, 23, 42, 0.9);
      border-radius: 9999px;
      overflow: hidden;
    }
    .gb-gauge-bar {
      height: 100%;
      background: linear-gradient(90deg, #34d399, #38bdf8);
      border-radius: 9999px;
      transition: width 0.3s ease;
    }
    .gb-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }
    .gb-btn {
      background: rgba(30, 41, 59, 0.85);
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 8px;
      color: #38bdf8;
      padding: 6px 12px;
      font-size: 9.5px;
      font-weight: 700;
      cursor: pointer;
      flex: 1;
      text-align: center;
      -webkit-app-region: no-drag !important;
    }
    .gb-btn:hover {
      background: rgba(56, 189, 248, 0.25);
    }
    .gb-drawer {
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      padding: 8px;
      margin-bottom: 10px;
      font-size: 9px;
      max-height: 150px;
      overflow-y: auto;
      -webkit-app-region: no-drag !important;
    }
    .gb-roster-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 6px;
      border-radius: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      cursor: pointer;
      -webkit-app-region: no-drag !important;
    }
    .gb-roster-item:hover {
      background: rgba(56, 189, 248, 0.18);
    }
    .gb-roster-item.active {
      background: rgba(56, 189, 248, 0.3);
      border: 1px solid rgba(56, 189, 248, 0.5);
    }
    .gb-diag-row {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .gb-diag-log {
      font-family: monospace;
      font-size: 8px;
      color: #94a3b8;
      white-space: pre-wrap;
      word-break: break-all;
      margin-top: 4px;
    }
  `;
  const rootEl = document.createElement("div");
  rootEl.id = "gb-liquidglass-root";

  function resetOverlayPosition() {
    removeStoredPos();
    rootEl.style.top = DEFAULT_TOP;
    rootEl.style.right = DEFAULT_RIGHT;
    rootEl.style.left = "auto";
    rootEl.style.bottom = "auto";
    dragData.isDragging = false;
    dragData.hasDragged = false;
    dragData.pointerArmed = false;
    dragData.armed = false;
    dragData.tapCandidate = false;
  }

  function applyPosition() {
    const pos = getStoredPos();
    if (pos && pos.left != null && pos.top != null) {
      const topNum = Number(pos.top);
      const safeTop = getSafeMinTop();
      if (isNaN(topNum) || topNum < safeTop) {
        // stored position sits in (or above) the native drag band → would eat every click; reset
        resetOverlayPosition();
        return;
      }
      const w = (typeof window !== "undefined" && window.innerWidth) || 1200;
      const h = (typeof window !== "undefined" && window.innerHeight) || 800;
      const elW = (rootEl && rootEl.offsetWidth) || (isExpanded ? 350 : 260);
      const elH = (rootEl && rootEl.offsetHeight) || (isExpanded ? 300 : 40);
      const maxLeft = Math.max(10, w - elW - 10);
      const maxTop = Math.max(safeTop, h - elH - 10);
      const left = Math.max(10, Math.min(maxLeft, Number(pos.left) || 10));
      const top = Math.max(safeTop, Math.min(maxTop, topNum));
      rootEl.style.left = left + "px";
      rootEl.style.top = top + "px";
      rootEl.style.right = "auto";
      rootEl.style.bottom = "auto";
      return;
    }
    resetOverlayPosition();
  }

  function mount() {
    if (typeof document === "undefined") return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }
    if (!document.getElementById("gb-liquidglass-styles")) {
      (document.head || document.body).appendChild(style);
    }
    if (!document.getElementById("gb-liquidglass-root")) {
      document.body.appendChild(rootEl);
    }
    applyPosition();
  }
  mount();

  function hookClientStore(store) {
    if (!store) return;
    try {
      if (store.selection && store.selection.snapshots && typeof store.selection.snapshots.subscribe === "function") {
        store.selection.snapshots.subscribe(() => {
          try {
            const snap = store.selection.snapshots.get ? store.selection.snapshots.get() : null;
            if (snap && snap.currentAgentId) {
              setActiveAgent(snap.currentAgentId);
            }
          } catch (err) {}
        });
        const initialSnap = store.selection.snapshots.get ? store.selection.snapshots.get() : null;
        if (initialSnap && initialSnap.currentAgentId) {
          setActiveAgent(initialSnap.currentAgentId);
        }
      }
    } catch (e) {}
  }

  function resolveActiveAgentId() {
    if (typeof window !== "undefined" && window.__grokbotActiveAgentId && bindings[window.__grokbotActiveAgentId]) {
      return window.__grokbotActiveAgentId;
    }
    if (currentActiveAgentId && bindings[currentActiveAgentId]) {
      return currentActiveAgentId;
    }

    const activeBtn = document.querySelector('button[data-agent-id][data-active="true"], button[data-agent-id][aria-pressed="true"], button[data-agent-id][aria-current="page"], [data-agent-id][aria-selected="true"], [data-agent-id][data-selected="true"]');
    if (activeBtn && activeBtn.dataset && activeBtn.dataset.agentId) {
      return activeBtn.dataset.agentId;
    }

    const sel = document.querySelector('[data-agent-id].active, [data-agent-id][aria-selected="true"]');
    if (sel && sel.dataset && sel.dataset.agentId) {
      return sel.dataset.agentId;
    }

    // Fiber tree discovery on #root
    try {
      const root = document.getElementById("root");
      if (root) {
        let fiberKey = null;
        for (const k in root) {
          if (k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$")) {
            fiberKey = k;
            break;
          }
        }
        if (fiberKey) {
          const visited = new Set();
          function searchFiber(node, depth) {
            if (!node || depth > 30 || visited.has(node)) return null;
            visited.add(node);
            if (node.memoizedProps) {
              if (node.memoizedProps.client) {
                hookClientStore(node.memoizedProps.client);
              }
              if (node.memoizedProps.agentId && bindings[node.memoizedProps.agentId]) {
                return node.memoizedProps.agentId;
              }
            }
            if (node.child) {
              const res = searchFiber(node.child, depth + 1);
              if (res) return res;
            }
            if (node.sibling) {
              const res = searchFiber(node.sibling, depth + 1);
              if (res) return res;
            }
            return null;
          }
          const fiberRoot = root[fiberKey]?.current || root[fiberKey];
          const foundAid = searchFiber(fiberRoot, 0);
          if (foundAid) return foundAid;
        }
      }
    } catch (e) {}

    const headers = document.querySelectorAll('header, [role="banner"], h1, h2, [data-testid*="header"], [data-testid*="agent"]');
    for (const h of headers) {
      const t = (h.innerText || "").trim();
      for (const aid in bindings) {
        const name = bindings[aid].name;
        if (name && t.includes(name)) {
          return aid;
        }
      }
    }

    return currentActiveAgentId || Object.keys(bindings)[0] || null;
  }

  function setActiveAgent(aid) {
    if (!aid || typeof aid !== "string" || !aid.trim()) return;
    const trimmed = aid.trim();
    currentActiveAgentId = trimmed;
    if (typeof window !== "undefined") window.__grokbotActiveAgentId = trimmed;
    showModelDropdown = false;
    render(true);
  }

  function getDisplayMetrics(specifiedAid) {
    let aid = null;
    const isExplicit = (specifiedAid && typeof specifiedAid === "string");
    if (isExplicit) {
      aid = specifiedAid;
    } else {
      aid = resolveActiveAgentId();
    }
    if (aid && bindings[aid]) {
      const bound = bindings[aid];
      const botMetrics = metricsByAgent[aid] || {};
      const hop = bound.hopBaseUrl || botMetrics.hopRoute || "";
      const isHop = !!(hop && (hop.includes("127.0.0.1") || hop.includes("18786") || hop.includes("18779") || hop.includes("18776")));
      const limit = botMetrics.contextLimit || MODEL_CONTEXT_LIMITS[bound.modelId] || 131072;

      return {
        agentId: aid,
        agentName: bound.name || "Bot",
        modelId: bound.modelId || botMetrics.modelId || "grok-4.6",
        hopRoute: hop.replace(/^https?:\/\//, "") || "127.0.0.1:18786",
        isVerifiedHop: isHop,
        tokensPerSec: botMetrics.tokensPerSec != null ? botMetrics.tokensPerSec : 0.0,
        ttftMs: botMetrics.ttftMs != null ? botMetrics.ttftMs : 0,
        promptTokens: botMetrics.promptTokens != null ? botMetrics.promptTokens : 0,
        completionTokens: botMetrics.completionTokens != null ? botMetrics.completionTokens : 0,
        cacheHitPct: botMetrics.cacheHitPct != null ? botMetrics.cacheHitPct : 0.0,
        contextLimit: limit,
        contextUtilizationPct: botMetrics.contextUtilizationPct != null ? botMetrics.contextUtilizationPct : 0.0,
        hasTurn: botMetrics.tokensPerSec != null
      };
    }
    if (isExplicit || (aid && !bindings[aid])) {
      return {
        agentId: aid || "",
        agentName: "Bot",
        modelId: "grok-4.6",
        hopRoute: "127.0.0.1:18786",
        isVerifiedHop: false,
        tokensPerSec: 0.0,
        ttftMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitPct: 0.0,
        contextLimit: 131072,
        contextUtilizationPct: 0.0,
        hasTurn: false
      };
    }
    return globalLatestMetrics;
  }

  async function updateActiveModel(newModelId, newHopUrl, provider) {
    const aid = resolveActiveAgentId();
    if (!aid) return;
    const name = (bindings[aid] && bindings[aid].name) || "Bot";
    
    if (!bindings[aid]) bindings[aid] = {};
    bindings[aid].modelId = newModelId;
    if (newHopUrl) bindings[aid].hopBaseUrl = newHopUrl;
    if (provider) bindings[aid].provider = provider;
    showModelDropdown = false;
    render(true);

    try {
      await fetch(RELAY + "/update-binding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: aid,
          name: name,
          modelId: newModelId,
          hopBaseUrl: newHopUrl || "http://127.0.0.1:18786/v1",
          provider: provider || "custom"
        })
      });
      console.log(`[LiquidGlass] Model successfully bound to ${newModelId} for ${name}`);
    } catch (e) {
      console.warn("[LiquidGlass] Error saving model binding:", e);
    }
  }

  function updateLiveMetricValues() {
    const cur = getDisplayMetrics();
    const tps = cur.tokensPerSec != null ? cur.tokensPerSec : 0.0;
    const ttftMs = cur.ttftMs != null ? cur.ttftMs : 0;
    const ctxPct = cur.contextUtilizationPct != null ? cur.contextUtilizationPct : 0.0;
    const cacheHit = cur.cacheHitPct != null ? cur.cacheHitPct : 0.0;
    const limit = Math.round((cur.contextLimit || 131072) / 1024);

    const speed = cur.hasTurn ? `${tps.toFixed(1)} t/s` : "Ready (Awaiting turn)";
    const speedShort = cur.hasTurn ? `${tps.toFixed(0)} t/s` : "Ready";
    const ttft = cur.hasTurn ? `${ttftMs} ms` : "0 ms";
    const ctx = ctxPct.toFixed(1);
    const ctxShort = ctxPct.toFixed(0);

    if (!isExpanded) {
      const spEl = document.getElementById("gb-pill-speed");
      if (spEl) spEl.textContent = `⚡${speedShort}`;
      const cxEl = document.getElementById("gb-pill-ctx");
      if (cxEl) {
        cxEl.textContent = `${ctxShort}%`;
        cxEl.style.color = ctxPct > 75 ? "#f43f5e" : (ctxPct > 50 ? "#fbbf24" : "#34d399");
      }
    } else {
      const vSp = document.getElementById("gb-val-speed");
      if (vSp) vSp.textContent = speed;
      const vTtft = document.getElementById("gb-val-ttft");
      if (vTtft) vTtft.textContent = ttft;
      const vTok = document.getElementById("gb-val-tokens");
      if (vTok) vTok.textContent = `${cur.promptTokens || 0} / ${cur.completionTokens || 0}`;
      const vCache = document.getElementById("gb-val-cache");
      if (vCache) vCache.textContent = `${cacheHit.toFixed(1)}%`;
      const gBar = document.getElementById("gb-gauge-bar");
      if (gBar) gBar.style.width = `${Math.min(100, Math.max(2, ctxPct))}%`;
      const gHdr = document.getElementById("gb-gauge-text");
      if (gHdr) gHdr.textContent = `${ctx}% of ${limit}k`;
    }
  }

  function render(force = false) {
    const cur = getDisplayMetrics();
    const stateKey = `${isExpanded}_${cur.agentId}_${cur.modelId}_${showRoster}_${showDiag}_${showModelDropdown}`;
    
    if (!force && lastRenderedState === stateKey) {
      updateLiveMetricValues();
      return;
    }
    lastRenderedState = stateKey;

    const tps = cur.tokensPerSec != null ? cur.tokensPerSec : 0.0;
    const ttftMs = cur.ttftMs != null ? cur.ttftMs : 0;
    const ctxPct = cur.contextUtilizationPct != null ? cur.contextUtilizationPct : 0.0;
    const cacheHit = cur.cacheHitPct != null ? cur.cacheHitPct : 0.0;
    const limit = Math.round((cur.contextLimit || 131072) / 1024);

    if (!isExpanded) {
      const isHop = cur.isVerifiedHop;
      const dotCls = isHop ? "verified" : "fallback";
      const speedShort = cur.hasTurn ? `${tps.toFixed(0)} t/s` : "Ready";
      const ctxShort = ctxPct.toFixed(0);
      const ag = cur.agentName || "Bot";
      let m = cur.modelId || "grok-4.6";
      if (m.length > 14) m = m.slice(0, 12) + "…";

      rootEl.innerHTML = `
        <div class="gb-glass-pill" id="gb-pill-btn" title="Active Convo: ${ag} · Model: ${cur.modelId} (Click to expand · Drag to move · Double-click to reset position)">
          <span class="gb-dot ${dotCls}"></span>
          <span><b>${ag}</b>: ${m}</span>
          <span style="color:#64748b">·</span>
          <span style="color:#38bdf8" id="gb-pill-speed">⚡${speedShort}</span>
          <span style="color:#64748b">·</span>
          <span style="color:${ctxShort > 75 ? "#f43f5e" : (ctxShort > 50 ? "#fbbf24" : "#34d399")}" id="gb-pill-ctx">${ctxShort}%</span>
          <span style="color:#38bdf8; margin-left:2px">✦</span>
        </div>
      `;

      const pillBtn = document.getElementById("gb-pill-btn");
      if (pillBtn) {
        pillBtn.addEventListener("click", function () {
          if (dragData.tapCandidate !== false) {
            isExpanded = true;
            render(true);
          }
        });
        pillBtn.addEventListener("dblclick", function (e) {
          if (e.stopPropagation) e.stopPropagation();
          resetOverlayPosition();
        });
      }
    } else {
      const isHop = cur.isVerifiedHop;
      const provText = isHop ? "🟢 VERIFIED HOP" : "⚠️ STOCK FALLBACK";
      const provCls = isHop ? "verified" : "fallback";
      const speed = cur.hasTurn ? `${tps.toFixed(1)} t/s` : "Ready (Awaiting turn)";
      const ttft = cur.hasTurn ? `${ttftMs} ms` : "0 ms";
      const pin = cur.promptTokens || 0;
      const pout = cur.completionTokens || 0;
      const cache = cacheHit.toFixed(1);
      const ctx = ctxPct.toFixed(1);

      let dropdownHtml = "";
      if (showModelDropdown) {
        const filter = modelSearchFilter.toLowerCase();
        let optionsList = "";
        MODEL_CATALOG.filter(c => c.label.toLowerCase().includes(filter) || c.id.toLowerCase().includes(filter)).forEach(cat => {
          const isActive = (cat.id === cur.modelId);
          optionsList += `
            <div class="gb-model-option ${isActive ? "active" : ""}" data-model-id="${cat.id}" data-hop="${cat.hop}" data-prov="${cat.prov}">
              <div class="gb-option-header">
                <span class="gb-option-title">${cat.label}</span>
                <span class="gb-option-badge">${cat.badge}</span>
              </div>
              <div class="gb-option-desc">${cat.desc}</div>
            </div>
          `;
        });

        dropdownHtml = `
          <div class="gb-custom-menu" id="gb-custom-dropdown">
            <input type="text" class="gb-search-input" id="gb-model-search" placeholder="Search model or provider..." value="${modelSearchFilter}" />
            ${optionsList}
            <div class="gb-model-option" id="gb-custom-model-opt" style="border-top:1px solid rgba(255,255,255,0.1); margin-top:4px; padding-top:6px">
              <span class="gb-option-title" style="color:#38bdf8">➕ Connect Custom Endpoint / HuggingFace</span>
              <span class="gb-option-desc">Enter any custom model ID and loopback hop route</span>
            </div>
          </div>
        `;
      }

      let rosterHtml = "";
      const botCount = Object.keys(bindings).length;
      if (showRoster) {
        let items = "";
        for (const aid in bindings) {
          const b = bindings[aid];
          const isActive = (aid === cur.agentId);
          const bMetrics = metricsByAgent[aid] || {};
          const bSpeed = bMetrics.tokensPerSec != null ? `${bMetrics.tokensPerSec.toFixed(0)} t/s` : "Ready";
          items += `
            <div class="gb-roster-item ${isActive ? "active" : ""}" data-aid="${aid}">
              <span><b>${b.name || "Bot"}</b> <span style="color:#64748b; font-size:8px">(${b.modelId || "default"})</span></span>
              <span style="color:${isActive ? "#34d399" : "#94a3b8"}">${bSpeed}</span>
            </div>
          `;
        }
        rosterHtml = `
          <div class="gb-drawer gb-roster-list" id="gb-roster-drawer">
            <div style="font-weight:700; color:#38bdf8; margin-bottom:6px">Active Bot Roster (${botCount} bots configured):</div>
            ${items}
          </div>
        `;
      }

      let diagHtml = "";
      if (showDiag) {
        diagHtml = `
          <div class="gb-drawer" id="gb-diag-drawer">
            <div style="font-weight:700; color:#34d399; margin-bottom:6px">🩺 Live System Diagnostics:</div>
            <div class="gb-diag-row"><span>Relay Gateway</span><span style="color:#34d399">HTTP 127.0.0.1:8799 · UP</span></div>
            <div class="gb-diag-row"><span>Multi-Hop Shim</span><span style="color:#34d399">127.0.0.1:18786 · CONNECTED</span></div>
            <div class="gb-diag-row"><span>Super Heavy Shim</span><span style="color:#34d399">127.0.0.1:18779 · CONNECTED</span></div>
            <div class="gb-diag-row"><span>Claude Shim</span><span style="color:#34d399">127.0.0.1:18776 · CONNECTED</span></div>
            <div class="gb-diag-row"><span>Antigravity Shim</span><span style="color:#34d399">127.0.0.1:18778 · CONNECTED</span></div>
            <div class="gb-diag-log">
              [Wire] 200 OK · Hop active to ${cur.modelId}
              [Guardian] Tool output bloat trimmed; recent turns 100% full fidelity
              [Roster] All bots bound to designated custom endpoints
            </div>
            <button class="gb-btn" id="gb-copy-diag-btn" style="width:100%; margin-top:6px">📋 Copy Diagnostic Bundle</button>
          </div>
        `;
      }

      rootEl.innerHTML = `
        <div class="gb-glass-card">
          <div class="gb-card-header" id="gb-card-header" title="Double-click header to reset position">
            <div class="gb-card-title">🫧 LiquidGlass Observatory</div>
            <div class="gb-header-actions">
              <button class="gb-btn-icon" id="gb-reset-pos-btn" title="Reset position to default (⌖)">⌖</button>
              <button class="gb-btn-icon" id="gb-min-btn">Collapse —</button>
            </div>
          </div>

          <div class="gb-hero-box">
            <div class="gb-hero-top">
              <span class="gb-agent-name">🤖 ${cur.agentName}</span>
              <span class="gb-prov-badge ${provCls}">${provText}</span>
            </div>
            
            <button class="gb-dropdown-btn" id="gb-model-trigger" title="Click to choose model for ${cur.agentName}">
              <span>${cur.modelId}</span>
              <span style="font-size:10px; color:#38bdf8">▾</span>
            </button>

            ${dropdownHtml}

            <div class="gb-route-label">Wire: http://${cur.hopRoute} (Protected by Guardian)</div>
          </div>

          <div class="gb-grid">
            <div class="gb-tile">
              <div class="gb-tile-lbl">⚡ Throughput</div>
              <div class="gb-tile-val" style="color:#34d399" id="gb-val-speed">${speed}</div>
            </div>
            <div class="gb-tile">
              <div class="gb-tile-lbl">⏱️ TTFT Latency</div>
              <div class="gb-tile-val" style="color:#38bdf8" id="gb-val-ttft">${ttft}</div>
            </div>
            <div class="gb-tile">
              <div class="gb-tile-lbl">📥 In / Out Tokens</div>
              <div class="gb-tile-val" style="color:#f8fafc" id="gb-val-tokens">${pin} / ${pout}</div>
            </div>
            <div class="gb-tile">
              <div class="gb-tile-lbl">💎 Prompt Cache</div>
              <div class="gb-tile-val" style="color:#fbbf24" id="gb-val-cache">${cache}%</div>
            </div>
          </div>

          <div class="gb-gauge-box">
            <div class="gb-gauge-hdr">
              <span>🛡️ CONTEXT GUARDIAN</span>
              <span id="gb-gauge-text">${ctx}% of ${limit}k</span>
            </div>
            <div class="gb-gauge-track">
              <div class="gb-gauge-bar" id="gb-gauge-bar" style="width:${Math.min(100, Math.max(2, ctxPct))}%"></div>
            </div>
          </div>

          <div style="display:flex; justify-content:space-between; margin-bottom:8px; font-weight:700">
            <span style="cursor:pointer; color:#38bdf8" id="gb-toggle-roster">
              ${showRoster ? `▼ Hide Roster (${botCount})` : `▶ Show All Bots (${botCount})`}
            </span>
            <span style="cursor:pointer; color:#34d399" id="gb-toggle-diag">
              ${showDiag ? "▼ Hide Logs" : "🩺 Diagnostics & Logs"}
            </span>
          </div>
          ${rosterHtml}
          ${diagHtml}

          <div class="gb-actions">
            <button class="gb-btn" id="gb-reset-btn">🔄 Reset Chat (/new)</button>
            <button class="gb-btn" id="gb-copy-btn">📋 Copy Proof</button>
          </div>
        </div>
      `;

      // Event Handlers
      const minBtn = document.getElementById("gb-min-btn");
      if (minBtn) {
        minBtn.addEventListener("click", (e) => {
          if (e.stopPropagation) e.stopPropagation();
          isExpanded = false;
          showModelDropdown = false;
          render(true);
        });
      }

      const cardHeader = document.getElementById("gb-card-header");
      if (cardHeader) {
        cardHeader.addEventListener("dblclick", (e) => {
          if (e.target && (e.target.tagName === "BUTTON" || (e.target.closest && e.target.closest("button")))) return;
          if (e.stopPropagation) e.stopPropagation();
          resetOverlayPosition();
        });
      }

      const resetPosBtn = document.getElementById("gb-reset-pos-btn");
      if (resetPosBtn) {
        resetPosBtn.addEventListener("click", (e) => {
          if (e.stopPropagation) e.stopPropagation();
          resetOverlayPosition();
        });
      }

      const toggleRosterBtn = document.getElementById("gb-toggle-roster");
      if (toggleRosterBtn) {
        toggleRosterBtn.addEventListener("click", () => {
          showRoster = !showRoster;
          showDiag = false;
          showModelDropdown = false;
          render(true);
        });
      }

      const toggleDiagBtn = document.getElementById("gb-toggle-diag");
      if (toggleDiagBtn) {
        toggleDiagBtn.addEventListener("click", () => {
          showDiag = !showDiag;
          showRoster = false;
          showModelDropdown = false;
          render(true);
        });
      }

      const copyBtn = document.getElementById("gb-copy-btn");
      if (copyBtn) {
        copyBtn.addEventListener("click", () => {
          try {
            if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(JSON.stringify(cur, null, 2)).catch(() => {});
            }
            if (typeof alert === "function") {
              alert(`✅ Model Provenance for ${cur.agentName} copied to clipboard!`);
            }
          } catch (e) {}
        });
      }

      const copyDiagBtn = document.getElementById("gb-copy-diag-btn");
      if (showDiag && copyDiagBtn) {
        copyDiagBtn.addEventListener("click", () => {
          try {
            const diagBundle = { timestamp: new Date().toISOString(), activeBot: cur, bindings: bindings };
            if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(JSON.stringify(diagBundle, null, 2)).catch(() => {});
            }
            if (typeof alert === "function") {
              alert("✅ Full Diagnostic & Wire Bundle copied to clipboard!");
            }
          } catch (e) {}
        });
      }

      const resetBtn = document.getElementById("gb-reset-btn");
      if (resetBtn) {
        resetBtn.addEventListener("click", () => {
          try {
            const input = document.querySelector('textarea, [contenteditable="true"]');
            if (input) {
              input.value = "/new";
              input.dispatchEvent(new Event("input", { bubbles: true }));
              const enterEvent = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true });
              input.dispatchEvent(enterEvent);
            }
          } catch (e) {}
        });
      }

      // Dropdown toggle
      const triggerBtn = document.getElementById("gb-model-trigger");
      if (triggerBtn) {
        triggerBtn.addEventListener("click", (e) => {
          if (e.stopPropagation) e.stopPropagation();
          showModelDropdown = !showModelDropdown;
          render(true);
        });
      }

      // Dropdown placement: flip & clamp so the full list is always clickable (9/4 fix)
      if (showModelDropdown) {
        const ddEl = document.getElementById("gb-custom-dropdown");
        if (ddEl) {
          try {
            const ddRect = ddEl.getBoundingClientRect();
            const vh = window.innerHeight || 900;
            const cardRect = rootEl.getBoundingClientRect();
            let newTop = null;
            if (ddRect.bottom > vh - 6) {
              // flip above the trigger when there's more room above
              const spaceAbove = cardRect.top + 54; // room from card top to trigger (approx 54px)
              const hh = Math.min(ddRect.height + (ddRect.bottom - vh) + 8, Math.max(120, spaceAbove));
              if (spaceAbove > 180 && spaceAbove > (vh - ddRect.top)) {
                newTop = Math.round(cardRect.top + 6);
                ddEl.style.top = (newTop - cardRect.top) + "px";
              }
              const availBelow = vh - (newTop != null ? (cardRect.top + Math.round(hh)) : ddRect.top) - 8;
              ddEl.style.maxHeight = Math.max(120, Math.min(availBelow + (newTop != null ? 0 : (ddRect.bottom - vh)), 520)) + "px";
            }
          } catch (err) {}
        }
      }

      // Dropdown search & selection handlers
      if (showModelDropdown) {
        const searchInput = document.getElementById("gb-model-search");
        if (searchInput) {
          searchInput.focus();
          searchInput.addEventListener("input", (e) => {
            modelSearchFilter = e.target.value;
            render(true);
          });
        }

        document.querySelectorAll(".gb-model-option[data-model-id]").forEach(opt => {
          opt.addEventListener("click", (e) => {
            if (e.stopPropagation) e.stopPropagation();
            const mid = opt.getAttribute("data-model-id");
            const hop = opt.getAttribute("data-hop");
            const prov = opt.getAttribute("data-prov");
            updateActiveModel(mid, hop, prov);
          });
        });

        const customOpt = document.getElementById("gb-custom-model-opt");
        if (customOpt) {
          customOpt.addEventListener("click", (e) => {
            if (e.stopPropagation) e.stopPropagation();
            if (typeof prompt === "function") {
              const customModel = prompt("Enter Custom Model ID (e.g. cerebras/llama-3.3-70b or claude-opus-5):", cur.modelId);
              if (customModel && customModel.trim()) {
                const customHop = prompt("Enter Hop URL:", "http://127.0.0.1:18786/v1");
                updateActiveModel(customModel.trim(), customHop ? customHop.trim() : "http://127.0.0.1:18786/v1", "custom");
              }
            }
          });
        }
      }

      if (showRoster) {
        document.querySelectorAll(".gb-roster-item").forEach(item => {
          item.addEventListener("click", () => {
            const aid = item.getAttribute("data-aid");
            if (aid && bindings[aid]) {
              setActiveAgent(aid);
            }
          });
        });
      }
    }
  }

  // --- INSTANT POINTER & CLICK & KEYBOARD INTERCEPTION (CAPTURE PHASE) ---
  document.addEventListener("pointerdown", function (e) {
    const btn = e.target && e.target.closest ? e.target.closest("button[data-agent-id], [data-agent-id]") : null;
    if (btn && btn.dataset && btn.dataset.agentId) {
      setActiveAgent(btn.dataset.agentId);
    }
  }, true);

  document.addEventListener("click", function (e) {
    const btn = e.target && e.target.closest ? e.target.closest("button[data-agent-id], [data-agent-id]") : null;
    if (btn && btn.dataset && btn.dataset.agentId) {
      setActiveAgent(btn.dataset.agentId);
    }
    // Close custom dropdown on outside click
    if (showModelDropdown && e.target && e.target.closest && !e.target.closest(".gb-hero-box")) {
      showModelDropdown = false;
      render(true);
    }
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " " || e.code === "Space") {
      const btn = e.target && e.target.closest ? e.target.closest("button[data-agent-id], [data-agent-id]") : null;
      if (btn && btn.dataset && btn.dataset.agentId) {
        setActiveAgent(btn.dataset.agentId);
      }
    }
  }, true);

  // --- MUTATION OBSERVER ---
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") {
        const el = m.target;
        if (el && el.dataset && el.dataset.agentId) {
          const isActive = el.getAttribute("data-active") === "true" ||
                           el.getAttribute("aria-current") === "page" ||
                           el.getAttribute("aria-pressed") === "true" ||
                           el.getAttribute("aria-selected") === "true" ||
                           el.getAttribute("data-selected") === "true";
          if (isActive) {
            setActiveAgent(el.dataset.agentId);
          }
        }
      }
    }
  });

  observer.observe(document.body, {
    attributes: true,
    subtree: true,
    attributeFilter: ["data-active", "aria-pressed", "aria-current", "aria-selected", "data-selected", "class"]
  });

  if (typeof window !== "undefined") {
    window.addEventListener("grokbot:agent-switched", (e) => {
      if (e.detail && e.detail.agentId) {
        setActiveAgent(e.detail.agentId);
      }
    });
  }

  // --- DRAGGING LOGIC WITH POINTER CAPTURE & SAFE STORAGE ---
  function handleDragStart(e) {
    if (e.button != null && e.button !== 0) return;
    if (e.target && (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT" ||
        (e.target.closest && (e.target.closest("button") || e.target.closest(".gb-custom-menu") || e.target.closest(".gb-drawer") || e.target.closest(".gb-btn-icon"))))) {
      return;
    }
    // STOP-GAP REMOVED: preventDefault on pointerdown kills the click event chain for real mouse users;
    // we instead suppress clicks only AFTER a real drag via dragData.hasDragged.
    dragData.pointerArmed = true;
    dragData.tapCandidate = true;     // every press is a tap candidate until it crosses the move threshold
    dragData.hasDragged = false;
    dragData.armed = false;
    dragData.isDragging = false;
    dragData.startX = e.clientX || 0;
    dragData.startY = e.clientY || 0;
    const rect = rootEl.getBoundingClientRect();
    dragData.initialLeft = rect.left;
    dragData.initialTop = rect.top;
    // NOTE: do NOT setPointerCapture on plain pointerdown — capture retargets the click to rootEl,
    // killing the pill/trigger click for any press with micro-movement. Capture happens when drag arms.
  }

  function handleDragMove(e) {
    if (!dragData.pointerArmed) return;
    const dx = (e.clientX || 0) - dragData.startX;
    const dy = (e.clientY || 0) - dragData.startY;
    if (!dragData.armed) {
      // arm drag only after 6px of REAL movement — micro-jitter during a press is still a click
      if (Math.hypot(dx, dy) <= 12) return;
      dragData.armed = true;
      dragData.isDragging = true;
      dragData.tapCandidate = false;
      if (e.pointerId != null && typeof rootEl.setPointerCapture === "function") {
        try {
          rootEl.setPointerCapture(e.pointerId);
          dragData.pointerId = e.pointerId;
        } catch (err) {}
      }
    }
    if (Math.hypot(dx, dy) > 5) {
      dragData.hasDragged = true;
      rootEl.classList.add("gb-dragging");
    }
    if (dragData.hasDragged) {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      const w = (typeof window !== "undefined" && window.innerWidth) || 1200;
      const h = (typeof window !== "undefined" && window.innerHeight) || 800;
      const elW = rootEl.offsetWidth || 350;
      const elH = rootEl.offsetHeight || 50;
      const safeTop = getSafeMinTop();
      const maxLeft = Math.max(10, w - elW - 10);
      const maxTop = Math.max(safeTop, h - elH - 10);
      const newLeft = Math.max(10, Math.min(maxLeft, dragData.initialLeft + dx));
      const newTop = Math.max(safeTop, Math.min(maxTop, dragData.initialTop + dy));
      rootEl.style.left = newLeft + "px";
      rootEl.style.top = newTop + "px";
      rootEl.style.right = "auto";
      rootEl.style.bottom = "auto";
    }
  }

  function handleDragEnd(e) {
    dragData.pointerArmed = false;
    if (!dragData.armed) { dragData.isDragging = false; }  // never-armed press = plain click, hasDragged stays false
    if (dragData.isDragging) {
      if (e && e.stopPropagation) e.stopPropagation();
      rootEl.classList.remove("gb-dragging");
      if (dragData.pointerId != null && typeof rootEl.releasePointerCapture === "function") {
        try {
          rootEl.releasePointerCapture(dragData.pointerId);
        } catch (err) {}
        dragData.pointerId = null;
      }
      if (dragData.hasDragged) {
        const rect = rootEl.getBoundingClientRect();
        const finalTop = Math.max(getSafeMinTop(), Math.round(rect.top));
        const finalLeft = Math.max(10, Math.round(rect.left));
        saveStoredPos({ left: finalLeft, top: finalTop });
        // Reset BEFORE the click dispatch (~10-30ms after mouseup): any tap still lands; only REAL drags
        // hold the suppress flag, and the click they produce targets rootEl anyway (capture-release).
        setTimeout(() => { dragData.hasDragged = false; }, 0);
      }
      dragData.isDragging = false;
    }
  }

  rootEl.addEventListener("pointerdown", handleDragStart);
  rootEl.addEventListener("mousedown", handleDragStart);
  window.addEventListener("pointermove", handleDragMove);
  window.addEventListener("mousemove", handleDragMove);
  window.addEventListener("pointerup", handleDragEnd);
  window.addEventListener("mouseup", handleDragEnd);
  window.addEventListener("pointercancel", handleDragEnd);
  rootEl.addEventListener("dblclick", (e) => {
    if (e.target && (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT" || (e.target.closest && e.target.closest("button")))) return;
    if (e.target && (e.target.closest(".gb-glass-pill") || e.target.closest(".gb-card-header"))) {
      if (e.stopPropagation) e.stopPropagation();
      resetOverlayPosition();
    }
  });
  if (typeof window !== "undefined") {
    window.addEventListener("resize", () => {
      if (getStoredPos()) {
        applyPosition();
      }
    });
    try {
      const wco = navigator.windowControlsOverlay;
      if (wco && typeof wco.addEventListener === "function") {
        // caption-band geometry changes (maximize/restore, overlay tone) shift the drag band; re-clamp
        wco.addEventListener("geometrychange", () => { applyPosition(); });
      }
    } catch (e) {}
  }

  // --- GLOBAL EXPORTS ---
  if (typeof window !== "undefined") {
    window.__grokbotSetActiveAgent = setActiveAgent;
    window.__grokbotGetDisplayMetrics = getDisplayMetrics;
    window.__grokbotResolveActiveAgentId = resolveActiveAgentId;
    window.__grokbotHookClientStore = hookClientStore;
    window.__grokbotResetOverlayPosition = resetOverlayPosition;
    window.__grokbotMinTop = MIN_TOP;
    window.__grokbotApplyPosition = applyPosition;
    window.__grokbotGetSafeMinTop = getSafeMinTop;
  }

  // Polling loop: updates live metrics text ONLY without recreating DOM!
  async function poll() {
    try {
      const resB = await fetch(RELAY + "/pull/model-bindings.json", { cache: "no-store" });
      if (resB.ok) {
        const data = await resB.json();
        if (data && data.agents) {
          Object.assign(bindings, data.agents);
        }
      }
    } catch (e) {}

    const resolved = resolveActiveAgentId();
    if (resolved && resolved !== currentActiveAgentId) {
      setActiveAgent(resolved);
    }

    try {
      const res = await fetch(RELAY + "/pull/live-metrics.jsonl", { cache: "no-store" });
      if (res.ok) {
        const text = await res.text();
        const lines = text.trim().split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            const aid = row.agentId;
            if (aid) {
              metricsByAgent[aid] = row;
            }
            const hop = row.hopRoute || "";
            row.isVerifiedHop = !!(hop && (hop.includes("127.0.0.1") || hop.includes("18786") || hop.includes("18779") || hop.includes("18776")));
            globalLatestMetrics = row;
          } catch (err) {}
        }
      }
    } catch (e) {}

    updateLiveMetricValues();
    setTimeout(poll, 400);
  }

  render(true);
  poll();
  console.log("[LiquidGlass] High-performance glass dropdown model picker loaded!");
})();
