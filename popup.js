/* -------------------------------------------------------------------------
 * popup.js — 核心：命名空间、共享工具、顶部导航、概览仪表盘
 * 各功能模块在 modules/*.js 中向 window.HC.modules 注册，本文件负责调度。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = (window.HC = window.HC || {});
  HC.modules = HC.modules || {};

  /* ============================ 浏览器品牌检测 ============================ */
  HC.detectBrowser = function () {
    const ua = navigator.userAgent;
    const map = [
      [/Edg\//, 'Microsoft Edge'],
      [/OPR\//, 'Opera'],
      [/Brave\//, 'Brave'],
      [/Vivaldi\//, 'Vivaldi'],
      [/YaBrowser\//, 'Yandex'],
      [/Chrome\//, 'Google Chrome'],
      [/HeadlessChrome/, 'Chromium'],
    ];
    for (const [re, name] of map) if (re.test(ua)) return name;
    return 'Chromium 浏览器';
  };

  /* ============================ DOM 工具 ============================ */
  HC.el = function (tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === 'class') node.className = props[k];
        else if (k === 'html') node.innerHTML = props[k];
        else if (k === 'text') node.textContent = props[k];
        else if (k === 'style') node.setAttribute('style', props[k]);
        else if (k.startsWith('on') && typeof props[k] === 'function')
          node.addEventListener(k.slice(2), props[k]);
        else if (k === 'dataset') Object.assign(node.dataset, props[k]);
        else node.setAttribute(k, props[k]);
      }
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  };

  HC.escapeHtml = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  HC.formatTime = function (ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  HC.formatBytes = function (n) {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  };

  HC.truncate = function (s, n) {
    s = s || '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  /* ============================ 后台消息 ============================ */
  HC.callBackground = function (type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload: payload || {} }, (resp) => {
        if (chrome.runtime.lastError)
          return reject(new Error(chrome.runtime.lastError.message));
        if (resp && resp.ok) return resolve(resp.data);
        reject(new Error((resp && resp.error) || '未知错误'));
      });
    });
  };

  /* ============================ 会话存档（storage） ============================ */
  HC.getSessions = function () {
    return new Promise((res) =>
      chrome.storage.local.get({ sessions: [] }, (r) => res(r.sessions || []))
    );
  };
  HC.setSessions = function (s) {
    return new Promise((res) => chrome.storage.local.set({ sessions: s }, res));
  };

  /* ============================ Toast ============================ */
  HC.toast = function (msg, type) {
    const wrap = document.getElementById('toastWrap');
    const t = HC.el('div', { class: 'toast toast-' + (type || 'info'), text: msg });
    wrap.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 2600);
  };

  /* ============================ 确认弹窗 ============================ */
  HC.confirm = function ({ title, body, danger }) {
    return new Promise((resolve) => {
      const mask = document.getElementById('modalMask');
      const t = document.getElementById('modalTitle');
      const b = document.getElementById('modalBody');
      const ok = document.getElementById('modalOk');
      const cancel = document.getElementById('modalCancel');
      t.textContent = title || '确认操作';
      b.innerHTML = body || '';
      ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
      mask.hidden = false;
      const done = (val) => {
        mask.hidden = true;
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        resolve(val);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
    });
  };

  /* ============================ 导航调度 ============================ */
  function switchView(name) {
    const mod = HC.modules[name];
    const content = document.getElementById('content');
    content.innerHTML = '';
    document.querySelectorAll('.nav-item').forEach((b) =>
      b.classList.toggle('active', b.dataset.view === name)
    );
    if (mod && typeof mod.render === 'function') {
      try {
        mod.render(content);
      } catch (e) {
        content.appendChild(
          HC.el('div', { class: 'empty', text: '加载失败：' + e.message })
        );
        console.error(e);
      }
    } else {
      content.appendChild(HC.el('div', { class: 'empty', text: '功能即将上线' }));
    }
    content.scrollTop = 0;
  }

  /* ============================ 概览仪表盘 ============================ */
  HC.modules.home = {
    render(container) {
      const wrap = HC.el('div', { class: 'home' });

      const stats = HC.el('div', { class: 'stat-grid' });
      wrap.appendChild(stats);

      const defs = [
        ['history', '历史清理', '按时间段查询与删除'],
        ['tabs', '标签管理', '批量关闭、去重、存档'],
        ['bookmarks', '书签工具', '去重、死链、导出'],
        ['downloads', '下载管理', '查看、打开、清理'],
        ['cleanup', '数据清理', '一键清理缓存痕迹'],
        ['sessions', '会话存档', '恢复关闭的页面'],
      ];
      const shortcuts = HC.el('div', { class: 'shortcut-grid' });
      defs.forEach(([v, t, d]) =>
        shortcuts.appendChild(
          HC.el('button', { class: 'shortcut glass', onclick: () => switchView(v) }, [
            HC.el('div', { class: 'shortcut-title', text: t }),
            HC.el('div', { class: 'shortcut-desc', text: d }),
          ])
        )
      );
      wrap.appendChild(HC.el('div', { class: 'section-title', text: '快捷入口' }));
      wrap.appendChild(shortcuts);
      container.appendChild(wrap);

      // 异步填充统计卡片
      const mk = (label) => {
        const card = HC.el('div', { class: 'stat glass' }, [
          HC.el('div', { class: 'stat-value', text: '…' }),
          HC.el('div', { class: 'stat-label', text: label }),
        ]);
        stats.appendChild(card);
        return card.querySelector('.stat-value');
      };
      const vTabs = mk('打开的标签页');
      const vBm = mk('书签总数');
      const vDl = mk('近 30 天下载');
      const vHis = mk('近 7 天历史');

      chrome.tabs.query({}, (tabs) => (vTabs.textContent = tabs.length));
      chrome.bookmarks.getTree((tree) => {
        let n = 0;
        const walk = (nodes) =>
          (nodes || []).forEach((x) => {
            if (x.url) n++;
            if (x.children) walk(x.children);
          });
        walk(tree);
        vBm.textContent = n;
      });
      chrome.downloads.search({ limit: 1000, orderBy: ['-startTime'] }, (items) => {
        const cut = Date.now() - 30 * 86400000;
        vDl.textContent = items.filter(
          (i) => i.startTime && new Date(i.startTime).getTime() > cut
        ).length;
      });
      HC.callBackground('SEARCH', {
        startTime: Date.now() - 7 * 86400000,
        endTime: Date.now(),
      })
        .then((list) => (vHis.textContent = list.length))
        .catch(() => (vHis.textContent = '—'));
    },
  };

  /* ============================ 启动 ============================ */
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('brandSub').textContent = HC.detectBrowser();
    document.getElementById('nav').addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-item');
      if (btn) switchView(btn.dataset.view);
    });
    switchView('home');
  });
})();
