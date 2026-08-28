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

  /* ---------- 调试开关 ---------- */
  const DEBUG = true;
  function bpLog(...args) { if (DEBUG) console.log('[BrowserPilot]', ...args); }

  /* ---------- 清洗 AI 可能输出的非标准 JSON ----------
   * 大模型有时会生成单引号 JSON、中文引号、markdown 围栏、多余逗号或注释。
   * 本函数尽量还原成标准 JSON；还原失败则返回原串供上层再次尝试。
   */
  function normalizeToolJson(raw) {
    let s = String(raw || '').trim();
    // 去掉 markdown 代码块围栏 ```json / ```
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    // 去掉行内注释 // 与 /* */
    s = s.replace(/\/\/[^\n\r]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // 中文引号 -> 英文
    s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    // 去掉对象/数组末尾多余逗号
    s = s.replace(/,(\s*[}\]])/g, '$1');
    // 若首字符不是 { 或 [，尝试截取第一个 JSON 片段
    const firstObj = s.indexOf('{');
    const firstArr = s.indexOf('[');
    let start = -1;
    if (firstObj !== -1 && firstArr !== -1) start = Math.min(firstObj, firstArr);
    else if (firstObj !== -1) start = firstObj;
    else if (firstArr !== -1) start = firstArr;
    if (start > 0) s = s.slice(start);
    // 若全用单引号（AI 常见错误），把配对单引号改为双引号（假定字符串内不含嵌套单引号）
    const singleCount = (s.match(/'/g) || []).length;
    const doubleCount = (s.match(/"/g) || []).length;
    if (singleCount > 0 && singleCount > doubleCount) {
      s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, function (_m, inner) {
        return '"' + inner.replace(/"/g, '\\"') + '"';
      });
    }
    return s;
  }

  /* ---------- 递归扫描 DOM + Shadow DOM ----------
   * 聊天内容常被放在 shadow root 里，普通 querySelectorAll 会漏掉。
   */
  function collectAllNodes(root, out) {
    if (!root) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) !== null) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        out.push(node);
        if (node.shadowRoot) collectAllNodes(node.shadowRoot, out);
      } else {
        out.push(node);
      }
    }
    return out;
  }
  function decodeEntities(t) {
    if (typeof t !== 'string' || t.indexOf('&lt;') === -1) return t;
    return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  function findToolCallSource() {
    const nodes = collectAllNodes(document.body, []);
    const candidates = [];
    for (const node of nodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
        const text = decodeEntities(node.innerText || node.textContent || '');
        if (text.includes('<tool_call>')) candidates.push({ node, text, len: text.length });
      } else if (node.nodeType === Node.TEXT_NODE) {
        const text = decodeEntities(node.textContent || '');
        if (text.includes('<tool_call>')) candidates.push({ node, text, len: text.length });
      }
    }
    if (!candidates.length) {
      const fallback = document.body ? (document.body.innerText || document.body.textContent || '') : '';
      bpLog('未找到 <tool_call>，回退 body.innerText，长度=', fallback.length);
      return fallback;
    }
    candidates.sort((a, b) => a.len - b.len);
    bpLog('找到', candidates.length, '个候选，最短文本长度=', candidates[0].len);
    return candidates[0].text;
  }
  function stableFingerprint(tool, args) {
    try { return tool + '::' + JSON.stringify(args); } catch (_) { return tool + '::' + String(args); }
  }
  function parseToolCall(inner) {
    let s = inner.trim();
    try { return JSON.parse(s); } catch (_) {}
    const normalized = normalizeToolJson(s);
    try { return JSON.parse(normalized); } catch (_) {}
    const fallback = normalized.replace(/'/g, '"');
    try { return JSON.parse(fallback); } catch (_) {}
    return null;
  }
  function detectToolCall() {
    const text = findToolCallSource();
    if (!text.includes('<tool_call>')) return;
    bpLog('开始检测 <tool_call>，文本长度=', text.length);
    const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const parsed = parseToolCall(m[1]);
      if (!parsed || !parsed.tool || typeof parsed.args !== 'object' || parsed.args === null) {
        console.warn('[BrowserPilot] 工具 JSON 解析失败，原始内容:', m[1].trim().slice(0, 200));
        continue;
      }
      const fp = stableFingerprint(parsed.tool, parsed.args);
      if (processed.has(fp)) { bpLog('已执行过，跳过', parsed.tool); continue; }
      processed.add(fp);
      bpLog('执行工具', parsed.tool, parsed.args);
      executeTool(parsed.tool, parsed.args);
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

  /* ---------- 启动：监听 document 级 + 动态补挂 shadow root + 常驻兜底轮询 ----------
   * - 监听 document.documentElement 可覆盖普通 DOM 的流式/虚拟 DOM 变化；
   * - 每个轮询周期补挂新出现的 shadow root，避免 shadow 内 <tool_call> 漏检；
   * - setInterval 兜底持续运行（降频 1500ms），覆盖一切 MutationObserver 漏掉的边缘场景。
   */
  function observeRoot(root, obs) {
    try {
      obs.observe(root, { childList: true, subtree: true, characterData: true });
      bpLog('监听 root:', root.nodeName || 'shadowRoot');
    } catch (e) { bpLog('监听 root 失败', e); }
  }
  function start() {
    buildFloatingPanel();
    const obs = new MutationObserver(throttle(detectToolCall, 300));
    observeRoot(document.documentElement, obs);
    const seenRoots = new WeakSet();
    function scanAndMountShadow() {
      collectAllNodes(document.body, []).forEach((n) => {
        if (n.nodeType === Node.ELEMENT_NODE && n.shadowRoot && !seenRoots.has(n.shadowRoot)) {
          seenRoots.add(n.shadowRoot);
          observeRoot(n.shadowRoot, obs);
        }
      });
    }
    scanAndMountShadow();
    setTimeout(scanAndMountShadow, 1500);
    detectToolCall(); // 首屏立即检测一次
    setInterval(() => { scanAndMountShadow(); detectToolCall(); }, 1500); // 常驻兜底
    window.BrowserPilot = { injectProtocol, getPlatform: () => PLATFORM, detectNow: detectToolCall };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
