/* -------------------------------------------------------------------------
 * modules/bookmarks.js — 书签工具：去重 / 死链检测 / 导出 / 删除
 * 死链检测走 background.js 的 CHECK_LINKS（no-cors 探测，无需额外主机权限）。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;
  let all = [];
  let filtered = [];
  let mode = 'all'; // all | dup
  let refs = null;

  function flatten(nodes) {
    const out = [];
    (nodes || []).forEach((n) => {
      if (n.url) out.push({ id: n.id, title: n.title, url: n.url });
      if (n.children) out.push(...flatten(n.children));
    });
    return out;
  }
  function norm(u) {
    try {
      const u2 = new URL(u);
      return u2.host + u2.pathname.replace(/\/$/, '');
    } catch {
      return (u || '').trim().toLowerCase();
    }
  }

  function renderList() {
    if (!refs) return;
    const { toolbar, total, list } = refs;
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
    toolbar.appendChild(HC.el('button', { class: 'btn', text: '检测死链', onclick: checkDead }));
    toolbar.appendChild(HC.el('button', { class: 'btn', text: '导出JSON', onclick: () => exportBM('json') }));
    toolbar.appendChild(HC.el('button', { class: 'btn', text: '导出HTML', onclick: () => exportBM('html') }));
    toolbar.appendChild(HC.el('button', { class: 'btn btn-danger', text: '删除选中', onclick: delSel }));

    if (!filtered.length) {
      list.appendChild(HC.el('div', { class: 'empty', text: mode === 'dup' ? '没有重复书签' : '没有书签' }));
      total.textContent = `共 ${all.length} 个书签`;
      return;
    }
    filtered.forEach((x) => {
      const tags = [];
      if (x._dead) tags.push(HC.el('span', { class: 'tag', text: '死链', style: 'color:#e5484d' }));
      else if (x._dup) tags.push(HC.el('span', { class: 'tag', text: '重复' }));
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
        tags.length ? HC.el('span', { class: 'item-acts' }, tags) : null,
      ]);
      list.appendChild(item);
    });
    total.textContent = `共 ${all.length} 个书签，当前显示 ${filtered.length} 个`;
  }

  function apply() {
    const q = (refs.filter.value || '').trim().toLowerCase();
    let base = all;
    if (mode === 'dup') {
      const cnt = {};
      base.forEach((x) => {
        const k = norm(x.url);
        cnt[k] = (cnt[k] || 0) + 1;
      });
      base.forEach((x) => (x._dup = cnt[norm(x.url)] > 1));
      base = base.filter((x) => x._dup);
    } else {
      base.forEach((x) => (x._dup = false));
    }
    filtered = base.filter(
      (x) => !q || (x.title || '').toLowerCase().includes(q) || (x.url || '').toLowerCase().includes(q)
    );
    renderList();
  }

  async function checkDead() {
    const urls = [...new Set(filtered.map((x) => x.url))];
    if (!urls.length) return HC.toast('没有可检测的书签', 'warn');
    HC.toast('正在检测死链…');
    try {
      const res = await HC.callBackground('CHECK_LINKS', { urls });
      const map = {};
      res.forEach((r) => (map[r.url] = r.ok));
      filtered.forEach((x) => (x._dead = map[x.url] === false));
      HC.toast(`检测完成，发现 ${filtered.filter((x) => x._dead).length} 个疑似死链`, 'success');
      renderList();
    } catch (e) {
      HC.toast('检测失败：' + e.message, 'error');
    }
  }

  function delSel() {
    const sel = filtered.filter((x) => x._sel);
    if (!sel.length) return HC.toast('请先勾选', 'warn');
    HC.confirm({
      title: '删除选中的书签？',
      bodyHtml: `将删除 <b>${sel.length}</b> 个书签，此操作<b>不可恢复</b>。`,
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      Promise.all(sel.map((x) => new Promise((r) => chrome.bookmarks.remove(x.id, r))))
        .then(() => {
          HC.toast(`已删除 ${sel.length} 个书签`, 'success');
          load();
        })
        .catch((e) => HC.toast('删除失败：' + e.message, 'error'));
    });
  }

  function exportBM(kind) {
    const data = filtered.length ? filtered : all;
    if (!data.length) return HC.toast('没有书签', 'warn');
    let content, name, mime;
    if (kind === 'json') {
      content = JSON.stringify(data.map((x) => ({ title: x.title, url: x.url })), null, 2);
      mime = 'application/json';
      name = 'bookmarks.json';
    } else {
      let s =
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<H1>Bookmarks</H1>\n<DL><p>\n';
      data.forEach((x) => {
        s += `    <DT><A HREF="${HC.escapeHtml(x.url)}">${HC.escapeHtml(x.title || x.url)}</A>\n`;
      });
      s += '</DL><p>\n';
      content = s;
      mime = 'text/html';
      name = 'bookmarks.html';
    }
    const url = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(content);
    chrome.downloads.download({ url, filename: name, saveAs: true }, () => HC.toast('已导出 ' + name));
  }

  function load() {
    chrome.bookmarks.getTree((t) => {
      all = flatten(t);
      filtered = [];
      apply();
    });
  }

  HC.modules.bookmarks = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      const filter = HC.el('input', { class: 'input', type: 'search', placeholder: '按标题或网址过滤…' });

      function segBtn(label, m) {
        const b = HC.el('button', { class: 'seg-btn' + (mode === m ? ' active' : ''), text: label, dataset: { m } });
        b.addEventListener('click', () => {
          mode = m;
          root.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.m === m));
          apply();
        });
        return b;
      }

      const toolbar = HC.el('div', { class: 'toolbar' });
      const total = HC.el('div', { class: 'total' });
      const list = HC.el('div', { class: 'list' });
      refs = { root, filter, toolbar, total, list };

      root.appendChild(HC.el('div', { class: 'row glass' }, [filter]));
      root.appendChild(HC.el('div', { class: 'row glass' }, [HC.el('div', { class: 'seg' }, [segBtn('全部', 'all'), segBtn('仅重复', 'dup')])]));
      root.appendChild(toolbar);
      root.appendChild(total);
      root.appendChild(list);
      container.appendChild(root);

      filter.addEventListener('input', apply);
      load();
    },
  };
})();
