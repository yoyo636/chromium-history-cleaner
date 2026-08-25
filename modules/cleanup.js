/* -------------------------------------------------------------------------
 * modules/cleanup.js — 浏览数据清理：按时间范围清理缓存 / Cookie / 历史等
 * 直接调用 chrome.browsingData.remove（popup 已声明 browsingData 权限）。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;
  const TYPES = [
    ['history', '浏览历史'],
    ['downloads', '下载记录'],
    ['cache', '缓存'],
    ['cookies', 'Cookie'],
    ['localStorage', '本地存储'],
    ['formData', '表单数据'],
    ['passwords', '密码'],
    ['siteSettings', '网站设置'],
    ['serviceWorkers', 'Service Worker'],
  ];
  const SCOPES = [
    ['hour', '最近 1 小时', 3600000],
    ['day', '最近 24 小时', 86400000],
    ['week', '最近 7 天', 604800000],
    ['all', '全部（从最早）', 0],
  ];

  HC.modules.cleanup = {
    render(container) {
      const root = HC.el('div', { class: 'view' });

      const scopeSel = HC.el('select', { class: 'input' });
      SCOPES.forEach(([v, l]) => scopeSel.appendChild(HC.el('option', { value: v, text: l })));

      const typeBox = HC.el('div', { class: 'checks' });
      const checks = {};
      TYPES.forEach(([k, l]) => {
        const c = HC.el('input', { type: 'checkbox' });
        if (k === 'cache' || k === 'history') c.checked = true;
        checks[k] = c;
        typeBox.appendChild(HC.el('label', { class: 'chk' }, [c, HC.el('span', { text: l })]));
      });

      const runBtn = HC.el('button', { class: 'btn btn-danger', text: '执行清理', onclick: doClean });

      root.appendChild(HC.el('div', { class: 'row glass' }, [HC.el('span', { class: 'lbl', text: '时间范围' }), scopeSel]));
      root.appendChild(HC.el('div', { class: 'row glass' }, [HC.el('span', { class: 'lbl', text: '清理项' }), typeBox]));
      root.appendChild(
        HC.el('div', { class: 'row glass' }, [
          HC.el('p', { class: 'warn-text', text: '⚠️ 此操作将永久删除所选数据且不可恢复，请谨慎选择。' }),
        ])
      );
      root.appendChild(runBtn);
      container.appendChild(root);

      function doClean() {
        const scope = SCOPES.find((s) => s[0] === scopeSel.value);
        const opts = {};
        let any = false;
        TYPES.forEach(([k]) => {
          if (checks[k].checked) {
            opts[k] = true;
            any = true;
          }
        });
        if (!any) return HC.toast('请至少选择一项', 'warn');
        HC.confirm({
          title: '确认清理？',
          body: `将清理 <b>${scope[1]}</b> 内的所选数据，<b>不可恢复</b>。`,
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          const since = scope[2] === 0 ? 0 : Date.now() - scope[2];
          chrome.browsingData.remove({ since }, opts, () => {
            if (chrome.runtime.lastError)
              return HC.toast('清理失败：' + chrome.runtime.lastError.message, 'error');
            HC.toast('清理完成', 'success');
          });
        });
      }
    },
  };
})();
