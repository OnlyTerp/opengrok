/*BOOST-LG-A 2026-09-05*/
/*GROKBOT_LIQUIDGLASS_IN_APP_INJECTED*/
(function () {
  if (typeof window !== "undefined" && window.__grokbotLiquidGlassInjected) return;
  if (typeof window !== "undefined") window.__grokbotLiquidGlassInjected = true;

  const RELAY = "http://127.0.0.1:8799";
  let isExpanded = false;
  let showRoster = false;
  let showDiag = false;
  let showModelDropdown = false;
  let showModelAddForm = false;
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

  let currentActiveAgentId = (typeof window !== "undefined" && window.__grokbotActiveAgentId) || null;
  if (typeof window !== "undefined" && currentActiveAgentId) {
    window.__grokbotActiveAgentId = currentActiveAgentId;
  }

  let bindings = Object.assign({}, STATIC_BINDINGS);
  let metricsByAgent = {};
  const nativeRepliesByAgent = {};
  const persistedNativeReplies = new Set();
  let nativeReplicaPrefix = null;

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
    "cerebras-llama-3.1-8b": 131072,
    "cerebras-qwen-3.8-27b": 131072,
    "claude-fable-5-1": 1000000,
    "gpt-6-astra-fast": 872000,
    "glm-5.3-flash:fast": 1048576
  };

  // --- UPSTREAM CATALOG: live /v1/models merge into the picker (per-hop cache) ---
  const upstreamCatalogByHop = {};
  function hopOfBinding(hopRoute) {
    if (!hopRoute || typeof hopRoute !== "string") return null;
    try {
      const u = new URL(hopRoute);
      return u.origin;
    } catch (e) { return null; }
  }
  async function refreshUpstreamModels(hopUrl) {
    try {
      if (!hopUrl || typeof hopUrl !== "string") return;
      const base = hopOfBinding(hopUrl);
      if (!base) return;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch(base + "/v1/models", { signal: ctl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!res.ok) return;
      const data = await res.json();
      const items = Array.isArray(data && data.data) ? data.data : (Array.isArray(data && data.models) ? data.models : []);
      const rows = items.map(m => {
        const id = (m && (m.id || m.model || m.name)) || null;
        if (!id || typeof id !== "string") return null;
        // Strip suffix tokens (colon/at scopes, numeric suffixes) for a clean human label; never show raw key material
        const labelParts = id.split(/[:@]/).filter(Boolean);
        const label = labelParts[0] || id;
        const owner = (m && (m.owned_by || m.owner || m.provider || m.organization)) || "";
        const prov = typeof owner === "string" && owner.trim() ? owner.trim().toLowerCase() : "custom";
        return {
          label: "↻ " + label,
          id: id,
          hop: hopUrl,
          prov: prov,
          desc: "live from " + base + "/v1/models",
          badge: "↻ LIVE"
        };
      }).filter(Boolean);
      upstreamCatalogByHop[base] = rows;
      // Rows landed after the dropdown was already rendered with static rows → re-render once so they appear
      if (showModelDropdown && !showModelAddForm && typeof render === "function") {
        try { render(true); } catch (e) {}
      }
    } catch (e) {}
  }

  const MODEL_CATALOG = [
    { label: "MiMo V2.6 Pro (Token Plan)", desc: "Xiaomi MiMo token plan · 1M ctx", id: "mimo-v2.6-pro", hop: "http://127.0.0.1:18784/v1", prov: "mimo", badge: "🚀 MIMO" },
    { label: "MiMo V2.6 Pro UltraSpeed", desc: "PAYG UltraSpeed lane · 1M ctx", id: "mimo-v2.6-pro-ultraspeed", hop: "http://127.0.0.1:18784/v1", prov: "mimo", badge: "🚀 ULTRA" },
    { label: "Muse Spark 1.3 (Max)", desc: "Meta Muse · max reasoning effort", id: "muse-spark-1.3", hop: "http://127.0.0.1:18784/v1", prov: "muse", badge: "🎭 MUSE" },
    { label: "DeepSeek V4.1 (Inco fast)", desc: "Inco high-throughput lane", id: "deepseek-v4.1-flash:fast", hop: "http://127.0.0.1:18784/v1", prov: "deepseek", badge: "🧠 DSV4" },
    { label: "Cerebras Ultra-Speed (Llama 3.3 70B)", desc: "~1,800 tok/s Ultra-Low Latency", id: "cerebras/llama-3.3-70b", hop: "http://127.0.0.1:18786/v1", prov: "cerebras", badge: "🚀 ULTRA" },
    { label: "Cerebras Ultra-Speed (Llama 3.1 8B)", desc: "~2,200 tok/s Instant Reflex", id: "cerebras-llama-3.1-8b", hop: "http://127.0.0.1:18786/v1", prov: "cerebras", badge: "🚀 ULTRA" },
    { label: "Cerebras Ultra-Speed (Qwen 3.8 27B)", desc: "~1,500 tok/s Ultra-Low Latency", id: "cerebras-qwen-3.8-27b", hop: "http://127.0.0.1:18786/v1", prov: "cerebras", badge: "🚀 ULTRA" },
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
    { label: "Grok 4.6 Superheavy", desc: "Superheavy Extended Context", id: "grok-4.6-superheavy", hop: "http://127.0.0.1:18786/v1", prov: "xai", badge: "🪐 HEAVY" },
    { label: "Claude Fable 5.1 (OAuth Plan)", desc: "1M-context Fable 5.1 · adaptive thinking", id: "claude-fable-5-1", hop: "http://127.0.0.1:18776/v1", prov: "claude", badge: "⚡ 5.1" },
    { label: "GPT-6 Astra Fast (Codex)", desc: "272k/872k Astra · fast effort via codex shim", id: "gpt-6-astra-fast", hop: "http://127.0.0.1:18777/v1", prov: "openai", badge: "🪐 FAST" },
    { label: "GLM 5.3 Flash (Inco fast)", desc: "inco :fast lane", id: "glm-5.3-flash:fast", hop: "http://127.0.0.1:18800/v1", prov: "inco", badge: "🔮 INCO" }
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
      max-height: calc(100vh - 90px);
      overflow: hidden;
      display: flex;
      flex-direction: column;
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
    .gb-effort-row {
      display: flex;
      gap: 4px;
      margin-top: 6px;
      flex-wrap: wrap;
    }
    .gb-effort-chip {
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 999px;
      color: #94a3b8;
      padding: 2px 8px;
      font-size: 9.5px;
      font-weight: 600;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      transition: all 0.15s ease;
      -webkit-app-region: no-drag !important;
    }
    .gb-effort-chip:hover {
      border-color: rgba(56, 189, 248, 0.6);
      color: #e2e8f0;
    }
    .gb-effort-chip.active {
      background: rgba(56, 189, 248, 0.25);
      border-color: #38bdf8;
      color: #38bdf8;
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
      flex: 1 1 auto;
      min-height: 0;
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
      flex: 0 0 auto;
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
    .gb-roster-item:hover {
      background: rgba(56, 189, 248, 0.18);
    }
    .gb-roster-item.active {
      background: rgba(56, 189, 248, 0.3);
      border: 1px solid rgba(56, 189, 248, 0.5);
    }
    .gb-drawer {
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      padding: 8px;
      margin-bottom: 10px;
      font-size: 9px;
      max-height: 190px;
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
    .gb-diag-log {
      font-family: monospace;
      font-size: 8px;
      color: #94a3b8;
      white-space: pre-wrap;
      word-break: break-all;
      margin-top: 4px;
    }
    .gb-add-form {
      padding: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      margin-top: 4px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .gb-add-form input {
      background: rgba(30, 41, 59, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      color: #f8fafc;
      padding: 6px 10px;
      font-size: 10.5px;
      outline: none;
      -webkit-app-region: no-drag !important;
    }
    .gb-add-form input:focus {
      border-color: #38bdf8;
    }
    .gb-add-form .gb-add-hint {
      font-size: 8.5px;
      color: #64748b;
      word-break: break-all;
    }
    .gb-add-form .gb-add-bind {
      background: rgba(52, 211, 153, 0.2);
      border: 1px solid rgba(52, 211, 153, 0.5);
      color: #34d399;
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      -webkit-app-region: no-drag !important;
    }
    .gb-add-form .gb-add-bind:hover {
      background: rgba(52, 211, 153, 0.35);
    }
    .gb-toast {
      position: fixed;
      bottom: 18px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(11, 15, 25, 0.95);
      border: 1px solid rgba(52, 211, 153, 0.55);
      color: #34d399;
      font-size: 11px;
      font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 8px 18px;
      border-radius: 9999px;
      z-index: 999999999;
      opacity: 0;
      transition: opacity 0.25s ease;
      pointer-events: none;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
    }
    .gb-toast.gb-toast-show {
      opacity: 1;
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
    const selected = document.querySelector('[data-agent-id][data-active="true"], [data-agent-id][aria-current="page"], [data-agent-id][aria-selected="true"]');
    const domAid = selected?.dataset?.agentId || null;
    // A roster/user-pin switch is authoritative for a grace window: the app's DOM
    // attributes can lag (or be re-derived from another list) and would otherwise
    // drag the HUD back mid-poll. Track a latched selection with a wall clock.
    if (currentActiveAgentId === domAid) {
      window.__gbActiveLatchUntil = 0;
    } else if (!window.__gbActiveLatchUntil || Date.now() > window.__gbActiveLatchUntil) {
      window.__gbActiveLatchUntil = 0;
    }
    if (window.__gbActiveLatchUntil && Date.now() < window.__gbActiveLatchUntil) {
      return currentActiveAgentId || domAid;
    }
    return domAid || currentActiveAgentId || null;
  }

  function latchActiveSelection(ms) {
    try { window.__gbActiveLatchUntil = Date.now() + (ms || 1500); } catch (e) {}
  }
  function setActiveAgent(aid, opts) {
    if (!aid || typeof aid !== "string" || !aid.trim()) return;
    const trimmed = aid.trim();
    currentActiveAgentId = trimmed;
    // Explicit switches (roster click / API / capture-phase user click) hold the
    // selection for a short grace window so lagging DOM attributes can't re-pin
    // an old agent mid-poll.
    if (!opts || opts.latch !== false) latchActiveSelection(2500);
    if (typeof window !== "undefined") window.__grokbotActiveAgentId = trimmed;
    showModelDropdown = false;
    render(true);
  }


  function showGbToast(text) {
    try {
      if (typeof document === "undefined" || !rootEl || !rootEl.parentNode) return;
      let toast = document.getElementById("gb-toast");
      if (!toast) {
        toast = document.createElement("div");
        toast.id = "gb-toast";
        toast.className = "gb-toast";
        rootEl.appendChild(toast);
      }
      toast.textContent = text;
      toast.classList.add("gb-toast-show");
      clearTimeout(showGbToast.__t1);
      clearTimeout(showGbToast.__t2);
      showGbToast.__t1 = setTimeout(() => toast.classList.remove("gb-toast-show"), 1300);
      showGbToast.__t2 = setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 1600);
    } catch (e) {}
  }

  function getDisplayMetrics(specifiedAid) {
    const aid = typeof specifiedAid === "string" && specifiedAid ? specifiedAid : resolveActiveAgentId();
    const bound = bindings[aid] || {};
    const native = nativeRepliesByAgent[aid];
    const provider = metricsByAgent[aid];
    const providerIsCurrent = provider && (!native || Date.parse(provider.timestamp) >= Date.parse(native.timestamp));
    const metrics = providerIsCurrent ? provider : (native || {});
    const selected = document.querySelector('[data-agent-id][data-active="true"], [data-agent-id][aria-current="page"]');
    const name = selected?.dataset?.agentId === aid ? selected.getAttribute("aria-label") : null;
    const limit = metrics.contextLimit || (providerIsCurrent ? MODEL_CONTEXT_LIMITS[bound.modelId] : null) || null;
    return {
      agentId: aid,
      agentName: name || bound.name || "Bot",
      modelId: bound.modelId || metrics.modelId || null,
      hopRoute: metrics.source === "app-native-transcript" ? "app-native-transcript" : (bound.hopBaseUrl || metrics.hopRoute || null),
      isVerifiedHop: !!(providerIsCurrent && provider.isVerifiedHop),
      tokensPerSec: metrics.tokensPerSec ?? null,
      ttftMs: metrics.ttftMs ?? null,
      promptTokens: metrics.promptTokens ?? null,
      completionTokens: metrics.completionTokens ?? null,
      cacheHitPct: metrics.cacheHitPct ?? null,
      contextLimit: limit,
      contextUtilizationPct: metrics.contextUtilizationPct ?? (metrics.promptTokens != null && limit ? metrics.promptTokens / limit * 100 : null),
      hasTurn: !!(native || provider?.hasTurn || provider?.completionTokens),
      source: metrics.source || (providerIsCurrent ? "provider" : null),
      nativeResponseMs: native?.nativeResponseMs ?? null,
      nativeEntryId: native?.entryId ?? null,
      requestId: metrics.requestId || null,
      parameters: bound.parameters || null,
      effort: effortOf(bound)
    };
  }


  // --- LIVE diag probes (real TCP/HTTP health, no hardcoded CONNECTED) ---
  async function probeDiag() {
    const ports = ["8799", "18786", "18779", "18776", "18778", "18777", "18800"];
    for (const port of ports) {
      const el = document.getElementById("gb-diag-" + port);
      if (!el) continue;
      let ok = false, label = "DOWN";
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2500);
        const res = await fetch("http://127.0.0.1:" + port + "/health", { signal: ctl.signal, cache: "no-store" });
        clearTimeout(t);
        ok = res.ok;
        if (!ok && port !== "8799") {
          // shims may not expose /health — try a HEAD on /v1/models
          const ctl2 = new AbortController();
          const t2 = setTimeout(() => ctl2.abort(), 2500);
          const res2 = await fetch("http://127.0.0.1:" + port + "/v1/models", { signal: ctl2.signal, cache: "no-store" });
          clearTimeout(t2);
          ok = res2.ok || res2.status === 404 || res2.status === 401;
        }
      } catch (e) { ok = false; }
      el.textContent = "127.0.0.1:" + port + (ok ? " · CONNECTED" : " · DOWN");
      el.style.color = ok ? "#34d399" : "#f87171";
    }
  }

  async function updateActiveModel(newModelId, newHopUrl, provider, displayName, parameters) {
    const aid = resolveActiveAgentId();
    if (!aid) return;
    const name = displayName || (bindings[aid] && bindings[aid].name) || "Bot";

    if (!bindings[aid]) bindings[aid] = {};
    if (displayName) bindings[aid].name = displayName;
    if (newHopUrl) bindings[aid].hopBaseUrl = newHopUrl;
    if (provider) bindings[aid].provider = provider;
    const params = parameters || bindings[aid].parameters || null;
    if (params) bindings[aid].parameters = params;
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
          provider: provider || "custom",
          parameters: params
        })
      });
      console.log(`[LiquidGlass] Model successfully bound to ${newModelId} for ${name}`);
    } catch (e) {
      console.warn("[LiquidGlass] Error saving model binding:", e);
    }
  }

  function effortOf(bound) {
    try {
      const p = (bound && bound.parameters) || [];
      const hit = p.find(x => x && x.id === "effort");
      return hit ? hit.value : null;
    } catch (e) { return null; }
  }

  function setEffort(value) {
    const aid = resolveActiveAgentId();
    const bound = (aid && bindings[aid]) || {};
    const keep = (bound.parameters || []).filter(x => x && x.id !== "effort");
    updateActiveModel(bound.modelId || null, bound.hopBaseUrl || null, bound.provider || null, null,
      keep.concat([{ id: "effort", value: value }]));
  }

  function updateLiveMetricValues() {
    const cur = getDisplayMetrics();
    const tps = cur.tokensPerSec != null ? cur.tokensPerSec : 0.0;
    const ttftMs = cur.ttftMs != null ? cur.ttftMs : 0;
    const ctxPct = cur.contextUtilizationPct != null ? cur.contextUtilizationPct : 0.0;
    const cacheHit = cur.cacheHitPct != null ? cur.cacheHitPct : 0.0;
    const limit = Math.round((cur.contextLimit || 131072) / 1024);

    const speed = cur.tokensPerSec != null ? `${tps.toFixed(1)} t/s` : (cur.hasTurn ? "Native reply; token rate unavailable" : "Awaiting metrics");
    const speedShort = cur.tokensPerSec != null ? `${tps.toFixed(0)} t/s` : (cur.hasTurn ? "Native reply" : "Awaiting metrics");
    const ttft = cur.ttftMs != null ? `${ttftMs} ms` : "Unavailable";
    const ctx = cur.contextUtilizationPct != null ? ctxPct.toFixed(1) : "—";
    const ctxShort = cur.contextUtilizationPct != null ? ctxPct.toFixed(0) : "—";

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
      if (vTok) vTok.textContent = `${cur.promptTokens ?? "—"} / ${cur.completionTokens ?? "—"}`;
      const vCache = document.getElementById("gb-val-cache");
      if (vCache) vCache.textContent = cur.cacheHitPct != null ? `${cacheHit.toFixed(1)}%` : "Unavailable";
      const gBar = document.getElementById("gb-gauge-bar");
      if (gBar) gBar.style.width = `${Math.min(100, Math.max(2, ctxPct))}%`;
      const gHdr = document.getElementById("gb-gauge-text");
      if (gHdr) gHdr.textContent = cur.contextLimit != null ? `${ctx}% of ${limit}k` : "Context unavailable";
    }
  }

  function render(force = false) {
    const cur = getDisplayMetrics();
    const stateKey = `${isExpanded}_${cur.agentId}_${cur.modelId}_${cur.effort || ""}_${showRoster}_${showDiag}_${showModelDropdown}`;
    
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
      const speedShort = cur.tokensPerSec != null ? `${tps.toFixed(0)} t/s` : (cur.hasTurn ? "Native reply" : "Awaiting metrics");
      const ctxShort = cur.contextUtilizationPct != null ? ctxPct.toFixed(0) : "—";
      const ag = cur.agentName || "Bot";
      let m = cur.modelId || (cur.hasTurn ? "app-native" : "unbound");
      const ctxNum = cur.contextUtilizationPct != null ? ctxPct : 0.0;
      if (m.length > 14) m = m.slice(0, 12) + "…";
      rootEl.innerHTML = `
        <div class="gb-glass-pill" id="gb-pill-btn" title="Active Convo: ${ag} · Model: ${cur.modelId} (Click to expand · Drag to move · Double-click to reset position)">
          <span class="gb-dot ${dotCls}"></span>
          <span><b>${ag}</b>: ${m}</span>
          <span style="color:#64748b">·</span>
          <span style="color:#38bdf8" id="gb-pill-speed">⚡${speedShort}</span>
          <span style="color:${ctxNum > 75 ? "#f43f5e" : (ctxNum > 50 ? "#fbbf24" : "#34d399")}" id="gb-pill-ctx">${ctxShort}%</span>
          <span style="color:#38bdf8; margin-left:2px">✦</span>
        <span id="gb-pill-usage" title="routed calls on your plan lanes" style="color:#94a3b8"></span>
        </div>
      `;

      const pillBtn = document.getElementById("gb-pill-btn");
      if (pillBtn) {
        pillBtn.addEventListener("click", function () {
          if (dragData.tapCandidate !== false) {
            isExpanded = true;
            render(true);
            applyPosition();
          }
        });
        pillBtn.addEventListener("dblclick", function (e) {
          if (e.stopPropagation) e.stopPropagation();
          resetOverlayPosition();
        });
      }
    } else {
      const isHop = cur.isVerifiedHop;
      const isNative = cur.source === "app-native-transcript";
      const provText = isNative ? "NATIVE" : (isHop ? "VERIFIED HOP" : "UNVERIFIED ROUTE");
      const provCls = (isHop || isNative) ? "verified" : "fallback";
      const speed = cur.tokensPerSec != null ? `${tps.toFixed(1)} t/s` : (cur.hasTurn ? "Native reply; token rate unavailable" : "Awaiting metrics");
      const ttft = cur.ttftMs != null ? `${ttftMs} ms` : "Unavailable";
      const pin = cur.promptTokens ?? "—";
      const pout = cur.completionTokens ?? "—";
      const cache = cur.cacheHitPct != null ? cacheHit.toFixed(1) : "—";
      const ctx = cur.contextUtilizationPct != null ? ctxPct.toFixed(1) : "—";

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
        const staticIds = new Set(MODEL_CATALOG.map(c => c.id));
        const upstream = upstreamCatalogByHop[hopOfBinding(cur.hopRoute)] || [];
        upstream.filter(u => !staticIds.has(u.id) && (u.label.toLowerCase().includes(filter) || u.id.toLowerCase().includes(filter))).forEach(u => {
          const isActive = (u.id === cur.modelId);
          optionsList += `
            <div class="gb-model-option ${isActive ? "active" : ""}" data-model-id="${u.id}" data-hop="${u.hop}" data-prov="${u.prov}">
              <div class="gb-option-header">
                <span class="gb-option-title">${u.label}</span>
                <span class="gb-option-badge">${u.badge}</span>
              </div>
              <div class="gb-option-desc">${u.desc}</div>
            </div>
          `;
        });

        dropdownHtml = `
          <div class="gb-custom-menu" id="gb-custom-dropdown">
            <input type="text" class="gb-search-input" id="gb-model-search" placeholder="Search model or provider..." value="${modelSearchFilter}" />
            ${optionsList}
            ${showModelAddForm ? `
            <div class="gb-add-form" id="gb-add-form">
              <input type="text" id="gb-add-model-id" placeholder="Model ID (e.g. gpt-6-astra-fast)" value="" />
              <input type="text" id="gb-add-hop-url" placeholder="Hop URL" value="http://127.0.0.1:18786/v1" />
              <input type="text" id="gb-add-model-name" placeholder="Name (optional, defaults to Model ID)" value="" />
              <div class="gb-add-hint" id="gb-add-hint">Enter a hop URL to verify reachability and preview upstream models…</div>
              <button class="gb-add-bind" id="gb-add-submit">Bind</button>
            </div>
            ` : ""}
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
            <div class="gb-diag-row"><span>Relay Gateway</span><span id="gb-diag-8799" style="color:#34d399">HTTP 127.0.0.1:8799 · probing…</span></div>
            <div class="gb-diag-row"><span>Multi-Hop Shim</span><span id="gb-diag-18786" style="color:#34d399">127.0.0.1:18786 · probing…</span></div>
            <div class="gb-diag-row"><span>Super Heavy Shim</span><span id="gb-diag-18779" style="color:#34d399">127.0.0.1:18779 · probing…</span></div>
            <div class="gb-diag-row"><span>Claude Shim</span><span id="gb-diag-18776" style="color:#34d399">127.0.0.1:18776 · probing…</span></div>
            <div class="gb-diag-row"><span>Codex Shim</span><span id="gb-diag-18777" style="color:#34d399">127.0.0.1:18777 · probing…</span></div>
            <div class="gb-diag-row"><span>Inco Shim</span><span id="gb-diag-18800" style="color:#34d399">127.0.0.1:18800 · probing…</span></div>
            <div class="gb-diag-log" id="gb-diag-live-log">
              Probing 6 lanes… live status on each row above.
            </div>
            <div id="gb-usage-list" style="margin:6px 0"></div>
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
              <span>${cur.modelId || (cur.hasTurn ? "app-native" : "unbound")}</span>
              <span style="font-size:10px; color:#38bdf8">▾</span>
            </button>

            <div class="gb-effort-row" title="Reasoning effort">
              ${["low", "medium", "high", "xhigh", "max"].map(v => `<span class="gb-effort-chip ${cur.effort === v ? "active" : ""}" data-effort="${v}">${v}</span>`).join("")}
            </div>

            ${dropdownHtml}

            <div class="gb-route-label">${cur.source === "app-native-transcript" ? `Source: native transcript · Reply latency: ${cur.nativeResponseMs != null ? cur.nativeResponseMs + " ms" : "Unavailable"} (not TTFT)` : `Wire: ${cur.hopRoute || "Unavailable"}`}</div>
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
              <div class="gb-tile-val" style="color:#fbbf24" id="gb-val-cache">${cur.cacheHitPct != null ? cache + "%" : "Unavailable"}</div>
            </div>
          </div>

          <div class="gb-gauge-box">
            <div class="gb-gauge-hdr">
              <span>🛡️ CONTEXT GUARDIAN</span>
              <span id="gb-gauge-text">${cur.contextUtilizationPct != null && cur.contextLimit != null ? ctx + "% of " + limit + "k" : "Context unavailable"}</span>
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

      rootEl.querySelectorAll(".gb-effort-chip").forEach((chip) => {
        chip.addEventListener("click", (e) => {
          if (e.stopPropagation) e.stopPropagation();
          setEffort(chip.getAttribute("data-effort"));
        });
      });
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
          if (showDiag) setTimeout(probeDiag, 60);
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
            // Second approach for contenteditable composers (tiptap/ProseMirror): focus the
            // placeholder element and insert the command via execCommand, then send Enter.
            try {
              const ce = document.querySelector('[data-placeholder]');
              if (ce && typeof ce.focus === "function") {
                ce.focus();
                if (typeof document.execCommand === "function") {
                  document.execCommand("insertText", false, "/new");
                  const enterEvent2 = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true });
                  ce.dispatchEvent(enterEvent2);
                }
              }
            } catch (e2) {}
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

      // Refresh live upstream models when the dropdown opens (deduped per hop)
      if (showModelDropdown) {
        try {
          const aid = cur.agentId;
          const hop = (bindings[aid] && bindings[aid].hopBaseUrl) || hopOfBinding(cur.hopRoute) || null;
          if (hop && refreshUpstreamModels.__lastHop !== hop) {
            refreshUpstreamModels.__lastHop = hop;
            refreshUpstreamModels(hop);
          }
        } catch (e) {}
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
            showModelAddForm = !showModelAddForm;
            render(true);
          });
        }

        const addForm = document.getElementById("gb-add-form");
        if (addForm) {
          const modelIdInput = document.getElementById("gb-add-model-id");
          const hopInput = document.getElementById("gb-add-hop-url");
          const nameInput = document.getElementById("gb-add-model-name");
          const hintEl = document.getElementById("gb-add-hint");
          try { if (modelIdInput && !modelIdInput.value) modelIdInput.focus(); } catch (e) {}
          if (hopInput && hintEl) {
            hopInput.addEventListener("change", () => {
              const hopVal = (hopInput.value || "").trim();
              if (!hopVal) { hintEl.textContent = "Enter a hop URL to verify reachability and preview upstream models…"; return; }
              hintEl.textContent = "Probing " + hopVal + " …";
              refreshUpstreamModels(hopVal).then(() => {
                const rows2 = upstreamCatalogByHop[hopOfBinding(hopVal)] || [];
                if (rows2.length) {
                  hintEl.textContent = "Reachable — " + rows2.length + " upstream models; first: " + rows2.slice(0, 3).map(r => r.id || r.label).join(", ");
                } else {
                  hintEl.textContent = "No upstream models reachable at " + hopVal;
                }
              }).catch(() => {
                hintEl.textContent = "Hop unreachable: " + hopVal;
              });
            });
          }
          const submitBtn = document.getElementById("gb-add-submit");
          if (submitBtn) {
            submitBtn.addEventListener("click", async (e) => {
              if (e.stopPropagation) e.stopPropagation();
              if (!modelIdInput) return;
              const mid = (modelIdInput.value || "").trim();
              if (!mid) { if (hintEl) hintEl.textContent = "Model ID is required."; return; }
              const hopV = (hopInput && hopInput.value || "").trim() || "http://127.0.0.1:18786/v1";
              const nameV = (nameInput && nameInput.value || "").trim() || mid;
              showModelAddForm = false;
              await updateActiveModel(mid, hopV, "custom", nameV);
              showGbToast("Bound: " + nameV);
              try { if (searchInput) searchInput.focus(); } catch (e2) {}
            });
          }
        }
      }

      if (showRoster) {
        document.querySelectorAll(".gb-roster-item").forEach(item => {
          item.addEventListener("click", () => {
            const aid = item.getAttribute("data-aid");
            if (aid && bindings[aid]) {
              try {
                setActiveAgent(aid);
                // Best-effort app-side sync: re-click the app's own agent button when one exists; silently no-op otherwise
                document.querySelectorAll("button[data-agent-id]").forEach(el => {
                  if (el.dataset.agentId === aid) el.click();
                });
              } catch (syncErr) {}
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

  async function captureNativeReply(aid) {
    const persistence = window.desktop?.agent?.clientPersistence;
    if (!aid || !persistence) return;
    if (!nativeReplicaPrefix) {
      const keys = await persistence.listKeys("");
      const suffix = ".transcript.replicas." + aid;
      const key = keys.find(value => value.endsWith(suffix));
      if (!key) return;
      nativeReplicaPrefix = key.slice(0, -aid.length);
    }
    const raw = await persistence.read(nativeReplicaPrefix + aid);
    if (typeof raw !== "string") return;
    const replica = JSON.parse(raw);
    const entries = replica?.value?.entries;
    if (!Array.isArray(entries)) return;
    let reply = null;
    for (const entry of entries) {
      if (entry.kind === "send-message" && entry.message?.type === "text" &&
          typeof entry.id === "string" && typeof entry.requestId === "string" &&
          Number.isFinite(entry.timestampMs) && (!reply || entry.timestampMs > reply.timestampMs)) reply = entry;
    }
    if (!reply) return;
    const key = aid + ":" + reply.id;
    if (persistedNativeReplies.has(key)) return;
    const user = entries.find(entry => entry.kind === "message" && entry.role === "user" && entry.requestId === reply.requestId);
    const row = {
      source: "app-native-transcript", agentId: aid, entryId: reply.id, requestId: reply.requestId,
      timestamp: new Date(reply.timestampMs).toISOString(),
      nativeResponseMs: Number.isFinite(user?.timestampMs) && user.timestampMs <= reply.timestampMs ? reply.timestampMs - user.timestampMs : null,
      hasTurn: true, tokensPerSec: null, ttftMs: null, elapsedMs: null,
      promptTokens: null, completionTokens: null, cacheHitPct: null, contextUtilizationPct: null
    };
    nativeRepliesByAgent[aid] = row;
    const response = await fetch(RELAY + "/append-metrics", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(row)
    });
    if (response.ok && (await response.json()).ok === true) persistedNativeReplies.add(key);
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
        if (data && typeof data === "object") {
          for (const k of Object.keys(data).filter(kk => kk !== "agents")) {
            const v = data[k];
            if (v && typeof v === "object" && typeof v.modelId === "string") {
              bindings[k] = Object.assign({}, bindings[k] || {}, v);
            }
          }
        }
       for (const sid of Object.keys(bindings)) {
         const sb = bindings[sid];
         if (sb && sb.modelId && sb.hopBaseUrl) seedSidecar(sid);
       }
       installReplicaGuard();
       if ((poll._n = (poll._n || 0) + 1) % 40 === 0) driftCheck();
      }
    } catch (e) {}

    const resolved = resolveActiveAgentId();
    if (resolved && resolved !== currentActiveAgentId) {
      setActiveAgent(resolved, { latch: false });
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
            if (aid && row.source === "app-native-transcript" && row.entryId) {
              persistedNativeReplies.add(aid + ":" + row.entryId);
              if (!nativeRepliesByAgent[aid] || Date.parse(row.timestamp) >= Date.parse(nativeRepliesByAgent[aid].timestamp)) nativeRepliesByAgent[aid] = row;
            } else if (aid && (!metricsByAgent[aid] || Date.parse(row.timestamp) >= Date.parse(metricsByAgent[aid].timestamp))) {
              metricsByAgent[aid] = row;
            }
            const hop = row.hopRoute || "";
            // Native transcript rows are first-party app data; never punish them to UNVERIFIED ROUTE
            row.isVerifiedHop = !!(hop && (hop.includes("127.0.0.1") || hop.includes("18786") || hop.includes("18779") || hop.includes("18776"))) || row.source === "app-native-transcript";
          } catch (err) {}
        }
      }
    } catch (e) {}
    try { await captureNativeReply(resolved); } catch (error) { console.warn("[LiquidGlass] Native reply capture unavailable:", error.message); }

    updateLiveMetricValues();
    if (typeof showDiag !== "undefined" && showDiag && rootEl && rootEl.querySelector("#gb-diag-drawer")) {
      const now = Date.now();
      if (!probeDiag.__last || now - probeDiag.__last > 5000) {
        probeDiag.__last = now;
        probeDiag();
      }
    }
    setTimeout(poll, 400);
  }

  // --- GLASS TURN ROUTER: bound agents answer from the picker model, not Grok ---
  // Intercepts composer Enter (capture phase beats React root delegation) ONLY for
  // agents with a real binding (modelId + hopBaseUrl). Unbound agents, empty text,
  // and every error path fall through to the native submit - uncertain means native.
  const GLASS_ROUTED = new Set();
  let glassInterceptArmed = true;
 let glassLastError = "";
 function glassToast(msg) {
 try {
 let el = document.getElementById("gb-toast");
 if (!el) {
 el = document.createElement("div");
 el.id = "gb-toast";
 el.style.cssText = "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,.95);border:1px solid rgba(248,113,113,.5);color:#fecaca;font-size:11px;padding:8px 14px;border-radius:10px;z-index:99999999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:70vw;text-align:center;-webkit-app-region:no-drag;";
 (document.body || document.documentElement).appendChild(el);
 }
 el.textContent = msg;
 el.style.display = "block";
 clearTimeout(glassToast._t);
 glassToast._t = setTimeout(() => { el.style.display = "none"; }, 6000);
 } catch (err) {}
 }

  function uuid4() {
    try { return crypto.randomUUID(); } catch (e) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function effortBody(provider, effort) {
    if (!effort) return {};
    const v = String(effort).toLowerCase();
    if (provider === "xai" || provider === "grok" || provider === "grok-superheavy") {
      return { reasoning_effort: v === "max" ? "xhigh" : v };
    }
    return { reasoning_effort: v };
  }

  async function replicaEntries(aid) {
    try {
      const persistence = window.desktop?.agent?.clientPersistence;
      if (!aid || !persistence) return null;
      if (!nativeReplicaPrefix) {
        const keys = await persistence.listKeys("");
        const suffix = ".transcript.replicas." + aid;
        const key = keys.find(value => value.endsWith(suffix));
        if (!key) return null;
        nativeReplicaPrefix = key.slice(0, -aid.length);
      }
      const raw = await persistence.read(nativeReplicaPrefix + aid);
      if (typeof raw !== "string") return null;
      const replica = JSON.parse(raw);
      if (!replica || !replica.value || !Array.isArray(replica.value.entries)) return null;
      return { replica, key: nativeReplicaPrefix + aid };
    } catch (e) { return null; }
  }

   const routedSidecar = {};
   const sidecarSeeded = new Set();
   async function seedSidecar(aid) {
     if (!aid || sidecarSeeded.has(aid)) return;
     sidecarSeeded.add(aid);
     try {
       const r = await fetch(RELAY + "/routed-turns?agentId=" + encodeURIComponent(aid), { cache: "no-store" });
       if (r.ok) {
         const d = await r.json();
         if (Array.isArray(d.entries) && d.entries.length) routedSidecar[aid] = d.entries;
       }
     } catch (e) {}
   }
   async function logRoutedTurn(aid, entries) {
     if (!aid || !entries || !entries.length) return;
     const cur = routedSidecar[aid] || (routedSidecar[aid] = []);
     const have = new Set(cur.map(e => e && e.id));
     for (const e of entries) if (e && e.id && !have.has(e.id)) { cur.push(e); have.add(e.id); }
     cur.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
     try {
       await fetch(RELAY + "/log-turn", {
         method: "POST", headers: { "Content-Type": "application/json" },
         body: JSON.stringify({ agentId: aid, entries })
       });
     } catch (e) {}
   }
   function installReplicaGuard() {
     try {
       const p = window.desktop && window.desktop.agent && window.desktop.agent.clientPersistence;
       if (!p || p.__gbGuarded) return;
       const rawWrite = p.write.bind(p);
       p.__gbGuarded = true;
       p.write = async function (key, val) {
         const out = await rawWrite(key, val);
         try {
           const ks = String(key || "");
           const i = ks.indexOf("transcript.replicas.");
           const aid = i >= 0 ? ks.slice(i + "transcript.replicas.".length) : null;
           const want = aid && routedSidecar[aid];
           if (want && want.length && !p.__gbMerging) {
             p.__gbMerging = true;
             try {
               const doc = JSON.parse(await p.read(key));
               const cur = doc.value.entries;
               const have = new Set(cur.map(e => e && e.id));
               const missing = want.filter(e => e && e.id && !have.has(e.id));
               if (missing.length) {
                 doc.value.entries = cur.concat(missing).sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
                 await rawWrite(key, JSON.stringify(doc));
               }
             } finally { p.__gbMerging = false; }
           }
         } catch (e) {}
         return out;
       };
     } catch (e) {}
   }
   window.__gbDrift = window.__gbDrift || { runs: 0, merged: 0 };
   const GLASS_ROUTER_ENABLED = false; // KILL-SWITCH 2026-09-22: renderer-side routing disarmed - server truth wins; config-lane rebuild in progress
   async function driftCheck() {
     if (!GLASS_ROUTER_ENABLED) return;
     try {
       const aid = resolveActiveAgentId();
       const want = aid && routedSidecar[aid];
       if (!want || !want.length) return;
       window.__gbDrift.runs++;
       const p = window.desktop && window.desktop.agent && window.desktop.agent.clientPersistence;
       if (!p || driftCheck._busy) return;
       const keys = await p.listKeys("");
       const rk = keys.find(k => String(k).indexOf("transcript.replicas." + aid) >= 0);
       if (!rk) return;
       const doc = JSON.parse(await p.read(rk));
       const cur = doc.value.entries;
       const wantIds = new Set(want.map(e => e && e.id));
       if (cur.some(e => e && e.isStreaming && !wantIds.has(e.id))) return;
       const have = new Set(cur.map(e => e && e.id));
       const missing = want.filter(e => e && e.id && !have.has(e.id));
       if (missing.length) {
         driftCheck._busy = true;
         try {
           doc.value.entries = cur.concat(missing).sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
           await p.write(rk, JSON.stringify(doc));
           window.__gbDrift.merged += missing.length;
         } finally { driftCheck._busy = false; }
       }
     } catch (e) {}
   }
  async function glassRoutedTurn(text) {
    const started = Date.now();
    let firstTokenAt = 0;
    try {
      const aid = resolveActiveAgentId();
      const bound = (aid && bindings[aid]) || null;
      if (!bound || !bound.modelId || !bound.hopBaseUrl) return false;
      const store = await replicaEntries(aid);
      if (!store) return false;

      const requestId = uuid4();
      const now = Date.now();
      const userEntry = {
        kind: "message", id: "u" + now.toString(36) + Math.floor(Math.random() * 1e4),
        role: "user", content: text,
        richText: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }),
        isStreaming: false, timestampMs: now, clientNonce: uuid4(), requestId
      };
      const replyEntry = {
        kind: "send-message", id: "gb" + now.toString(36),
        message: JSON.stringify({ type: "text", content: "" }),
        timestampMs: now + 1, requestId, isStreaming: true
      };
      const persistence = window.desktop.agent.clientPersistence;
      async function commit(extra) {
        const entries = store.replica.value.entries.concat(extra || []);
        const latest = entries[entries.length - 1];
        if (latest && latest.id === replyEntry.id) {
          latest.message = replyEntry.message;
          if (replyEntry.isStreaming === false) latest.isStreaming = false;
        }
        if (extra) store.replica.value.entries = entries;
        await persistence.write(store.key, JSON.stringify(store.replica));
      }
      async function uncommit() {
        try {
          store.replica.value.entries = store.replica.value.entries.filter(
            e => e.id !== userEntry.id && e.id !== replyEntry.id);
          await persistence.write(store.key, JSON.stringify(store.replica));
        } catch (err) {}
      }
      await commit([userEntry, replyEntry]);

      const hist = [];
      for (const e of store.replica.value.entries.slice(-14)) {
        if (e.kind === "message" && e.role === "user" && typeof e.content === "string" && e.content) {
          hist.push({ role: "user", content: e.content.slice(0, 4000) });
        } else if (e.kind === "send-message") {
          try {
            const m = typeof e.message === "string" ? JSON.parse(e.message) : e.message;
            if (m && m.type === "text" && m.content) hist.push({ role: "assistant", content: String(m.content).slice(0, 4000) });
          } catch (err) {}
        }
      }
      const eff = effortOf(bound);
      const res = await fetch(String(bound.hopBaseUrl).replace(/\/$/, "") + "/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({
          model: bound.modelId,
          messages: hist,
          stream: true
        }, effortBody(bound.provider, eff)))
      });
 if (!res.ok || !res.body) { glassLastError = "hop HTTP " + (res ? res.status : "noresponse"); await uncommit(); return false; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "", buf = "", lastWrite = 0;
      let completionTokens = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop();
        for (const ln of parts) {
          const line = ln.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload);
            const delta = (((j.choices || [])[0] || {}).delta || {}).content || "";
            if (delta) {
              if (!firstTokenAt) firstTokenAt = Date.now();
              acc += delta;
              completionTokens++;
            }
          } catch (err) {}
        }
        if (Date.now() - lastWrite > 120 && acc) {
          lastWrite = Date.now();
          replyEntry.message = JSON.stringify({ type: "text", content: acc });
          replyEntry.timestampMs = Date.now();
          await commit();
        }
      }
      replyEntry.message = JSON.stringify({ type: "text", content: acc });
      replyEntry.isStreaming = false;
      replyEntry.timestampMs = Date.now();
      await commit();
      const elapsed = Date.now() - started;
      const tps = elapsed > 0 ? (completionTokens / (elapsed / 1000)) : 0;
      GLASS_ROUTED.add(aid + ":" + requestId);
      try {
        await fetch(RELAY + "/append-metrics", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: aid, agentName: bound.name || "Bot", modelId: bound.modelId,
            hopRoute: String(bound.hopBaseUrl || "").replace(/^https?:\/\//, ""),
            isVerifiedHop: true, source: "glass-turn",
            tokensPerSec: Math.round(tps * 10) / 10,
            ttftMs: firstTokenAt ? firstTokenAt - started : null,
            promptTokens: null, completionTokens,
            contextLimit: null, nativeEntryId: replyEntry.id, requestId
          })
        });
      } catch (err) {}
       await logRoutedTurn(aid, [userEntry, replyEntry]);
       driftCheck();
      render(true);
      return true;
    } catch (e) {
 try { await uncommit(); } catch (err) {}
 glassLastError = "hop error: " + ((e && e.message) || e);
 return false;
    }
  }

  function clearComposer(field) {
    try {
      field.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
      field.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } catch (e) {}
  }

  document.addEventListener("keydown", (e) => {
     if (!GLASS_ROUTER_ENABLED) return;
    try {
      if (!glassInterceptArmed) return;
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.defaultPrevented) return;
      // Gate on the LIVE composer state, not the event target: real key events can
      // target text nodes, widget spans, or (synthetic input) BODY. Never touch
      // HUD-internal typing or dialog-scoped Enter.
      const _et = (e.target && e.target.nodeType === 3) ? e.target.parentElement : e.target;
      if (_et && _et.closest && (_et.closest("#gb-liquidglass-root") || _et.closest('[role="dialog"],[role="alertdialog"]'))) return;
      const field = document.querySelector(".sand-prompt-field");
      if (!field || field.offsetParent === null) return;
      const text = (field.innerText || "").trim();
      if (!text) return;
      const aid = resolveActiveAgentId();
      const bound = (aid && bindings[aid]) || null;
      if (!bound || !bound.modelId || !bound.hopBaseUrl) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      clearComposer(field);
 glassRoutedTurn(text).then((ok) => {
 if (ok) return;
 try {
 glassInterceptArmed = false; // next Enter goes native - never synthetic
 field.focus();
 document.execCommand("insertText", false, text);
 field.dispatchEvent(new InputEvent("input", { bubbles: true }));
 glassToast("hop failed (" + (glassLastError || "unknown") + ") - message restored, Enter again for native reply");
 } finally {
 setTimeout(() => { glassInterceptArmed = true; }, 8000);
 }
 });
    } catch (err) {}
  }, true);

  // --- LANDED WORK visibility: who is actually doing the work (plan-hop usage) ---
  async function refreshUsage() {
    try {
      const r = await fetch("http://127.0.0.1:18784/usage", { cache: "no-store" });
      if (!r.ok) return;
      const u = await r.json();
      const calls = (u && u.calls) || {};
      let total = 0;
      for (const k in calls) total += calls[k];
      const hint = document.getElementById("gb-pill-usage");
      if (hint) hint.textContent = total > 0 ? " ⌁" + total : "";
      const list = document.getElementById("gb-usage-list");
      if (list) {
        const rows = Object.keys(calls).sort()
          .map(k => `<div class="gb-diag-row"><span>${k}</span><span>${calls[k]} calls</span></div>`).join("");
        list.innerHTML = `<div style="font-weight:700; color:#38bdf8; margin-bottom:4px">⌁ LANDED WORK · plan-hop since ${u.since || "?"}</div>` +
          (rows || '<div class="gb-diag-row"><span>no routed calls yet</span><span></span></div>');
      }
    } catch (e) {}
  }
  if (typeof setInterval === "function") { setInterval(refreshUsage, 5000); }
  refreshUsage();

  render(true);
  poll();
   if (typeof setInterval === "function") { setInterval(driftCheck, 2000); }
   setTimeout(() => { try { for (const sid of Object.keys(bindings)) { const sb = bindings[sid]; if (sb && sb.modelId && sb.hopBaseUrl) seedSidecar(sid); } } catch (e) {} }, 2000);
   document.addEventListener("visibilitychange", () => { try { if (!document.hidden) driftCheck(); } catch (e) {} });
   window.addEventListener("focus", () => { try { driftCheck(); } catch (e) {} });
  console.log("[LiquidGlass] High-performance glass dropdown model picker loaded!");
})();
