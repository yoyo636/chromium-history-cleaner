/* -------------------------------------------------------------------------
 * modules/downloads.js — 下载管理：查看 / 打开 / 打开文件夹 / 复制 / 移除记录
 * 直接调用 chrome.downloads.*（popup 已声明 downloads 权限）。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;
  let items = [];
  let filtered = [];

  function statusText(s) {
    return { 0: '进行中', 1: '已完成', 2: '已中断', 3: '已取消', 4: '出错' }[s] || '未知';
  }

  HC.modules.downloads = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      const search = HC.el('input', {
        class: 'input',
        type: 'search',
        placeholder: '按文件名或网址过滤…',
      });
      const toolbar = HC.el('div', { class: 'toolbar' }, [
        HC.el('span', { class: 'counter', text: '操作：打开 / 文件夹 / 复制 / 移除记录' }),
      ]);
      const total = HC.el('div', { class: 'total' });
      const list = HC.el('div', { class: 'list' });

      root.appendChild(HC.el('div', { class: 'row glass' }, [search]));
      root.appendChild(toolbar);
      root.appendChild(total);
      root.appendChild(list);
      container.appendChild(root);

      function apply() {
        const q = (search.value || '').trim().toLowerCase();
        filtered = items.filter(
          (x) =>
            !q ||
            (x.filename || '').toLowerCase().includes(q) ||
            (x.url || '').toLowerCase().includes(q) ||
            (x.byExtensionName || '').toLowerCase().includes(q)
        );
        render();
      }
      search.addEventListener('input', apply);

      function render() {
        list.innerHTML = '';
        total.textContent = `共 ${items.length} 条下载记录，当前显示 ${filtered.length} 条`;
        if (!filtered.length) {
          list.appendChild(HC.el('div', { class: 'empty', text: '没有下载记录' }));
          return;
        }
        filtered.forEach((x) => {
          const acts = HC.el('div', { class: 'item-acts' }, [
            HC.el('button', { class: 'mini', text: '打开', onclick: () => chrome.downloads.open(x.id) }),
            HC.el('button', { class: 'mini', text: '文件夹', onclick: () => chrome.downloads.show(x.id) }),
            HC.el('button', {
              class: 'mini',
              text: '复制网址',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(x.url);
                  HC.toast('已复制', 'success');
                } catch {
                  HC.toast('复制失败', 'error');
                }
              },
            }),
            HC.el('button', {
              class: 'mini danger',
              text: '移除',
              onclick: () => {
                chrome.downloads.erase({ id: x.id });
                HC.toast('已移除记录');
                x._gone = true;
                render();
              },
            }),
          ]);
          const item = HC.el('div', { class: 'item' }, [
            HC.el('div', { class: 'item-main' }, [
              HC.el('div', { class: 'item-title', text: (x.filename || '').split('/').pop() || '(未知文件)' }),
              HC.el('a', {
                class: 'item-url',
                href: x.url,
                title: x.url,
                target: '_blank',
                rel: 'noopener',
                text: HC.truncate(x.url, 80),
              }),
              HC.el('div', {
                class: 'item-sub',
                text: `${statusText(x.state)} · ${HC.formatBytes(x.fileSize)} · ${HC.formatTime(new Date(x.startTime).getTime())}`,
              }),
            ]),
            acts,
          ]);
          list.appendChild(item);
        });
      }

      chrome.downloads.search({ limit: 1000, orderBy: ['-startTime'] }, (its) => {
        items = its || [];
        apply();
      });
    },
  };
})();
