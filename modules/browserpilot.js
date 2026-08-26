/* -------------------------------------------------------------------------
 * modules/browserpilot.js — BrowserPilot 弹窗模块
 * 让用户从扩展弹窗里：注入协议到当前 AI 对话、查看当前操作目标页、了解支持平台。
 * 注册到 HC.modules.browserpilot，由 popup.js 的导航调度。
 * ------------------------------------------------------------------------- */

(function () {
  const HC = (window.HC = window.HC || {});
  HC.modules = HC.modules || {};

  function platformName(host) {
    if (!host) return '（无）';
    if (host.includes('kimi.moonshot.cn')) return 'Kimi';
    if (host.includes('chat.deepseek.com')) return 'DeepSeek';
    if (host.includes('chat.minimaxi.com')) return 'MiniMax';
    return host;
  }

  HC.modules.browserpilot = {
    render(container) {
      const wrap = HC.el('div', { class: 'bp-module' });

      wrap.appendChild(
        HC.el('div', { class: 'section-title', text: 'BrowserPilot · AI 操控浏览器' })
      );

      wrap.appendChild(
        HC.el('p', {
          class: 'bp-desc',
          text:
            '让网页端 AI（Kimi / DeepSeek / MiniMax）通过结构化指令，安全控制你正在浏览的网页：点击、输入、滚动、读取、截图等。所有敏感操作（支付 / 密码 / 发送 / 删除）都会弹窗让你二次确认。',
        })
      );

      // 操作区
      const actions = HC.el('div', { class: 'bp-actions' });

      const injectBtn = HC.el('button', {
        class: 'btn btn-primary',
        text: '🛰 注入协议到当前 AI 对话',
        onclick: async () => {
          injectBtn.disabled = true;
          try {
            await HC.callBackground('BP_INJECT_PROTOCOL');
            HC.toast('协议已注入，请回到 AI 对话页发送');
          } catch (e) {
            HC.toast(e.message || '注入失败', 'warn');
          } finally {
            injectBtn.disabled = false;
          }
        },
      });

      const statusBox = HC.el('div', { class: 'bp-status', text: '当前目标页：查询中…' });
      actions.appendChild(injectBtn);
      actions.appendChild(statusBox);
      wrap.appendChild(actions);

      // 查询当前目标页
      HC.callBackground('BP_GET_CONTEXT')
        .then((ctx) => {
          if (ctx && ctx.targetTabId) {
            chrome.tabs.get(ctx.targetTabId, (t) => {
              if (chrome.runtime.lastError) statusBox.textContent = '当前目标页：未知';
              else
                statusBox.textContent =
                  '当前目标页：' + platformName(t.url) + '（' + (t.title || t.url || '') + '）';
            });
          } else {
            statusBox.textContent = '当前目标页：未指定（请先打开要操作的网页）';
          }
        })
        .catch(() => (statusBox.textContent = '当前目标页：查询失败'));

      // 支持平台
      wrap.appendChild(HC.el('div', { class: 'section-subtitle', text: '支持的平台' }));
      const list = HC.el('ul', { class: 'bp-list' });
      [
        'Kimi（kimi.moonshot.cn）',
        'DeepSeek（chat.deepseek.com）',
        'MiniMax（chat.minimaxi.com，预留）',
      ].forEach((t) => list.appendChild(HC.el('li', { text: t })));
      wrap.appendChild(list);

      // 使用步骤
      wrap.appendChild(HC.el('div', { class: 'section-subtitle', text: '使用步骤' }));
      const steps = HC.el('ol', { class: 'bp-list' });
      [
        '打开 Kimi / DeepSeek 对话页，点上方「注入协议」把协议文档发进对话。',
        '另开一个你想操作的普通网页（如京东），作为 AI 的操作目标。',
        '对 AI 说「帮我在京东搜索 iPhone」，AI 会按协议输出 <tool_call> 指令。',
        '本扩展捕获指令并在目标页执行，结果以 <tool_result> 回传给 AI 继续。',
      ].forEach((t) => steps.appendChild(HC.el('li', { text: t })));
      wrap.appendChild(steps);

      container.appendChild(wrap);
    },
  };
})();
