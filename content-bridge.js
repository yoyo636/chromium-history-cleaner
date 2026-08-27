/* =========================================================================
 * content-bridge.js — BrowserPilot 注入到 AI 网页（Kimi / DeepSeek / MiniMax）
 * 职责：
 *   1) 平台检测 + DOM 适配器（输入框 / 发送钮 / 聊天容器）
 *   2) MutationObserver（节流 500ms）监听 AI 输出，捕获 <tool_call> JSON
 *   3) 通过 chrome.runtime.sendMessage 把指令发给 background.js 执行
 *   4) 把执行结果以 <tool_result> 形式回填输入框并自动发送，使 AI 下一轮可见
 *   5) 监听弹窗的 BP_INJECT_PROTOCOL，把协议文档注入对话输入框
 * 纯原生 JS，无外部依赖。
 * ========================================================================= */

(function () {
  'use strict';

  const AUTO_SEND_RESULT = true;   // 收到结果后自动发回 AI（true 才能让 AI 看到）
  const AUTO_SEND_PROTOCOL = false; // 注入协议后是否自动发送（默认 false，由用户/弹窗决定）

  /* ---------- 平台检测 + DOM 适配器 ----------
   * 注意：各 AI 平台 DOM 会随版本变化，以下选择器为「合理假设，可能需要微调」。
   * 若某平台取不到输入框/发送钮，请按页面实际结构改下方对应函数。
   */
  function detectPlatform() {
    const h = location.hostname;
    if (h.includes('kimi.moonshot.cn')) return 'kimi';
    if (h.includes('chat.deepseek.com')) return 'deepseek';
    if (h.includes('chat.minimaxi.com')) return 'minimax';
    return 'unknown';
  }
  function findByText(selector, text, exact) {
    const nodes = document.querySelectorAll(selector);
    for (const n of nodes) {
      const t = (n.innerText || n.textContent || '').trim();
      if (exact ? t === text : t.includes(text)) return n;
    }
    return null;
  }
  function findBtnByText(text) {
    return findByText('button, [role="button"], a', text, false) ||
           findByText('div, span', text, false);
  }

  const ADAPTERS = {
    // ---- Kimi：此处基于假设，可能需要根据实际 DOM 微调 ----
    kimi: {
      name: 'Kimi',
      getInput() {
        return document.querySelector('textarea') ||
               document.querySelector('[contenteditable="true"]');
      },
      getSend() {
        return document.querySelector('[data-testid="send-btn"]') ||
               document.querySelector('button[aria-label*="发送" i]') ||
               findBtnByText('发送');
      },
      getChat() {
        return document.querySelector('[class*="chat" i]') ||
               document.querySelector('main') || document.body;
      },
    },
    // ---- DeepSeek：此处基于假设，可能需要根据实际 DOM 微调 ----
    deepseek: {
      name: 'DeepSeek',
      getInput() {
        return document.querySelector('textarea') ||
               document.querySelector('[contenteditable="true"]');
      },
      getSend() {
        return document.querySelector('button[aria-label*="发送" i]') ||
               document.querySelector('[data-testid="send"]') ||
               findBtnByText('发送');
      },
      getChat() {
        return document.querySelector('[class*="chat" i]') ||
               document.querySelector('main') || document.body;
      },
    },
    // ---- MiniMax：扩展预留，此处基于假设，可能需要根据实际 DOM 微调 ----
    minimax: {
      name: 'MiniMax',
      getInput() {
        return document.querySelector('textarea') ||
               document.querySelector('[contenteditable="true"]');
      },
      getSend() {
        return document.querySelector('button[aria-label*="发送" i]') ||
               findBtnByText('发送');
      },
      getChat() {
        return document.querySelector('[class*="chat" i]') ||
               document.querySelector('main') || document.body;
      },
    },
  };

  const PLATFORM = detectPlatform();
  const adapter = ADAPTERS[PLATFORM];
  if (!adapter) return; // 非目标平台，退出

  /* ---------- 输入框赋值（兼容 textarea / input / contenteditable） ---------- */
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function setInputValue(el, value) {
    if (!el) return;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') setNativeValue(el, value);
    else { el.innerText = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
  }

  /* ---------- 节流 ---------- */
  function throttle(fn, wait) {
    let last = 0, timer = null;
    return function (...args) {
      const now = Date.now();
      const remain = wait - (now - last);
      if (remain <= 0) { last = now; fn.apply(this, args); }
      else if (!timer) {
        timer = setTimeout(() => { last = Date.now(); timer = null; fn.apply(this, args); }, remain);
      }
    };
  }

  /* ---------- 捕获 AI 消息中的 <tool_call> ----------
   * 旧逻辑只扫 chat 容器的最后 5 个直接子元素，对 DeepSeek 等层级深的 DOM 失效。
   * 改为：优先找页面上包含 <tool_call> 的最小元素；找不到再回退到 body.innerText。
   */
  const processed = new Set();
  function findToolCallSource() {
    const candidates = [];
    // 用 querySelectorAll 比递归 walk 更稳定；只取可见文本元素，避免 script/style
    const all = document.querySelectorAll('body, body *');
    for (const el of all) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') continue;
      const text = (el.innerText || el.textContent || '');
      if (text.includes('<tool_call>')) candidates.push({ el, text });
    }
    if (!candidates.length) return document.body ? (document.body.innerText || '') : '';
    // 选文本长度最短的元素，通常是包裹 <tool_call> 的最内层节点，避免拿到 body 全文
    candidates.sort((a, b) => a.text.length - b.text.length);
    return candidates[0].text;
  }
  function detectToolCall() {
    const text = findToolCallSource();
    const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      if (processed.has(raw)) continue;
      processed.add(raw);
      let parsed;
      try { parsed = JSON.parse(m[1].trim()); }
      catch (e) { console.warn('[BrowserPilot] 工具 JSON 解析失败:', e); continue; }
      if (parsed && parsed.tool && parsed.args) executeTool(parsed.tool, parsed.args);
    }
  }

  /* ---------- 发送指令给 background，并回填结果 ---------- */
  function executeTool(tool, args) {
    chrome.runtime.sendMessage(
      { type: 'EXECUTE_TOOL', payload: { tool, args } },
      (resp) => {
        if (chrome.runtime.lastError) { console.warn('[BrowserPilot] 通信错误:', chrome.runtime.lastError.message); return; }
        if (resp && resp.ok) injectResult(resp.data);
        else console.warn('[BrowserPilot] 执行失败:', resp && resp.error);
      }
    );
  }
  function injectResult(result) {
    const input = adapter.getInput();
    if (!input) return;
    const payload = '\n\n<tool_result>' + JSON.stringify(result) + '</tool_result>\n';
    const cur = (input.value || input.innerText || '');
    setInputValue(input, cur + payload);
    if (AUTO_SEND_RESULT) {
      const btn = adapter.getSend();
      if (btn) setTimeout(() => btn.click(), 200);
    }
  }

  /* ---------- 协议注入（弹窗触发 / 手动按钮） ---------- */
  async function loadProtocolText() {
    try {
      const url = chrome.runtime.getURL('browserpilot-protocol.md');
      const res = await fetch(url);
      return await res.text();
    } catch (e) { console.warn('[BrowserPilot] 加载协议失败:', e); return ''; }
  }
  async function injectProtocol() {
    const md = await loadProtocolText();
    const input = adapter.getInput();
    if (!md || !input) return { ok: false };
    setInputValue(input, md);
    if (AUTO_SEND_PROTOCOL) {
      const btn = adapter.getSend();
      if (btn) setTimeout(() => btn.click(), 300);
    }
    return { ok: true };
  }

  /* ---------- 浮动控制条 ---------- */
  function buildFloatingPanel() {
    if (document.getElementById('bp-bridge-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'bp-bridge-panel';
    panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111827;color:#fff;font:12px/1.4 sans-serif;padding:8px 10px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.3);display:flex;gap:8px;align-items:center;';
    const btn = document.createElement('button');
    btn.textContent = '🛰 注入协议';
    btn.style.cssText = 'background:#2563eb;color:#fff;border:none;padding:6px 10px;border-radius:8px;cursor:pointer;';
    btn.onclick = () => injectProtocol();
    const info = document.createElement('span');
    info.textContent = adapter.name;
    info.style.cssText = 'opacity:.8;';
    panel.appendChild(info);
    panel.appendChild(btn);
    document.body.appendChild(panel);
  }

  /* ---------- 接收弹窗的协议注入指令 ---------- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'BP_INJECT_PROTOCOL') {
      injectProtocol().then((r) => sendResponse(r));
      return true;
    }
    return false;
  });

  /* ---------- 启动 ---------- */
  function start() {
    buildFloatingPanel();
    const target = adapter.getChat() || document.body;
    const obs = new MutationObserver(throttle(detectToolCall, 500));
    obs.observe(target, { childList: true, subtree: true, characterData: true });
    window.BrowserPilot = { injectProtocol, getPlatform: () => PLATFORM };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
