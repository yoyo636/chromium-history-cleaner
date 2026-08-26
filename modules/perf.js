/* -------------------------------------------------------------------------
 * modules/perf.js — 标签页性能透视
 * 展示每个标签的 CPU 繁忙度（longtask 占比）、JS 堆内存、帧率与归因脚本，
 * 按资源消耗排序；支持「冻结」（tabs.discard 释放内存）与「关闭」。
 * 说明（如实）：chrome.processes 已废弃、无系统级 CPU/GPU/温度 API，
 * 这里使用 PerformanceObserver(longtask) + performance.memory + 帧率 评估。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  function statusOf(busy) {
    if (busy == null) return { cls: 'na', text: '…', label: '暂无数据' };
    if (busy >= 75) return { cls: 'red', text: '高', label: '占用异常' };
    if (busy >= 40) return { cls: 'yellow', text: '中', label: '占用较高' };
    return { cls: 'green', text: '低', label: '正常' };
  }

  function dot(s) {
    return HC.el('span', {
      class: 'perf-dot ' + s.cls,
      title: 'CPU 繁忙度：' + s.label,
      text: s.text,
    });
  }

  HC.modules.perf = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      const refreshBtn = HC.el('button', { class: 'btn', text: '刷新', onclick: load });
      const list = HC.el('div', { class: 'clean-list' });
      const note = HC.el('p', {
        class: 'note-text',
        text: '指标说明：CPU 繁忙度 = 主线程长任务占比（PerformanceObserver）；内存 = JS 堆占用（近似值）；帧率 = 渲染/GPU 压力代理。浏览器已移除 chrome.processes，无法读取系统级 CPU/GPU/温度。',
      });

      root.appendChild(HC.el('div', { class: 'row nowrap glass' }, [
        HC.el('div', { class: 'section-title', text: '标签页资源透视（按繁忙度排序）' }),
        HC.el('span', { style: 'flex:1;' }),
        refreshBtn,
      ]));
      root.appendChild(list);
      root.appendChild(HC.el('div', { class: 'row glass' }, [note]));
      container.appendChild(root);

      function load() {
        list.innerHTML = '';
        list.appendChild(HC.el('div', { class: 'empty', text: '加载中…' }));
        HC.callBackground('TABS_PERF')
          .then((tabs) => {
            render(tabs);
          })
          .catch((e) => {
            list.innerHTML = '';
            list.appendChild(HC.el('div', { class: 'empty', text: '加载失败：' + e.message }));
          });
      }

      function render(tabs) {
        list.innerHTML = '';
        const rows = (tabs || []).sort((a, b) => {
          const ba = a.perf ? a.perf.busy : 0;
          const bb = b.perf ? b.perf.busy : 0;
          return bb - ba;
        });
        if (!rows.length) {
          list.appendChild(HC.el('div', { class: 'empty', text: '没有打开的标签页' }));
          return;
        }
        rows.forEach((t) => {
          const p = t.perf;
          const s = statusOf(p ? p.busy : null);
          const attrib = (p && p.attrib && p.attrib.length
            ? p.attrib.slice(0, 2).map((a) => a.url.replace(/^https?:\/\//, '').slice(0, 40))
            : ['暂无归因']).join('；');

          const acts = HC.el('span', { class: 'item-acts' });
          if (p && p.busy >= 40) {
            acts.appendChild(HC.el('button', {
              class: 'mini danger',
              text: '冻结',
              title: '冻结（discard）可释放内存，点击恢复重新加载',
              onclick: () => {
                HC.callBackground('TAB_ACTION', { action: 'discard', tabId: t.id })
                  .then(() => { HC.toast('已冻结该标签', 'success'); load(); })
                  .catch((e) => HC.toast(e.message, 'error'));
              },
            }));
          }
          acts.appendChild(HC.el('button', {
            class: 'mini danger',
            text: '关闭',
            onclick: () => {
              HC.confirm({ title: '关闭该标签？', body: `将关闭「${HC.escapeHtml(t.title || '')}」。`, danger: true })
                .then((ok) => ok && HC.callBackground('TAB_ACTION', { action: 'close', tabId: t.id })
                  .then(() => { HC.toast('已关闭', 'success'); load(); })
                  .catch((e) => HC.toast(e.message, 'error')));
            },
          }));

          const sub = p
            ? `CPU 繁忙 ${p.busy}% · 内存 ${HC.formatBytes(p.heap)} · ${p.fps} FPS · 长任务 ${p.longTasks} 次/分${p.media && p.media.autoplay ? ' · ⏵自动播放×' + p.media.autoplay : ''}`
            : '等待该标签首次上报（约 1 分钟内）';

          const row = HC.el('div', { class: 'clean-item' }, [
            dot(s),
            HC.el('div', { class: 'clean-body' }, [
              HC.el('div', { class: 'clean-head' }, [
                HC.el('span', { class: 'clean-name', title: t.title, text: HC.truncate(t.title || '(无标题)', 40) }),
                HC.el('span', { class: 'tag', text: t.audible ? '🔊 发声' : '' }),
              ]),
              HC.el('div', { class: 'clean-detail', text: sub }),
              HC.el('div', { class: 'clean-detail', text: '可能原因：' + attrib }),
            ]),
            acts,
          ]);
          list.appendChild(row);
        });
      }

      load();
    },
  };
})();
