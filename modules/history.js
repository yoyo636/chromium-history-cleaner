/* -------------------------------------------------------------------------
 * modules/history.js — 历史记录：查询 / 预览 / 过滤 / 删除 / 导出
 * - 支持「全部时间」：startTime=0 起查询，不再限制近 N 天
 * - 走后台 SEARCH_ALL（时间窗二分），突破单次 100 条上限，可拿全量数据
 * - 大量数据时分页渲染（每页 500 条 + 加载更多），删除/导出作用于全量
 * 危险操作统一走 background.js（SEARCH_ALL / DELETE_RANGE / DELETE_URL）。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;
  const PAGE_SIZE = 500;

  let cache = []; // 全量记录（含 _sel 标记）
  let filtered = []; // 经关键词过滤后的全量记录
  let shown = 0; // 当前已渲染条数
  let range = null; // [start, end] 时间戳；null 表示未查询
  let busy = false;

  /* edge='start' → 当天 00:00:00.000；edge='end' → 当天 23:59:59.999
   * 结束日期必须取当天末尾，否则选「到今天」时今天的记录落在范围外、删不掉。 */
  function parseDate(v, edge) {
    if (!v) return null;
    const d = new Date(v + (edge === 'end' ? 'T23:59:59.999' : 'T00:00:00.000'));
    const t = d.getTime();
    return isNaN(t) ? null : t;
  }
  function fmtDate(ts) {
    if (!ts) return '';
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
      all: [0, Date.now()], // 全部时间：从最早到当前
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
        presetBtn('全部时间', 'all'),
      ]);

      const filter = HC.el('input', {
        class: 'input',
        type: 'search',
        placeholder: '在结果中按标题 / 网址过滤…',
      });
      const toolbar = HC.el('div', { class: 'toolbar' });
      const total = HC.el('div', { class: 'total' });
      const list = HC.el('div', { class: 'list' });

      root.appendChild(
        HC.el('div', { class: 'row glass' }, [presetWrap, startI, HC.el('span', { class: 'dash', text: '→' }), endI, searchBtn])
      );
      root.appendChild(HC.el('div', { class: 'row glass' }, [filter]));
      root.appendChild(toolbar);
      root.appendChild(total);
      root.appendChild(list);
      container.appendChild(root);

      function presetBtn(label, key) {
        return HC.el('button', {
          class: 'chip',
          text: label,
          onclick: (e) => {
            const p = presets()[key];
            range = p;
            if (key === 'all') {
              startI.value = '';
              endI.value = '';
            } else {
              startI.value = fmtDate(p[0]);
              endI.value = fmtDate(p[1]);
            }
            presetWrap.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
            e.currentTarget.classList.add('active');
            runSearch();
          },
        });
      }

      function runSearch() {
        if (busy) return;
        // 空值处理：起始为空 → 0（最早）；结束为空 → 现在
        let s = parseDate(startI.value, 'start');
        let e = parseDate(endI.value, 'end');
        if (s == null) s = 0;
        if (e == null) e = Date.now();
        if (e <= s) return HC.toast('结束日期需晚于开始日期', 'warn');
        range = [s, e];
        busy = true;
        searchBtn.disabled = true;
        list.innerHTML = '';
        list.appendChild(HC.el('div', { class: 'empty', text: '正在查询全部历史（数据量大时稍候）…' }));
        toolbar.innerHTML = '';
        total.textContent = '';

        HC.callBackground('SEARCH_ALL', { startTime: s, endTime: e })
          .then((items) => {
            cache = (items || []).map((x) => ({ ...x, _sel: false }));
            busy = false;
            searchBtn.disabled = false;
            shown = 0;
            applyFilter(true);
            HC.toast(`找到 ${cache.length} 条记录`);
          })
          .catch((err) => {
            busy = false;
            searchBtn.disabled = false;
            cache = [];
            filtered = [];
            shown = 0;
            renderList(); // 保留工具栏（删除全部仍可用）
            total.textContent = `时间范围：${scopeText()} ｜ 查询失败：${err.message}`;
            list.appendChild(HC.el('div', { class: 'empty', text: '查询失败：' + err.message + '（可直接使用「删除全部」清理该时间段）' }));
            HC.toast('查询失败：' + err.message, 'error');
          });
      }

      function scopeText() {
        if (!range) return '未设置';
        return range[0] === 0 ? '全部时间' : `${fmtDate(range[0])} ~ ${fmtDate(range[1])}`;
      }

      function applyFilter(resetShown) {
        if (resetShown) shown = 0;
        const q = (filter.value || '').trim().toLowerCase();
        filtered = cache.filter(
          (x) =>
            !q ||
            (x.title || '').toLowerCase().includes(q) ||
            (x.url || '').toLowerCase().includes(q)
        );
        renderList();
        const scope = range && range[0] === 0 ? '全部时间' : `${fmtDate(range[0])} ~ ${fmtDate(range[1])}`;
        total.textContent = `时间范围：${scope} ｜ 共 ${cache.length} 条，当前显示 ${filtered.length} 条`;
      }
      filter.addEventListener('input', () => applyFilter(true));

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
        const vis = filtered.slice(0, shown);
        vis.forEach((x) => {
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
              HC.el('div', { class: 'item-title', title: x.title || x.url || '(无标题)', text: x.title || x.url || '(无标题)' }),
              HC.el('a', {
                class: 'item-url',
                href: x.url,
                title: x.url,
                target: '_blank',
                rel: 'noopener',
                text: HC.truncate(x.url, 120),
              }),
            ]),
            HC.el('span', { class: 'item-time', text: HC.formatTime(x.lastVisitTime) }),
            HC.el('span', { class: 'item-acts' }, [
              HC.el('button', {
                class: 'mini danger',
                text: '删除',
                onclick: (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  delOne(x);
                },
              }),
            ]),
          ]);
          list.appendChild(item);
        });

        // 分页：加载更多
        if (filtered.length > shown) {
          list.appendChild(
            HC.el('button', {
              class: 'btn load-more',
              text: `加载更多（还有 ${filtered.length - shown} 条）`,
              onclick: () => {
                shown += PAGE_SIZE;
                renderList();
              },
            })
          );
        }
      }

      function delOne(x) {
        HC.confirm({
          title: '删除这条历史？',
          body: `将永久删除 <b>${HC.escapeHtml(x.title || x.url || '(无标题)')}</b>，此操作<b>不可恢复</b>。`,
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          HC.toast('正在删除…', 'info');
          HC.callBackground('DELETE_URL', { url: x.url })
            .then(() => {
              HC.toast('已删除', 'success');
              runSearch();
            })
            .catch((e) => HC.toast('删除失败：' + e.message, 'error'));
        });
      }

      /* 分块删除：一次并发几千条 sendMessage 会打满消息通道导致大面积失败，
       * 改成每批 25 条并发、批次串行，并如实统计成功/失败条数。 */
      const DEL_BATCH = 25;
      async function deleteUrls(list) {
        let okCount = 0;
        let failCount = 0;
        for (let i = 0; i < list.length; i += DEL_BATCH) {
          const chunk = list.slice(i, i + DEL_BATCH);
          const rs = await Promise.all(
            chunk.map((x) =>
              HC.callBackground('DELETE_URL', { url: x.url }).then(
                () => true,
                () => false
              )
            )
          );
          rs.forEach((r) => (r ? okCount++ : failCount++));
        }
        return { okCount, failCount };
      }

      function delSelected() {
        const sel = filtered.filter((x) => x._sel);
        if (!sel.length) return HC.toast('请先勾选要删除的记录', 'warn');
        HC.confirm({
          title: '删除选中的历史？',
          body: `将永久删除 <b>${sel.length}</b> 条历史记录，此操作<b>不可恢复</b>。`,
          danger: true,
        }).then(async (ok) => {
          if (!ok) return;
          HC.toast(`正在删除 ${sel.length} 条…`, 'info');
          const { okCount, failCount } = await deleteUrls(sel);
          HC.toast(
            failCount ? `已删除 ${okCount} 条，${failCount} 条失败` : `已删除 ${okCount} 条`,
            failCount ? 'warn' : 'success'
          );
          runSearch();
        });
      }

      function delAll() {
        if (!range) return HC.toast('请先查询时间段', 'warn');
        const scope = range[0] === 0 ? '全部时间' : `${fmtDate(range[0])} 到 ${fmtDate(range[1])}`;
        HC.confirm({
          title: '删除该时间段全部历史？',
          body: `将永久删除 <b>${scope}</b> 范围内的<b>全部</b>历史记录，<b>不可恢复</b>。`,
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          HC.toast('正在删除…', 'info');
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
          name = 'history_' + (range ? `${fmtDate(range[0])}_${fmtDate(range[1])}` : 'all') + '.json';
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
          name = 'history_' + (range ? `${fmtDate(range[0])}_${fmtDate(range[1])}` : 'all') + '.csv';
        }
        HC.toast(`正在导出 ${data.length} 条…`, 'info');
        const url = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(content);
        chrome.downloads.download({ url, filename: name, saveAs: true }, () =>
          HC.toast('已导出 ' + name)
        );
      }

      // 默认按用户设置的历史范围查询（默认最近 7 天）
      HC.getPrefs().then((prefs) => {
        const key = presets()[prefs.defRange] ? prefs.defRange : '7';
        const p = presets()[key];
        range = p;
        if (key === 'all') {
          startI.value = '';
          endI.value = '';
        } else {
          startI.value = fmtDate(p[0]);
          endI.value = fmtDate(p[1]);
        }
        presetWrap.querySelectorAll('.chip').forEach((c) => {
          if (c.textContent === (key === 'all' ? '全部时间' : (key === 'today' ? '今天' : '最近' + key + '天'))) c.classList.add('active');
        });
        runSearch();
      });
    },
  };
})();
