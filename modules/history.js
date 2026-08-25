/* -------------------------------------------------------------------------
 * modules/history.js — 历史记录：查询 / 预览 / 过滤 / 删除 / 导出
 * 危险操作统一走 background.js（SEARCH / DELETE_RANGE / DELETE_URL）。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;
  let cache = []; // 当前时间段查询到的全部记录（上限约 100）
  let filtered = []; // 经关键词过滤后的记录
  let range = null; // [start, end] 时间戳

  function parseDate(v) {
    const d = new Date(v + 'T00:00:00');
    return isNaN(d) ? null : d.getTime();
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function presets() {
    const now = new Date();
    const startOf = (off) => {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - off);
      return d.getTime();
    };
    const endOf = () => {
      const d = new Date(now);
      d.setHours(23, 59, 59, 999);
      return d.getTime();
    };
    return {
      today: [startOf(0), endOf()],
      '7': [startOf(6), endOf()],
      '30': [startOf(29), endOf()],
    };
  }

  HC.modules.history = {
    render(container) {
      const root = HC.el('div', { class: 'view' });

      const startI = HC.el('input', { class: 'input date', type: 'date' });
      const endI = HC.el('input', { class: 'input date', type: 'date' });
      const searchBtn = HC.el('button', { class: 'btn btn-primary', text: '查询', onclick: runSearch });
      const presetWrap = HC.el('div', { class: 'presets' }, [
        presetBtn('今天', 'today'),
        presetBtn('最近7天', '7'),
        presetBtn('最近30天', '30'),
      ]);

      const filter = HC.el('input', {
        class: 'input',
        type: 'search',
        placeholder: '在结果中按标题 / 网址过滤…',
      });
      const toolbar = HC.el('div', { class: 'toolbar' });
      const total = HC.el('div', { class: 'total' });
      const list = HC.el('div', { class: 'list' });

      root.appendChild(HC.el('div', { class: 'row glass' }, [presetWrap, startI, HC.el('span', { class: 'dash', text: '→' }), endI, searchBtn]));
      root.appendChild(HC.el('div', { class: 'row glass' }, [filter]));
      root.appendChild(toolbar);
      root.appendChild(total);
      root.appendChild(list);
      container.appendChild(root);

      function presetBtn(label, key) {
        return HC.el('button', {
          class: 'chip',
          text: label,
          onclick: () => {
            const p = presets()[key];
            range = p;
            startI.value = fmtDate(p[0]);
            endI.value = fmtDate(p[1]);
            runSearch();
          },
        });
      }

      function runSearch() {
        const s = parseDate(startI.value);
        const e = parseDate(endI.value);
        if (s == null || e == null) return HC.toast('请选择有效的起止日期', 'warn');
        range = [s, e];
        HC.callBackground('SEARCH', { startTime: s, endTime: e, maxResults: 100 })
          .then((items) => {
            cache = items.map((x) => ({ ...x, _sel: false }));
            applyFilter();
            HC.toast(`找到 ${items.length} 条（预览上限 100）`);
          })
          .catch((err) => HC.toast('查询失败：' + err.message, 'error'));
      }

      function applyFilter() {
        const q = (filter.value || '').trim().toLowerCase();
        filtered = cache.filter(
          (x) =>
            !q ||
            (x.title || '').toLowerCase().includes(q) ||
            (x.url || '').toLowerCase().includes(q)
        );
        renderList();
        total.textContent = `时间段内共 ${cache.length} 条，当前显示 ${filtered.length} 条`;
      }
      filter.addEventListener('input', applyFilter);

      function renderList() {
        toolbar.innerHTML = '';
        list.innerHTML = '';
        const selCount = filtered.filter((x) => x._sel).length;

        toolbar.appendChild(
          HC.el('label', { class: 'chk' }, [
            (() => {
              const c = HC.el('input', { type: 'checkbox' });
              c.checked = filtered.length > 0 && filtered.every((x) => x._sel);
              c.addEventListener('change', () => {
                filtered.forEach((x) => (x._sel = c.checked));
                renderList();
              });
              return c;
            })(),
            HC.el('span', { text: '全选' }),
          ])
        );
        toolbar.appendChild(HC.el('span', { class: 'counter', text: `已选 ${selCount}` }));
        toolbar.appendChild(HC.el('button', { class: 'btn', text: '删除选中', onclick: delSelected }));
        toolbar.appendChild(HC.el('button', { class: 'btn btn-danger', text: '删除全部', onclick: delAll }));
        toolbar.appendChild(HC.el('button', { class: 'btn', text: '导出JSON', onclick: () => exportData('json') }));
        toolbar.appendChild(HC.el('button', { class: 'btn', text: '导出CSV', onclick: () => exportData('csv') }));

        if (!filtered.length) {
          list.appendChild(HC.el('div', { class: 'empty', text: '没有记录' }));
          return;
        }
        filtered.forEach((x) => {
          const item = HC.el('label', { class: 'item' + (x._sel ? ' sel' : '') }, [
            (() => {
              const c = HC.el('input', { type: 'checkbox' });
              c.checked = !!x._sel;
              c.addEventListener('change', () => {
                x._sel = c.checked;
                renderList();
              });
              return c;
            })(),
            HC.el('div', { class: 'item-main' }, [
              HC.el('div', { class: 'item-title', text: x.title || x.url || '(无标题)' }),
              HC.el('a', {
                class: 'item-url',
                href: x.url,
                title: x.url,
                target: '_blank',
                rel: 'noopener',
                text: HC.truncate(x.url, 96),
              }),
            ]),
            HC.el('span', { class: 'item-time', text: HC.formatTime(x.lastVisitTime) }),
          ]);
          list.appendChild(item);
        });
      }

      function delSelected() {
        const sel = filtered.filter((x) => x._sel);
        if (!sel.length) return HC.toast('请先勾选要删除的记录', 'warn');
        HC.confirm({
          title: '删除选中的历史？',
          body: `将永久删除 <b>${sel.length}</b> 条历史记录，此操作<b>不可恢复</b>。`,
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          Promise.all(sel.map((x) => HC.callBackground('DELETE_URL', { url: x.url })))
            .then(() => {
              HC.toast(`已删除 ${sel.length} 条`, 'success');
              runSearch();
            })
            .catch((e) => HC.toast('删除失败：' + e.message, 'error'));
        });
      }

      function delAll() {
        if (!range) return HC.toast('请先查询时间段', 'warn');
        HC.confirm({
          title: '删除该时间段全部历史？',
          body: `将永久删除从 <b>${fmtDate(range[0])}</b> 到 <b>${fmtDate(range[1])}</b> 的<b>全部</b>历史记录，<b>不可恢复</b>。`,
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          HC.callBackground('DELETE_RANGE', { startTime: range[0], endTime: range[1] })
            .then(() => {
              HC.toast('已删除该时间段全部历史', 'success');
              runSearch();
            })
            .catch((e) => HC.toast('删除失败：' + e.message, 'error'));
        });
      }

      function exportData(kind) {
        const data = filtered;
        if (!data.length) return HC.toast('没有可导出的记录', 'warn');
        let content, name, mime;
        if (kind === 'json') {
          content = JSON.stringify(
            data.map((x) => ({
              title: x.title,
              url: x.url,
              lastVisitTime: x.lastVisitTime,
              visitCount: x.visitCount,
            })),
            null,
            2
          );
          mime = 'application/json';
          name = 'history.json';
        } else {
          const head = '﻿标题,网址,最后访问,访问次数\r\n';
          const rows = data
            .map(
              (x) =>
                `"${HC.escapeHtml(x.title || '')}","${x.url}","${HC.formatTime(x.lastVisitTime)}",${x.visitCount || 0}`
            )
            .join('\r\n');
          content = head + rows + '\r\n';
          mime = 'text/csv';
          name = 'history.csv';
        }
        const url = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(content);
        chrome.downloads.download({ url, filename: name, saveAs: true }, () =>
          HC.toast('已导出 ' + name)
        );
      }

      // 默认查询最近 7 天
      const p7 = presets()['7'];
      range = p7;
      startI.value = fmtDate(p7[0]);
      endI.value = fmtDate(p7[1]);
      runSearch();
    },
  };
})();
