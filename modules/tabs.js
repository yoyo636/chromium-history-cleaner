/* -------------------------------------------------------------------------
 * modules/tabs.js — 标签管理：批量关闭 / 去重 / 按域名关闭 / 复制 / 存档
 * 直接调用 chrome.tabs.*（popup 已声明 tabs 权限）。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;
  let tabs = [];
  let filtered = [];

  HC.modules.tabs = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      const search = HC.el('input', {
        class: 'input',
        type: 'search',
        placeholder: '按标题或网址过滤…',
      });
      const toolbar = HC.el('div', { class: 'toolbar' });
      const total = HC.el('div', { class: 'total' });
      const list = HC.el('div', { class: 'list' });

      root.appendChild(HC.el('div', { class: 'row glass' }, [search]));
      root.appendChild(toolbar);
      root.appendChild(total);
      root.appendChild(list);
      container.appendChild(root);

      function renderToolbar() {
        toolbar.innerHTML = '';
        const selCount = filtered.filter((t) => t._sel).length;
        toolbar.appendChild(
          HC.el('label', { class: 'chk' }, [
            (() => {
              const c = HC.el('input', { type: 'checkbox' });
              c.checked = filtered.length > 0 && filtered.every((t) => t._sel);
              c.addEventListener('change', () => {
                filtered.forEach((t) => (t._sel = c.checked));
                renderList();
              });
              return c;
            })(),
            HC.el('span', { text: '全选' }),
          ])
        );
        toolbar.appendChild(HC.el('span', { class: 'counter', text: `已选 ${selCount} / 共 ${filtered.length}` }));
        toolbar.appendChild(HC.el('button', { class: 'btn', text: '关闭选中', onclick: closeSelected }));
        toolbar.appendChild(HC.el('button', { class: 'btn', text: '关闭重复', onclick: closeDuplicates }));
        toolbar.appendChild(HC.el('button', { class: 'btn', text: '按域名关闭', onclick: closeByDomain }));
        toolbar.appendChild(HC.el('button', { class: 'btn', text: '复制网址', onclick: copyUrls }));
        toolbar.appendChild(HC.el('button', { class: 'btn btn-primary', text: '存档会话', onclick: saveSession }));
      }

      function renderList() {
        list.innerHTML = '';
        if (!filtered.length) {
          list.appendChild(HC.el('div', { class: 'empty', text: '没有匹配的标签' }));
          renderToolbar();
          return;
        }
        filtered.forEach((t) => {
          const item = HC.el('label', { class: 'item' + (t._sel ? ' sel' : '') }, [
            (() => {
              const c = HC.el('input', { type: 'checkbox' });
              c.checked = !!t._sel;
              c.addEventListener('change', () => {
                t._sel = c.checked;
                renderList();
              });
              return c;
            })(),
            t.favIconUrl
              ? HC.el('img', { class: 'fav', src: t.favIconUrl, alt: '' })
              : HC.el('span', { class: 'fav fav-empty' }),
            HC.el('div', { class: 'item-main' }, [
              HC.el('div', { class: 'item-title', text: t.title || '(无标题)' }),
              HC.el('a', {
                class: 'item-url',
                href: t.url,
                title: t.url,
                target: '_blank',
                rel: 'noopener',
                text: HC.truncate(t.url, 80),
              }),
            ]),
            HC.el('span', { class: 'tag', text: '窗' + t.windowId }),
          ]);
          list.appendChild(item);
        });
        renderToolbar();
      }

      function applyFilter() {
        const q = (search.value || '').trim().toLowerCase();
        filtered = tabs.filter(
          (t) =>
            !q ||
            (t.title || '').toLowerCase().includes(q) ||
            (t.url || '').toLowerCase().includes(q)
        );
        renderList();
        total.textContent = `共 ${tabs.length} 个标签，当前显示 ${filtered.length} 个`;
      }
      search.addEventListener('input', applyFilter);

      function closeSelected() {
        const ids = filtered.filter((t) => t._sel).map((t) => t.id);
        if (!ids.length) return HC.toast('请先勾选要关闭的标签', 'warn');
        chrome.tabs.remove(ids, () => {
          HC.toast(`已关闭 ${ids.length} 个标签`, 'success');
          load();
        });
      }
      function closeDuplicates() {
        const seen = new Set();
        const dupIds = [];
        filtered.forEach((t) => {
          const k = (t.url || '').trim();
          if (!k) return;
          if (seen.has(k)) dupIds.push(t.id);
          else seen.add(k);
        });
        if (!dupIds.length) return HC.toast('没有重复标签', 'info');
        chrome.tabs.remove(dupIds, () => {
          HC.toast(`已关闭 ${dupIds.length} 个重复标签`, 'success');
          load();
        });
      }
      function closeByDomain() {
        // Chrome 扩展弹窗禁用 window.prompt，改用自定义输入弹窗
        HC.prompt({
          title: '按域名关闭标签',
          body: '输入要关闭的域名（如 github.com）：',
          placeholder: 'example.com',
          okText: '关闭',
        }).then((dom) => {
          if (!dom) return;
          const ids = filtered
            .filter((t) => {
              try {
                return new URL(t.url).hostname.includes(dom.trim());
              } catch {
                return false;
              }
            })
            .map((t) => t.id);
          if (!ids.length) return HC.toast('未找到匹配域名的标签', 'warn');
          HC.confirm({
            title: '确认关闭？',
            body: `将关闭 <b>${ids.length}</b> 个域名包含「${HC.escapeHtml(dom)}」的标签。`,
            danger: true,
          }).then((ok) => {
            if (!ok) return;
            chrome.tabs.remove(ids, () => {
              HC.toast(`已关闭 ${ids.length} 个标签`, 'success');
              load();
            });
          });
        });
      }
      async function copyUrls() {
        const sel = filtered.filter((t) => t._sel);
        const lines = (sel.length ? sel : filtered).map((t) => t.url).join('\n');
        try {
          await navigator.clipboard.writeText(lines);
          HC.toast('已复制网址到剪贴板', 'success');
        } catch {
          HC.toast('复制失败', 'error');
        }
      }
      async function saveSession() {
        const sel = filtered.filter((t) => t._sel);
        const items = (sel.length ? sel : filtered).map((t) => ({ url: t.url, title: t.title }));
        if (!items.length) return HC.toast('没有可存档的标签', 'warn');
        const name = await HC.prompt({
          title: '存档会话',
          body: `将把 <b>${items.length}</b> 个标签存为会话。给这个会话起个名字：`,
          value: '会话 ' + new Date().toLocaleString(),
          okText: '存档',
        });
        if (!name) return;
        const store = await HC.getSessions();
        store.push({ id: Date.now() + '', name, time: Date.now(), tabs: items });
        await HC.setSessions(store);
        HC.toast(`已存档 ${items.length} 个标签`, 'success');
      }

      function load() {
        chrome.tabs.query({}, (ts) => {
          tabs = ts.map((t) => ({
            id: t.id,
            title: t.title,
            url: t.url,
            favIconUrl: t.favIconUrl,
            windowId: t.windowId,
            _sel: false,
          }));
          applyFilter();
        });
      }
      load();
    },
  };
})();
