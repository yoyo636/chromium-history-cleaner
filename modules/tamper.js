/* -------------------------------------------------------------------------
 * modules/tamper.js — 开发者模式 · 篡改
 * 需在「偏好设置」中开启开发者模式（密码校验在 background）。
 * 页签：历史 / 书签 / 下载 / Cookie
 * - 历史：新增（可指定次数）/ 删除单条 / 按域名删 / 保留最近 N 天 / 清空
 * - 书签：完全增删改（标题 / URL）
 * - 下载：删除单条记录 / 清空
 * - Cookie：改值 / 删除 / 新增
 * 「自动执行」开启后操作不再弹确认框。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(resp || { ok: false, error: '空响应' });
      });
    });
  }

  let autoExec = false;
  let activeTab = 'history';

  async function maybeConfirm(body) {
    if (autoExec) return true;
    const r = await HC.confirm({ title: '篡改操作确认', body, danger: true });
    return r !== false;
  }

  HC.modules.tamper = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      container.appendChild(root);
      chrome.storage.local.get({ devMode: false, tamperAuto: false }, (r) => {
        autoExec = !!r.tamperAuto;
        if (r.devMode) renderPanel(root);
        else renderLock(root);
      });
    },
  };

  /* ---------------- 锁屏：未开启开发者模式 ---------------- */
  function renderLock(root) {
    root.innerHTML = '';
    const pass = HC.el('input', { class: 'input', type: 'password', placeholder: '输入开发者密码' });
    const btn = HC.el('button', {
      class: 'btn btn-primary',
      text: '🔓 启用篡改功能',
      onclick: async () => {
        const resp = await send('TAMPER_SET_DEV', { on: true, pass: pass.value });
        if (resp.ok) {
          HC.toast('开发者模式已开启', 'success');
          renderPanel(root);
        } else {
          HC.toast(resp.error || '密码错误', 'error');
        }
      },
    });
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
    root.appendChild(
      HC.el('div', { class: 'row glass', style: 'display:block;padding:16px;' }, [
        HC.el('div', { class: 'opt-name', text: '🔒 开发者模式未开启' }),
        HC.el('div', {
          class: 'opt-desc',
          style: 'margin:6px 0 12px;',
          text: '篡改功能可修改浏览器内部数据（历史 / 书签 / 下载 / Cookie）。输入密码启用；再次输入相同密码即可关闭。',
        }),
        pass,
        HC.el('div', { style: 'height:10px;' }),
        btn,
      ])
    );
  }

  /* ---------------- 主面板 ---------------- */
  function renderPanel(root) {
    root.innerHTML = '';
    const autoChk = HC.el('input', { type: 'checkbox' });
    autoChk.checked = autoExec;
    autoChk.addEventListener('change', () => {
      autoExec = autoChk.checked;
      chrome.storage.local.set({ tamperAuto: autoExec });
      HC.toast(autoExec ? '自动执行：操作不再确认' : '自动执行：已恢复确认');
    });
    const closeBtn = HC.el('button', {
      class: 'mini danger',
      text: '关闭开发者模式',
      onclick: async () => {
        const pass = await HC.prompt({ title: '关闭开发者模式', body: '再次输入相同密码即可关闭', placeholder: '密码' });
        if (pass == null || !pass) return;
        const resp = await send('TAMPER_SET_DEV', { on: false, pass });
        if (resp.ok) {
          HC.toast('开发者模式已关闭', 'success');
          renderLock(root);
        } else HC.toast(resp.error || '密码错误', 'error');
      },
    });

    const tabbar = HC.el('div', { class: 'tamper-tabs' });
    const body = HC.el('div');
    const tabs = [
      ['history', '历史'],
      ['bookmarks', '书签'],
      ['downloads', '下载'],
      ['cookies', 'Cookie'],
    ];
    tabs.forEach(([id, label]) => {
      const b = HC.el('button', { class: 'tamper-tab', text: label });
      b.addEventListener('click', () => {
        activeTab = id;
        tabbar.querySelectorAll('.tamper-tab').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        renderTab(body);
      });
      if (id === activeTab) b.classList.add('active');
      tabbar.appendChild(b);
    });

    root.appendChild(
      HC.el('div', { class: 'row glass', style: 'justify-content:space-between;' }, [
        HC.el('span', { class: 'counter', text: '⚡ 开发者模式已开启' }),
        HC.el('span', { style: 'display:flex;gap:10px;align-items:center;' }, [
          HC.el('label', { class: 'chk' }, [autoChk, HC.el('span', { text: '自动执行' })]),
          closeBtn,
        ]),
      ])
    );
    root.appendChild(tabbar);
    root.appendChild(body);
    renderTab(body);
  }

  function renderTab(body) {
    body.innerHTML = '';
    if (activeTab === 'history') renderHistory(body);
    else if (activeTab === 'bookmarks') renderBookmarks(body);
    else if (activeTab === 'downloads') renderDownloads(body);
    else renderCookies(body);
  }

  /* ---------------- 历史 ---------------- */
  function renderHistory(root) {
    const list = HC.el('div', { class: 'list' });
    const total = HC.el('div', { class: 'total' });
    const addUrl = HC.el('input', { class: 'input', placeholder: '要伪造访问的网址，如 https://example.com/page' });
    const addCnt = HC.el('input', { class: 'input', type: 'number', min: '1', max: '50', value: '1', style: 'width:70px;flex:none;' });
    const domIn = HC.el('input', { class: 'input', placeholder: '按域名删除，如 jd.com' });
    const keepDays = HC.el('input', { class: 'input', type: 'number', min: '0', value: '7', style: 'width:70px;flex:none;' });

    async function op(opName, args, body) {
      if (!(await maybeConfirm(body))) return null;
      const resp = await send('TAMPER_OP', { op: opName, args });
      if (resp.ok) return resp.data;
      HC.toast(resp.error || '操作失败', 'error');
      return null;
    }

    const toolbar = HC.el('div', { class: 'tamper-form' }, [
      addUrl, addCnt,
      HC.el('button', {
        class: 'mini', text: '伪造访问',
        onclick: async () => {
          if (!addUrl.value.trim()) return HC.toast('请输入网址', 'error');
          const r = await op('history_add', { url: addUrl.value.trim(), count: addCnt.value },
            '将向历史记录添加：' + addUrl.value.trim() + '（' + addCnt.value + ' 次，时间为现在）');
          if (r) { HC.toast('已添加 ' + r.added + ' 条访问', 'success'); load(); }
        },
      }),
    ]);
    const toolbar2 = HC.el('div', { class: 'tamper-form' }, [
      domIn,
      HC.el('button', {
        class: 'mini danger', text: '删该域名',
        onclick: async () => {
          if (!domIn.value.trim()) return HC.toast('请输入域名', 'error');
          const r = await op('history_delete_domain', { domain: domIn.value.trim() },
            '删除域名 ' + domIn.value.trim() + ' 的全部历史记录？');
          if (r) { HC.toast('已删除 ' + r.deleted + ' 条', 'success'); load(); }
        },
      }),
      keepDays,
      HC.el('button', {
        class: 'mini danger', text: '删更早',
        onclick: async () => {
          const r = await op('history_delete_range', { days: keepDays.value },
            '删除 ' + keepDays.value + ' 天之前的全部历史（保留最近 ' + keepDays.value + ' 天）？');
          if (r) { HC.toast('已完成', 'success'); load(); }
        },
      }),
      HC.el('button', {
        class: 'mini danger', text: '清空全部',
        onclick: async () => {
          const r = await op('history_delete_all', {}, '确定清空全部历史记录？此操作不可恢复！');
          if (r) { HC.toast('已清空', 'success'); load(); }
        },
      }),
    ]);

    function load() {
      send('TAMPER_LIST', { kind: 'history' }).then((resp) => {
        list.innerHTML = '';
        if (!resp.ok) {
          total.textContent = resp.error || '加载失败';
          return;
        }
        const items = resp.data || [];
        total.textContent = `共 ${items.length} 条（近 90 天）· 伪造的访问时间为「现在」，无法回溯日期`;
        if (!items.length) {
          list.appendChild(HC.el('div', { class: 'empty', text: '没有历史记录' }));
          return;
        }
        items.forEach((x) => {
          list.appendChild(
            HC.el('div', { class: 'item' }, [
              HC.el('div', { class: 'item-main' }, [
                HC.el('div', { class: 'item-title', text: x.title || '(无标题)' }),
                HC.el('div', { class: 'item-url', text: HC.truncate(x.url, 80), title: x.url }),
                HC.el('div', { class: 'item-sub', text: `${x.visitCount || 1} 次 · ${HC.formatTime(x.lastVisitTime)}` }),
              ]),
              HC.el('div', { class: 'item-acts' }, [
                HC.el('button', {
                  class: 'mini danger', text: '删除',
                  onclick: async () => {
                    const r = await op('history_delete', { url: x.url }, '删除这条历史记录？\n' + x.url);
                    if (r) { HC.toast('已删除'); load(); }
                  },
                }),
              ]),
            ])
          );
        });
      });
    }
    load();
    root.appendChild(toolbar);
    root.appendChild(toolbar2);
    root.appendChild(total);
    root.appendChild(list);
  }

  /* ---------------- 书签 ---------------- */
  function renderBookmarks(root) {
    const list = HC.el('div', { class: 'list' });
    const total = HC.el('div', { class: 'total' });
    const newTitle = HC.el('input', { class: 'input', placeholder: '新书签标题' });
    const newUrl = HC.el('input', { class: 'input', placeholder: 'https://…' });

    async function op(opName, args, body) {
      if (body && !(await maybeConfirm(body))) return null;
      const resp = await send('TAMPER_OP', { op: opName, args });
      if (!resp.ok) { HC.toast(resp.error || '操作失败', 'error'); return null; }
      return resp.data;
    }

    root.appendChild(
      HC.el('div', { class: 'tamper-form' }, [
        newTitle, newUrl,
        HC.el('button', {
          class: 'mini', text: '新增书签',
          onclick: async () => {
            if (!newUrl.value.trim()) return HC.toast('请输入网址', 'error');
            const r = await op('bookmark_create', { title: newTitle.value.trim() || '未命名', url: newUrl.value.trim() });
            if (r) { HC.toast('已新增书签', 'success'); load(); }
          },
        }),
      ])
    );

    function load() {
      send('TAMPER_LIST', { kind: 'bookmarks' }).then((resp) => {
        list.innerHTML = '';
        if (!resp.ok) { total.textContent = resp.error || '加载失败'; return; }
        const items = resp.data || [];
        total.textContent = `共 ${items.length} 个书签 · 标题与网址均可直接修改后保存`;
        if (!items.length) {
          list.appendChild(HC.el('div', { class: 'empty', text: '没有书签' }));
          return;
        }
        items.forEach((x) => {
          const tIn = HC.el('input', { class: 'input', value: x.title, style: 'margin-bottom:4px;' });
          const uIn = HC.el('input', { class: 'input', value: x.url, style: 'font-size:11px;' });
          list.appendChild(
            HC.el('div', { class: 'item' }, [
              HC.el('div', { class: 'item-main', style: 'flex:1;min-width:0;' }, [
                tIn, uIn,
                HC.el('div', { class: 'item-sub', text: x.path || '' }),
              ]),
              HC.el('div', { class: 'item-acts' }, [
                HC.el('button', {
                  class: 'mini', text: '保存',
                  onclick: async () => {
                    const r = await op('bookmark_save', { id: x.id, title: tIn.value, url: uIn.value });
                    if (r) HC.toast('已保存', 'success');
                  },
                }),
                HC.el('button', {
                  class: 'mini danger', text: '删除',
                  onclick: async () => {
                    const r = await op('bookmark_delete', { id: x.id }, '删除书签「' + x.title + '」？');
                    if (r) { HC.toast('已删除'); load(); }
                  },
                }),
              ]),
            ])
          );
        });
      });
    }
    load();
    root.appendChild(total);
    root.appendChild(list);
  }

  /* ---------------- 下载 ---------------- */
  function renderDownloads(root) {
    const list = HC.el('div', { class: 'list' });
    const total = HC.el('div', { class: 'total' });

    async function op(opName, args, body) {
      if (body && !(await maybeConfirm(body))) return null;
      const resp = await send('TAMPER_OP', { op: opName, args });
      if (!resp.ok) { HC.toast(resp.error || '操作失败', 'error'); return null; }
      return resp.data;
    }

    root.appendChild(
      HC.el('div', { class: 'tamper-form' }, [
        HC.el('span', { class: 'counter', text: '仅删除下载「记录」，不删除磁盘文件' }),
        HC.el('button', {
          class: 'mini danger', text: '清空全部记录',
          onclick: async () => {
            const r = await op('downloads_erase', { all: true }, '确定清空全部下载记录？（不删除文件本身）');
            if (r) { HC.toast('已清除 ' + r.erased + ' 条', 'success'); load(); }
          },
        }),
      ])
    );

    function load() {
      send('TAMPER_LIST', { kind: 'downloads' }).then((resp) => {
        list.innerHTML = '';
        if (!resp.ok) { total.textContent = resp.error || '加载失败'; return; }
        const items = resp.data || [];
        total.textContent = `共 ${items.length} 条下载记录`;
        if (!items.length) {
          list.appendChild(HC.el('div', { class: 'empty', text: '没有下载记录' }));
          return;
        }
        items.forEach((x) => {
          list.appendChild(
            HC.el('div', { class: 'item' }, [
              HC.el('div', { class: 'item-main' }, [
                HC.el('div', { class: 'item-title', text: (x.filename || '').split('/').pop() || '(未知文件)' }),
                HC.el('div', { class: 'item-url', text: HC.truncate(x.url, 80), title: x.url }),
              ]),
              HC.el('div', { class: 'item-acts' }, [
                HC.el('button', {
                  class: 'mini danger', text: '删除记录',
                  onclick: async () => {
                    const r = await op('downloads_erase', { id: x.id }, '删除这条下载记录？');
                    if (r) { HC.toast('已删除'); load(); }
                  },
                }),
              ]),
            ])
          );
        });
      });
    }
    load();
    root.appendChild(total);
    root.appendChild(list);
  }

  /* ---------------- Cookie ---------------- */
  function renderCookies(root) {
    const list = HC.el('div', { class: 'list' });
    const total = HC.el('div', { class: 'total' });
    const q = HC.el('input', { class: 'input', type: 'search', placeholder: '按域名 / 名称过滤…' });
    const cUrl = HC.el('input', { class: 'input', placeholder: '作用网址，如 https://example.com' });
    const cName = HC.el('input', { class: 'input', placeholder: 'Cookie 名', style: 'width:110px;flex:none;' });
    const cVal = HC.el('input', { class: 'input', placeholder: '值', style: 'width:110px;flex:none;' });

    let items = [];
    let filtered = [];

    async function op(opName, args, body) {
      if (body && !(await maybeConfirm(body))) return null;
      const resp = await send('TAMPER_OP', { op: opName, args });
      if (!resp.ok) { HC.toast(resp.error || '操作失败', 'error'); return null; }
      return resp.data;
    }

    function apply() {
      const kw = (q.value || '').trim().toLowerCase();
      filtered = items.filter(
        (c) => !kw || c.domain.toLowerCase().includes(kw) || c.name.toLowerCase().includes(kw)
      );
      render();
    }
    q.addEventListener('input', apply);

    function render() {
      list.innerHTML = '';
      total.textContent = `共 ${items.length} 条 Cookie，当前显示 ${filtered.length} 条`;
      if (!filtered.length) {
        list.appendChild(HC.el('div', { class: 'empty', text: '没有 Cookie' }));
        return;
      }
      filtered.slice(0, 200).forEach((c) => {
        const key = c.domain + '|' + c.name;
        list.appendChild(
          HC.el('div', { class: 'item' }, [
            HC.el('div', { class: 'item-main' }, [
              HC.el('div', { class: 'item-title', text: c.name }),
              HC.el('div', { class: 'item-url', text: HC.truncate(c.domain + c.path, 60) }),
              HC.el('div', { class: 'item-sub', text: '值: ' + HC.truncate(c.value || '(空)', 50) }),
            ]),
            HC.el('div', { class: 'item-acts' }, [
              HC.el('button', {
                class: 'mini', text: '改值',
                onclick: async () => {
                  const v = await HC.prompt({ title: '修改 Cookie 值', body: c.name + ' @ ' + c.domain, value: c.value || '' });
                  if (v == null) return;
                  const r = await op('cookie_set', { url: 'https://' + c.domain.replace(/^\./, '') + c.path, name: c.name, value: v });
                  if (r) { HC.toast('已修改', 'success'); load(); }
                },
              }),
              HC.el('button', {
                class: 'mini danger', text: '删除',
                onclick: async () => {
                  const r = await op('cookie_remove', { url: 'https://' + c.domain.replace(/^\./, '') + c.path, name: c.name },
                    '删除 Cookie ' + c.name + '（' + c.domain + '）？');
                  if (r) { HC.toast('已删除'); load(); }
                },
              }),
            ]),
          ])
        );
      });
    }

    function load() {
      send('TAMPER_LIST', { kind: 'cookies' }).then((resp) => {
        if (!resp.ok) { items = []; total.textContent = resp.error || '加载失败'; render(); return; }
        items = resp.data || [];
        apply();
      });
    }

    root.appendChild(q);
    root.appendChild(
      HC.el('div', { class: 'tamper-form' }, [
        cUrl, cName, cVal,
        HC.el('button', {
          class: 'mini', text: '新增/覆盖',
          onclick: async () => {
            if (!cUrl.value.trim() || !cName.value.trim()) return HC.toast('请输入作用网址和 Cookie 名', 'error');
            const r = await op('cookie_set', { url: cUrl.value.trim(), name: cName.value.trim(), value: cVal.value });
            if (r) { HC.toast('已写入', 'success'); load(); }
          },
        }),
      ])
    );
    root.appendChild(total);
    root.appendChild(list);
    load();
  }
})();
