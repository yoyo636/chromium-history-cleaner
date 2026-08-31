/* -------------------------------------------------------------------------
 * modules/cleanup.js — 浏览数据清理：按时间范围清理缓存 / Cookie / 历史等
 * 直接调用 chrome.browsingData.remove（popup 已声明 browsingData 权限）。
 *
 * 特性（实材实料）：
 * - 清理前「扫描」：真实统计可查询的项目
 *   · 浏览历史 → 条数 / 时间跨度 / 域名数（SEARCH_STATS）
 *   · 下载记录 → 条数 / 文件总大小（GB，来自 downloads.fileSize，真实值）+ 最大文件
 *   · 其余项目浏览器未提供统计接口，如实标注「—」
 * - 执行清理：对勾选项调用 browsingData.remove，逐项反馈
 * - 清理后自动复扫验证（历史 / 下载归零即证明已清）
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  // Firefox 的 browsingData 不支持 serviceWorkers / siteSettings，跨浏览器时过滤
  const TYPES = [
    { key: 'history', label: '浏览历史', scan: true },
    { key: 'downloads', label: '下载记录', scan: true },
    { key: 'cache', label: '缓存', scan: false },
    { key: 'cookies', label: 'Cookie', scan: false },
    { key: 'localStorage', label: '本地存储', scan: false },
    { key: 'formData', label: '表单数据', scan: false },
    { key: 'passwords', label: '密码', scan: false },
    { key: 'siteSettings', label: '网站设置', scan: false },
    { key: 'serviceWorkers', label: 'Service Worker', scan: false },
  ].filter((t) => {
    if (HC.isFirefox && (t.key === 'serviceWorkers' || t.key === 'siteSettings')) return false;
    return true;
  });

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

      // 清理项列表（每个带扫描明细）
      const cleanList = HC.el('div', { class: 'clean-list' });
      const checks = {};
      const detailEls = {};
      const badgeEls = {};

      TYPES.forEach(({ key, label, scan }) => {
        const c = HC.el('input', { type: 'checkbox' });
        if (key === 'cache' || key === 'history') c.checked = true;
        checks[key] = c;

        const badge = HC.el('span', { class: 'size-badge na', text: '扫描中…' });
        const detail = HC.el('div', { class: 'clean-detail', text: '' });
        badgeEls[key] = badge;
        detailEls[key] = detail;

        const row = HC.el('div', { class: 'clean-item' }, [
          HC.el('label', { class: 'chk' }, [c, HC.el('span', { text: '' })]),
          HC.el('div', { class: 'clean-body' }, [
            HC.el('div', { class: 'clean-head' }, [
              HC.el('span', { class: 'clean-name', text: label }),
              badge,
            ]),
            detail,
          ]),
        ]);
        cleanList.appendChild(row);
      });

      const scanBtn = HC.el('button', { class: 'btn', text: '重新扫描', onclick: scan });
      const runBtn = HC.el('button', { class: 'btn btn-danger', text: '执行清理', onclick: doClean });

      root.appendChild(HC.el('div', { class: 'row nowrap glass' }, [HC.el('span', { class: 'lbl', text: '时间范围' }), scopeSel, scanBtn]));
      root.appendChild(HC.el('div', { class: 'row glass' }, [HC.el('span', { class: 'lbl', text: '清理项与占用' })]));
      root.appendChild(cleanList);
      root.appendChild(
        HC.el('div', { class: 'row glass' }, [
          HC.el('p', { class: 'warn-text', text: '⚠️ 此操作将永久删除所选数据且不可恢复，请谨慎选择。' }),
        ])
      );
      root.appendChild(
        HC.el('div', { class: 'row glass' }, [
          HC.el('p', {
            class: 'note-text',
            text: '说明：浏览器未开放「缓存 / Cookie / 本地存储」等项目的精确占用查询接口，故对应大小如实显示为「—」；仅「下载记录」可读取真实文件大小。清理后会自动复扫验证。',
          }),
        ])
      );
      root.appendChild(runBtn);
      container.appendChild(root);

      /* ------------------------- 扫描 ------------------------- */
      let cleared = {}; // 已清理标记（复扫前展示）

      function setInfo(key, badge, detail) {
        if (cleared[key]) return; // 已清理的项保持「✓ 已清理」
        const b = badgeEls[key];
        b.textContent = badge || '—';
        b.className = 'size-badge ' + (badge === '—' ? 'na' : '');
        detailEls[key].textContent = detail || '';
      }

      function scan() {
        cleared = {};
        TYPES.forEach(({ key }) => {
          badgeEls[key].textContent = '扫描中…';
          badgeEls[key].className = 'size-badge na';
          detailEls[key].textContent = '';
        });

        // 1) 浏览历史：条数 / 跨度 / 域名
        HC.callBackground('SEARCH_STATS', { startTime: 0, endTime: Date.now() })
          .then((s) => {
            if (!s) return;
            const spanDays = s.earliest
              ? Math.max(1, Math.round((s.latest - s.earliest) / 86400000))
              : 0;
            setInfo(
              'history',
              s.count + ' 条',
              `${s.count} 条记录 · 跨度约 ${spanDays} 天 · ${s.domains.length} 个域名 · 总访问 ${s.totalVisits} 次` +
                (s.limited ? '（数据量极大，统计可能不完整）' : '')
            );
          })
          .catch(() => setInfo('history', '—', '统计失败'));

        // 2) 下载记录：真实文件大小（GB）+ 最大文件
        chrome.downloads.search({ limit: 1000 }, (items) => {
          const list = items || [];
          const comp = list.filter(
            (i) => i.state === 'complete' && typeof i.fileSize === 'number'
          );
          const total = comp.reduce((sum, i) => sum + (i.fileSize || 0), 0);
          const top = [...comp]
            .sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0))
            .slice(0, 3);
          const topTxt = top.length
            ? '最大文件：' + top.map((f) => `${f.filename || '未知'}（${HC.formatBytes(f.fileSize)}）`).join('；')
            : '';
          setInfo(
            'downloads',
            HC.formatBytes(total),
            `${list.length} 条记录 · 已下载文件总大小 ${HC.formatBytes(total)}${topTxt ? '。' + topTxt : ''}（清理仅移除记录，不删除磁盘文件）`
          );
        });

        // 3) 其余项目：如实标注无法统计
        TYPES.forEach(({ key, scan: canScan }) => {
          if (!canScan) setInfo(key, '—', '浏览器未提供该项的数量 / 大小统计接口');
        });
      }

      /* ------------------------- 执行清理 ------------------------- */
      function doClean() {
        const scope = SCOPES.find((s) => s[0] === scopeSel.value);
        const opts = {};
        const picked = [];
        TYPES.forEach(({ key, label }) => {
          if (checks[key].checked) {
            opts[key] = true;
            picked.push(label);
          }
        });
        if (!picked.length) return HC.toast('请至少选择一项', 'warn');

        const proceed = () => {
          HC.toast('正在清理…', 'info');
          runBtn.disabled = true;
          scanBtn.disabled = true;
          const since = scope[2] === 0 ? 0 : Date.now() - scope[2];
          chrome.browsingData.remove({ since }, opts, () => {
            runBtn.disabled = false;
            scanBtn.disabled = false;
            if (chrome.runtime.lastError)
              return HC.toast('清理失败：' + chrome.runtime.lastError.message, 'error');
            // 逐项标记已清理
            TYPES.forEach(({ key, label }) => {
              if (checks[key].checked) {
                cleared[key] = true;
                badgeEls[key].textContent = '✓ 已清理';
                badgeEls[key].className = 'size-badge ok';
                detailEls[key].textContent = `${label} 已清除（${scope[1]}范围）`;
              }
            });
            HC.toast(`清理完成：${picked.join('、')}`, 'success');
            // 复扫验证（历史 / 下载归零即证明已清）
            setTimeout(scan, 600);
          });
        };

        // 尊重「清理二次确认」偏好
        HC.getPrefs().then((prefs) => {
          if (prefs.cleanupConfirm === false) return proceed();
          HC.confirm({
            title: '确认清理？',
            bodyHtml: `将清理 <b>${scope[1]}</b> 内的：<b>${picked.join('、')}</b>，<b>不可恢复</b>。`,
            danger: true,
          }).then((ok) => ok && proceed());
        });
      }

      // 进入模块即自动扫描
      scan();
    },
  };
})();
