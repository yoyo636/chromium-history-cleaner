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

  /* 通用输入框/发送钮兜底查找（各平台 DOM 变化时尽量还能找到） */
  function commonInput() {
    return document.querySelector('#chat-input') ||            // DeepSeek 常见
           document.querySelector('textarea') ||
           document.querySelector('[contenteditable="true"]') ||
           document.querySelector('[role="textbox"]');
  }
  function commonSend() {
    return document.querySelector('button[aria-label*="发送" i]') ||
           document.querySelector('[data-testid="send"]') ||
           document.querySelector('[data-testid="send-button"]') ||
           document.querySelector('#send-message-button') ||
           findBtnByText('发送');
  }

  const ADAPTERS = {
    // ---- Kimi：此处基于假设，可能需要根据实际 DOM 微调 ----
    kimi: {
      name: 'Kimi',
      getInput() {
        return document.querySelector('textarea') ||
               document.querySelector('[contenteditable="true"]') ||
               commonInput();
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
      getInput() { return commonInput(); },
      getSend() { return commonSend(); },
      getChat() {
        return document.querySelector('[class*="chat" i]') ||
               document.querySelector('main') || document.body;
      },
    },
    // ---- MiniMax：扩展预留，此处基于假设，可能需要根据实际 DOM 微调 ----
    minimax: {
      name: 'MiniMax',
      getInput() { return commonInput(); },
      getSend() { return commonSend(); },
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

  /* ---------- 调试开关（生产默认关闭；排障时改为 true） ---------- */
  const DEBUG = false;
  function bpLog(...args) { if (DEBUG) console.log('[BrowserPilot]', ...args); }

  /* ---------- 已执行指令指纹（FIFO 上限） ----------
   * 历史 bug：processed 曾未声明（strict 模式下 ReferenceError，检测路径整体崩溃），
   * 修复后亦不能无限增长（长会话内存单向上升），故加上限。
   * 注意：完全相同的指令不会重复执行——AI 重发同一指令通常是渲染抖动；
   * 若确需重复执行（如再次滚动），指令应带不同参数（amount / nonce）。 */
  const PROCESSED_CAP = 500;
  const processed = new Set();
  function processedAdd(fp) {
    processed.add(fp);
    if (processed.size > PROCESSED_CAP) processed.delete(processed.values().next().value);
  }

  /* ---------- 浮动面板状态行：把检测/执行状态直接显示在页面上，无需开控制台 ----------
   * 用户一眼就能看到：是否在监听、是否检测到 tool_call、执行了哪个工具、是否出错。
   */
  let bpStatusEl = null;
  function bpStatus(text, color) {
    if (bpStatusEl) {
      bpStatusEl.textContent = text;
      bpStatusEl.style.color = color || '#9ca3af';
    }
    bpLog('[status]', text);
  }

  /* ---------- 清洗 AI 可能输出的非标准 JSON ----------
   * 大模型有时会生成单引号 JSON、中文引号、markdown 围栏、多余逗号或注释。
   * 本函数尽量还原成标准 JSON；还原失败则返回原串供上层再次尝试。
   */
  function normalizeToolJson(raw) {
    let s = String(raw || '').trim();
    // 去掉 markdown 代码块围栏 ```json / ```
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    /* 注意：不要盲删 // 与 注释 —— 会把 URL 里的 https:// 截成 https:
     * （旧 bug：AI 输出 {"url":"https://example.com"} 时参数被静默损坏）。
     * JSON 本无注释，AI 偶发注释时由上层多次 parse 尝试兜底即可。 */
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

  /* ---------- 递归收集 shadow root ----------
   * 聊天内容常被放在 shadow root 里，普通遍历会漏掉。
   * 只遍历元素节点（不读文本），开销远小于旧版的全节点 TreeWalker。
   */
  function collectShadowRoots(root, out) {
    if (!root) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode()) !== null) {
      if (node.shadowRoot) {
        out.push(node.shadowRoot);
        collectShadowRoots(node.shadowRoot, out);
      }
    }
    return out;
  }
  function decodeEntities(t) {
    if (typeof t !== 'string' || t.indexOf('&lt;') === -1) return t;
    return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  /* 取检测源文本：聊天容器的一次 textContent 序列化。
   * 性能要点：textContent 不触发强制同步重排（innerText 会）。
   * 旧版每 1.5s 对全页上万个节点逐个读 innerText，长对话页持续卡顿；
   * 且「取最短候选文本」的启发式在流式输出中途可能选错节点。
   * 现在直接用容器全文 + 全局正则提取所有 tool_call（去重由 processed 负责）。 */
  function findToolCallSource() {
    const scope = adapter.getChat() || document.body;
    if (!scope) return '';
    let text = scope.textContent || '';
    if (text.indexOf('<tool_call>') === -1 && text.indexOf('&lt;tool_call&gt;') === -1) {
      // shadow root 兜底（容器文本未命中时才逐个查，避免每轮额外开销）
      const roots = collectShadowRoots(scope, []);
      for (const r of roots) {
        const t = r.textContent || '';
        if (t.indexOf('<tool_call>') !== -1 || t.indexOf('&lt;tool_call&gt;') !== -1) { text = t; break; }
      }
    }
    return decodeEntities(text);
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
    let count = 0;
    while ((m = re.exec(text)) !== null) {
      count++;
      const parsed = parseToolCall(m[1]);
      if (!parsed || !parsed.tool || typeof parsed.args !== 'object' || parsed.args === null) {
        console.warn('[BrowserPilot] 工具 JSON 解析失败，原始内容:', m[1].trim().slice(0, 200));
        bpStatus('⚠️ 解析失败: ' + m[1].trim().slice(0, 40), '#f87171');
        continue;
      }
      const fp = stableFingerprint(parsed.tool, parsed.args);
      if (processed.has(fp)) { bpLog('已执行过，跳过', parsed.tool); continue; }
      processedAdd(fp);
      bpLog('执行工具', parsed.tool, parsed.args);
      bpStatus('🔧 执行: ' + parsed.tool + ' …', '#fbbf24');
      executeTool(parsed.tool, parsed.args);
    }
    if (count) bpStatus('✅ 已捕获 ' + count + ' 个指令', '#34d399');
  }

  /* ---------- 发送指令给 background，并回填结果 ---------- */
  function executeTool(tool, args) {
    bpStatus('🔧 执行: ' + tool + ' …', '#fbbf24');
    /* 关键：扩展被重载后，旧页面的 content script 的 runtime 已失效，
     * sendMessage 会同步抛 "Extension context invalidated"。
     * 不捕获的话用户只会看到"毫无反应"，所以必须显式提示刷新页面。 */
    let callOk = true;
    try {
      chrome.runtime.sendMessage(
        { type: 'EXECUTE_TOOL', payload: { tool, args } },
        (resp) => {
          if (chrome.runtime.lastError) {
            console.warn('[BrowserPilot] 通信错误:', chrome.runtime.lastError.message);
            bpStatus('❌ 通信错误: ' + chrome.runtime.lastError.message.slice(0, 40), '#f87171');
            return;
          }
          if (resp && resp.ok) {
            const d = resp.data || {};
            bpStatus('✅ ' + tool + ' 完成' + (d.success === false ? ' (目标页失败)' : ''), d.success === false ? '#f87171' : '#34d399');
            injectResult(resp.data);
          } else {
            console.warn('[BrowserPilot] 执行失败:', resp && resp.error);
            bpStatus('❌ ' + tool + ' 失败: ' + String(resp && resp.error || '').slice(0, 40), '#f87171');
          }
        }
      );
    } catch (e) {
      callOk = false;
      console.warn('[BrowserPilot] runtime 已失效:', e);
      bpStatus('❌ 扩展已重载，请刷新本页面（F5）', '#f87171');
    }
    return callOk;
  }
  /* 自检模式下抑制结果回填，避免测试指令被当成消息发给 AI */
  let suppressResult = false;
  function injectResult(result) {
    if (suppressResult) { bpStatus('✅ 自检：结果回填链路正常（已抑制发送）', '#34d399'); return; }
    const input = adapter.getInput();
    if (!input) {
      /* 旧版本在这里静默 return，导致"执行成功但 AI 永远看不到结果"却毫无提示 */
      bpStatus('⚠️ 执行成功，但找不到 AI 输入框，结果未回传', '#f87171');
      console.warn('[BrowserPilot] injectResult: 找不到输入框，结果:', result);
      return;
    }
    const payload = '\n\n<tool_result>' + JSON.stringify(result) + '</tool_result>\n';
    const cur = (input.value || input.innerText || '');
    setInputValue(input, cur + payload);
    if (AUTO_SEND_RESULT) {
      const btn = adapter.getSend();
      if (btn) setTimeout(() => btn.click(), 200);
      else bpStatus('⚠️ 已填入结果，但找不到发送按钮，请手动发送', '#fbbf24');
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

  /* ---------- 浮动控制条 ----------
   * 注意：扩展重载后旧页面的旧脚本会留下一个"僵尸面板"，
   * 所以这里每次都先移除旧面板再重建（新脚本的 runtime 才是活的）。
   */
  const BP_VERSION = '4.2.2';
  function buildFloatingPanel() {
    const old = document.getElementById('bp-bridge-panel');
    if (old) old.remove();
    const panel = document.createElement('div');
    panel.id = 'bp-bridge-panel';
    panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111827;color:#fff;font:12px/1.4 sans-serif;padding:8px 10px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.3);display:flex;gap:8px;align-items:center;';
    const btn = document.createElement('button');
    btn.textContent = '🛰 注入协议';
    btn.style.cssText = 'background:#2563eb;color:#fff;border:none;padding:6px 10px;border-radius:8px;cursor:pointer;';
    btn.onclick = () => {
      try { injectProtocol(); }
      catch (e) { bpStatus('❌ 扩展已重载，请刷新本页面（F5）', '#f87171'); }
    };
    /* 自检按钮：完全绕过 AI，直接验证「消息通道 → 后台 → 目标页执行 → 检测管线」 */
    const testBtn = document.createElement('button');
    testBtn.textContent = '🧪 自检';
    testBtn.title = '绕过 AI 直接测试整条执行链路';
    testBtn.style.cssText = 'background:#7c3aed;color:#fff;border:none;padding:6px 10px;border-radius:8px;cursor:pointer;';
    testBtn.onclick = () => { try { runSelfTest(); } catch (e) { bpStatus('❌ 扩展已重载，请刷新本页面（F5）', '#f87171'); } };
    const info = document.createElement('span');
    info.textContent = adapter.name + ' v' + BP_VERSION;
    info.style.cssText = 'opacity:.8;';
    const status = document.createElement('span');
    status.id = 'bp-status-line';
    status.textContent = '监听中…';
    status.style.cssText = 'opacity:.9;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    bpStatusEl = status;
    panel.appendChild(info);
    panel.appendChild(status);
    panel.appendChild(testBtn);
    panel.appendChild(btn);
    document.body.appendChild(panel);
  }

  /* ---------- 自检：4 步定位断点 ----------
   * 1/4 后台连通（BP_GET_CONTEXT）→ 证明消息通道 + background 活着
   * 2/4 试开 example.com（browser_navigate）→ 证明后台建标签页 + 注入执行 OK
   * 3/4 读取目标页（browser_read）→ 证明目标页注入执行 + 结果回传 OK
   * 4/4 合成 <tool_call> 走检测管线 → 证明「扫描→解析→执行」这条 AI 指令路径 OK
   * 全过 ⇒ 问题只可能在「AI 是否按协议输出」；第 N 步挂 ⇒ 断点就在那里。
   */
  function sendMsg(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (chrome.runtime.lastError) resolve({ err: chrome.runtime.lastError.message });
          else resolve(resp || { err: '空响应' });
        });
      } catch (e) { resolve({ err: '扩展已重载，请刷新本页面: ' + e.message }); }
    });
  }
  async function runSelfTest() {
    bpStatus('🧪 1/4 后台连通…', '#fbbf24');
    const r1 = await sendMsg({ type: 'BP_GET_CONTEXT' });
    if (r1.err || !r1.ok) { bpStatus('❌ 1/4 后台不通: ' + String(r1.err || r1.error || '').slice(0, 50), '#f87171'); return; }
    const tid = r1.data && r1.data.targetTabId != null ? r1.data.targetTabId : '无';
    bpStatus('✅ 1/4 后台 OK（当前目标页: ' + tid + '）', '#34d399');

    bpStatus('🧪 2/4 试开 example.com…', '#fbbf24');
    const r2 = await sendMsg({ type: 'EXECUTE_TOOL', payload: { tool: 'browser_navigate', args: { url: 'https://example.com/' } } });
    if (r2.err || !r2.ok) { bpStatus('❌ 2/4 导航失败: ' + String(r2.err || r2.error || '').slice(0, 50), '#f87171'); return; }
    bpStatus('✅ 2/4 已打开 example.com', '#34d399');

    bpStatus('🧪 3/4 读取目标页…', '#fbbf24');
    const r3 = await sendMsg({ type: 'EXECUTE_TOOL', payload: { tool: 'browser_read', args: { maxLength: 200 } } });
    if (r3.err || !r3.ok || !(r3.data && r3.data.success !== false)) {
      bpStatus('❌ 3/4 读取失败: ' + String(r3.err || (r3.data && r3.data.error) || r3.error || '').slice(0, 50), '#f87171'); return;
    }
    const head = (r3.data.data && r3.data.data.content || '').replace(/\s+/g, ' ').slice(0, 30);
    bpStatus('✅ 3/4 目标页执行 OK: "' + head + '…"', '#34d399');

    bpStatus('🧪 4/4 合成指令走检测管线…', '#fbbf24');
    suppressResult = true;
    const fake = document.createElement('div');
    fake.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
    fake.textContent = '<tool_call>{"tool":"browser_scroll","args":{"amount":10,"direction":"down","nonce":' + Date.now() + '}}</tool_call>';
    document.body.appendChild(fake);
    try { detectToolCall(); } finally { setTimeout(() => { if (fake.parentNode) fake.parentNode.removeChild(fake); }, 500); }
    setTimeout(() => { suppressResult = false; }, 3000);
  }

  /* ---------- 接收弹窗的协议注入指令 ---------- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'BP_INJECT_PROTOCOL') {
      injectProtocol().then((r) => sendResponse(r));
      return true;
    }
    return false;
  });

  /* ---------- 启动：监听 document 级 + 动态补挂 shadow root + 低频兜底轮询 ----------
   * - 监听 document.documentElement 可覆盖普通 DOM 的流式/虚拟 DOM 变化；
   * - 每个轮询周期补挂新出现的 shadow root，避免 shadow 内 <tool_call> 漏检；
   * - MutationObserver 是主路径，setInterval（3s）仅作兜底
   *   （旧版 1.5s 全量扫描 + 逐节点 innerText，主线程压力过大）。
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
      collectShadowRoots(document.body, []).forEach((sr) => {
        if (!seenRoots.has(sr)) {
          seenRoots.add(sr);
          observeRoot(sr, obs);
        }
      });
    }
    scanAndMountShadow();
    setTimeout(scanAndMountShadow, 1500);
    detectToolCall(); // 首屏立即检测一次
    setInterval(() => { scanAndMountShadow(); detectToolCall(); }, 3000); // 低频兜底
    window.BrowserPilot = { injectProtocol, getPlatform: () => PLATFORM, detectNow: detectToolCall };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
