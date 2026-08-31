/* bp-confirm.js — BrowserPilot 敏感操作确认窗（独立扩展页面）
 * 通过消息从 background 取确认内容，用户点击后回传决定并关闭窗口。
 * 消息内容一律 textContent 渲染，杜绝注入。 */
'use strict';

(() => {
  const id = new URLSearchParams(location.search).get('id') || '';
  const msgEl = document.getElementById('msg');
  const okBtn = document.getElementById('ok');
  const cancelBtn = document.getElementById('cancel');

  function answer(ok) {
    try {
      chrome.runtime.sendMessage({ type: 'BP_CONFIRM_RESULT', payload: { id, ok } }, () => {
        window.close();
      });
    } catch (_e) {
      window.close();
    }
  }

  if (!id) {
    msgEl.textContent = '无效的确认请求（缺少 id）。';
    okBtn.disabled = true;
  } else {
    chrome.runtime.sendMessage({ type: 'BP_CONFIRM_GET', payload: { id } }, (resp) => {
      const message = resp && resp.ok && resp.data && resp.data.message;
      if (message) {
        msgEl.textContent = message;
      } else {
        msgEl.textContent = '确认请求已失效（可能已超时或已处理），请关闭本窗口。';
        okBtn.disabled = true;
      }
    });
  }

  okBtn.addEventListener('click', () => answer(true));
  cancelBtn.addEventListener('click', () => answer(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !okBtn.disabled) answer(true);
    else if (e.key === 'Escape') answer(false);
  });
})();
