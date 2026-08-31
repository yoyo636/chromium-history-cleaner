/* -------------------------------------------------------------------------
 * modules/sessions.js — 会话存档：最近关闭恢复 + 自定义会话存档/恢复/删除
 * 最近关闭走 chrome.sessions.*；自定义会话存于 chrome.storage.local。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  HC.modules.sessions = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      const rcWrap = HC.el('div', { class: 'block glass' });
      const svWrap = HC.el('div', { class: 'block glass' });

      root.appendChild(HC.el('div', { class: 'section-title', text: '最近关闭' }));
      root.appendChild(rcWrap);
      root.appendChild(HC.el('div', { class: 'section-title', text: '已存档会话' }));
      root.appendChild(svWrap);
      container.appendChild(root);

      const rerender = () => {
        container.innerHTML = '';
        HC.modules.sessions.render(container);
      };

      // 最近关闭
      chrome.sessions.getRecentlyClosed((rc) => {
        rcWrap.innerHTML = '';
        if (!rc || !rc.length)
          rcWrap.appendChild(HC.el('div', { class: 'empty', text: '没有最近关闭的记录' }));
        (rc || []).forEach((s) => {
          const label = s.tab
            ? s.tab.title || s.tab.url || '标签页'
            : s.window
            ? `${s.window.tabs.length} 个标签页的窗口`
            : '会话';
          const item = HC.el('div', { class: 'item' }, [
            HC.el('div', { class: 'item-main' }, [HC.el('div', { class: 'item-title', text: label })]),
            HC.el('button', {
              class: 'mini',
              text: '恢复',
              onclick: () => {
                chrome.sessions.restore(s.sessionId);
                HC.toast('已恢复', 'success');
              },
            }),
          ]);
          rcWrap.appendChild(item);
        });
      });

      // 已存档会话
      HC.getSessions().then((store) => {
        svWrap.innerHTML = '';
        if (!store || !store.length)
          svWrap.appendChild(
            HC.el('div', { class: 'empty', text: '还没有存档。可在「标签」里点「存档会话」。' })
          );
        (store || []).forEach((s) => {
          const item = HC.el('div', { class: 'item' }, [
            HC.el('div', { class: 'item-main' }, [
              HC.el('div', { class: 'item-title', text: s.name }),
              HC.el('div', { class: 'item-sub', text: `${s.tabs.length} 个标签 · ${HC.formatTime(s.time)}` }),
            ]),
            HC.el('div', { class: 'item-acts' }, [
              HC.el('button', { class: 'mini', text: '恢复', onclick: () => restoreSaved(s) }),
              HC.el('button', {
                class: 'mini danger',
                text: '删除',
                onclick: () => delSaved(s, store),
              }),
            ]),
          ]);
          svWrap.appendChild(item);
        });
      });

      function restoreSaved(s) {
        const urls = (s.tabs || []).map((t) => t.url).filter(Boolean);
        if (!urls.length) return HC.toast('该会话没有有效网址', 'warn');
        chrome.windows.create({ url: urls }, () => HC.toast(`已恢复 ${urls.length} 个标签`, 'success'));
      }
      function delSaved(s, store) {
        HC.confirm({
          title: '删除存档？',
          body: `将删除会话「${s.name}」。`,
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          HC.setSessions(store.filter((x) => x.id !== s.id)).then(() => {
            HC.toast('已删除', 'success');
            rerender();
          });
        });
      }
    },
  };
})();
