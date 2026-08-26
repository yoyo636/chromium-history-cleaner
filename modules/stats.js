/* -------------------------------------------------------------------------
 * modules/stats.js — 数据统计：基于历史记录的分析
 * 走后台 SEARCH_STATS（时间窗二分聚合），可统计任意范围（含全部时间）。
 * 展示：总记录数 / 总访问次数 / 时间跨度 / 活跃域名数，
 *       Top 域名（条形图）与 Top 页面。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  const RANGES = [
    ['7', '最近 7 天'],
    ['30', '最近 30 天'],
    ['90', '最近 90 天'],
    ['all', '全部时间'],
  ];

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (_e) {
      return '(未知)';
    }
  }

  function fmtShortDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  HC.modules.stats = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      const presetWrap = HC.el('div', { class: 'presets' });
      const out = HC.el('div', { class: 'stats-wrap' });

      root.appendChild(HC.el('div', { class: 'row nowrap glass' }, [presetWrap]));
      root.appendChild(out);
      container.appendChild(root);

      function load(key) {
        const now = Date.now();
        const start = key === 'all' ? 0 : now - Number(key) * 86400000;
        out.innerHTML = '';
        out.appendChild(HC.el('div', { class: 'empty', text: '统计中…' }));
        HC.callBackground('SEARCH_STATS', { startTime: start, endTime: now })
          .then((s) => renderStats(out, s))
          .catch((e) => {
            out.innerHTML = '';
            out.appendChild(HC.el('div', { class: 'empty', text: '统计失败：' + e.message }));
          });
      }

      RANGES.forEach(([k, l]) =>
        presetWrap.appendChild(
          HC.el('button', {
            class: 'chip',
            text: l,
            onclick: (ev) => {
              presetWrap.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
              ev.currentTarget.classList.add('active');
              load(k);
            },
          })
        )
      );

      // 默认选中最近 30 天并统计
      presetWrap.querySelectorAll('.chip')[1].classList.add('active');
      load('30');
    },
  };

  function renderStats(out, s) {
    if (!s) return;
    out.innerHTML = '';

    // 概览卡片
    const cards = HC.el('div', { class: 'stats-grid' });
    const mk = (v, l) =>
      HC.el('div', { class: 'stat glass' }, [
        HC.el('div', { class: 'stat-value', text: String(v), title: String(v) }),
        HC.el('div', { class: 'stat-label', text: l }),
      ]);
    cards.appendChild(mk(s.count, '历史记录条数'));
    cards.appendChild(mk(s.totalVisits, '总访问次数'));
    cards.appendChild(mk(s.domains.length, '活跃域名数'));
    cards.appendChild(mk(fmtShortDate(s.earliest) + ' ~ ' + fmtShortDate(s.latest), '时间跨度'));
    out.appendChild(cards);
    if (s.limited) {
      out.appendChild(
        HC.el('p', { class: 'note-text', text: '⚠️ 数据量极大，统计可能不完整。', style: 'padding:0 4px;' })
      );
    }

    // Top 域名
    const domainMap = new Map();
    (s.top || []).forEach(({ url, count }) => {
      const h = hostOf(url);
      domainMap.set(h, (domainMap.get(h) || 0) + count);
    });
    const domainTop = [...domainMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (domainTop.length) {
      const max = domainTop[0][1] || 1;
      const box = HC.el('div', { class: 'row glass' }, [
        HC.el('div', { class: 'block', style: 'flex:1;width:100%;' }, [
          HC.el('div', { class: 'section-title', text: 'Top 10 域名' }),
          HC.el('div', { class: 'bar-list' }, domainTop.map(([h, c]) =>
            HC.el('div', { class: 'bar-row' }, [
              HC.el('span', { class: 'bar-label', title: h, text: h }),
              HC.el('div', { class: 'bar-track' }, [
                HC.el('div', { class: 'bar-fill', style: `width:${Math.max(2, (c / max) * 100)}%` }),
              ]),
              HC.el('span', { class: 'bar-val', text: String(c) }),
            ])
          )),
        ]),
      ]);
      out.appendChild(box);
    }

    // Top 页面
    const pageTop = (s.top || []).slice(0, 10);
    if (pageTop.length) {
      const max = pageTop[0].count || 1;
      const box = HC.el('div', { class: 'row glass' }, [
        HC.el('div', { class: 'block', style: 'flex:1;width:100%;' }, [
          HC.el('div', { class: 'section-title', text: 'Top 10 页面' }),
          HC.el('div', { class: 'bar-list' }, pageTop.map(({ url, count }) =>
            HC.el('div', { class: 'bar-row' }, [
              HC.el('span', { class: 'bar-label', title: url, text: HC.truncate(url, 40) }),
              HC.el('div', { class: 'bar-track' }, [
                HC.el('div', { class: 'bar-fill', style: `width:${Math.max(2, (count / max) * 100)}%` }),
              ]),
              HC.el('span', { class: 'bar-val', text: String(count) }),
            ])
          )),
        ]),
      ]);
      out.appendChild(box);
    }

    if (!domainTop.length && !pageTop.length) {
      out.appendChild(HC.el('div', { class: 'empty', text: '该时间段内没有历史记录' }));
    }
  }
})();
