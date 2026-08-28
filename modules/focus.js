/* -------------------------------------------------------------------------
 * modules/focus.js — 专注模式
 * 设定时长 + 域名黑名单 → 后台在打开黑名单站点时温和提醒并计数。
 * 结束时（chrome.alarms 定时）生成报告：专注 X 分钟，提醒 N 次。
 * 「温和提醒」而非硬拦截，避免与浏览器策略冲突。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  const DEFAULT_BLOCKLIST = ['weibo.com', 'douyin.com', 'bilibili.com', 'zhihu.com', 'tieba.baidu.com', 'xiaohongshu.com'];

  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(resp || { ok: false, error: '空响应' });
      });
    });
  }
  function getFocus() {
    return new Promise((r) => chrome.storage.local.get({ focus: null, focusEvents: [], lastFocusReport: null }, (x) => r(x)));
  }

  HC.modules.focus = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      container.appendChild(root);
      getFocus().then((st) => {
        if (st.focus && st.focus.until > Date.now()) renderRunning(root, st);
        else renderIdle(root, st);
      });
    },
  };

  /* ---------------- 进行中 ---------------- */
  function renderRunning(root, st) {
    root.innerHTML = '';
    const f = st.focus;
    const remainEl = HC.el('div', { class: 'score-num', text: '—' });
    const barFill = HC.el('div', { class: 'bar-fill', style: 'width:0%;background:var(--accent);' });
    const nudgeEl = HC.el('div', { class: 'opt-desc', text: '' });
    const list = HC.el('div', { class: 'list' });

    function tick() {
      /* 视图已切换（弹窗内节点被移除）时自动停止计时器，避免泄漏 */
      if (!root.isConnected) { clearInterval(timer); clearInterval(nudgeTimer); return; }
      const left = f.until - Date.now();
      if (left <= 0) {
        clearInterval(timer);
        HC.toast('专注结束！', 'success');
        HC.modules.focus.render(root.parentNode);
        return;
      }
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      remainEl.textContent = m + ' 分 ' + (s < 10 ? '0' : '') + s + ' 秒';
      const total = f.until - f.start;
      barFill.style.width = Math.min(100, ((total - left) / total) * 100).toFixed(1) + '%';
    }
    const timer = setInterval(tick, 500);
    tick();

    function refreshNudges() {
      getFocus().then((x) => {
        const mine = (x.focusEvents || []).filter((e) => e.t >= f.start);
        nudgeEl.textContent = '已温和提醒 ' + mine.length + ' 次';
        list.innerHTML = '';
        mine.slice(-10).reverse().forEach((e) => {
          list.appendChild(HC.el('div', { class: 'item' }, [
            HC.el('div', { class: 'item-main' }, [
              HC.el('div', { class: 'item-title', text: e.host }),
              HC.el('div', { class: 'item-sub', text: new Date(e.t).toLocaleTimeString('zh-CN') }),
            ]),
          ]));
        });
      });
    }
    refreshNudges();
    const nudgeTimer = setInterval(refreshNudges, 5000);

    root.appendChild(
      HC.el('div', { class: 'row glass', style: 'flex-direction:column;align-items:center;gap:4px;padding:18px;' }, [
        HC.el('div', { class: 'opt-name', text: '🎯 专注中（' + f.minutes + ' 分钟）' }),
        remainEl,
        HC.el('div', { class: 'bar', style: 'width:100%;' }, [barFill]),
        nudgeEl,
      ])
    );
    root.appendChild(HC.el('div', { class: 'section-subtitle', text: '最近提醒（黑名单站点）' }));
    root.appendChild(list);
    root.appendChild(
      HC.el('button', {
        class: 'btn btn-primary',
        text: '结束专注',
        onclick: async () => {
          clearInterval(timer); clearInterval(nudgeTimer);
          try { chrome.alarms.clear('hc-focus-end'); } catch (_) {}
          try { chrome.action.setBadgeText({ text: '' }); } catch (_) {}
          await send('FOCUS_END', {});
          HC.modules.focus.render(root.parentNode);
        },
      })
    );
    root.addEventListener('DOMNodeRemoved', () => { clearInterval(timer); clearInterval(nudgeTimer); });
  }

  /* ---------------- 未开始 ---------------- */
  function renderIdle(root, st) {
    root.innerHTML = '';

    const durSel = HC.el('select', { class: 'input opt-ctrl' });
    [['25', '25 分钟（番茄）'], ['45', '45 分钟'], ['60', '60 分钟'], ['90', '90 分钟']].forEach(([v, l]) =>
      durSel.appendChild(HC.el('option', { value: v, text: l })));

    const ta = HC.el('textarea', {
      class: 'input', rows: '5',
      style: 'width:100%;font-size:12px;line-height:1.6;',
      spellcheck: 'false',
    });
    ta.value = (st.focusBlocklist || DEFAULT_BLOCKLIST).join('\n');

    root.appendChild(
      HC.el('div', { class: 'row glass', style: 'display:block;padding:14px;' }, [
        HC.el('div', { class: 'opt-name', text: '🎯 专注模式' }),
        HC.el('div', { class: 'opt-desc', style: 'margin:4px 0 10px;', text: '专注期间打开黑名单站点时温和提醒（不硬拦截）。结束后生成报告。' }),
        HC.el('div', { class: 'opt-name', style: 'font-size:13px;', text: '专注时长' }),
        durSel,
        HC.el('div', { class: 'opt-name', style: 'font-size:13px;margin-top:10px;', text: '黑名单域名（每行一个）' }),
        ta,
        HC.el('div', { style: 'height:10px;' }),
        HC.el('button', {
          class: 'btn btn-primary',
          text: '开始专注',
          onclick: async () => {
            const minutes = parseInt(durSel.value, 10) || 25;
            const blocklist = ta.value.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
            const start = Date.now();
            const focus = { start, until: start + minutes * 60000, minutes, blocklist };
            await new Promise((r) => chrome.storage.local.set({ focus, focusBlocklist: blocklist }, r));
            try {
              chrome.alarms.create('hc-focus-end', { when: focus.until });
              chrome.action.setBadgeText({ text: String(minutes) });
              chrome.action.setBadgeBackgroundColor({ color: '#4c7bf3' });
            } catch (_) { /* alarms 不可用时仍可用提醒 */ }
            HC.toast('专注开始，加油！', 'success');
            HC.modules.focus.render(root.parentNode);
          },
        }),
      ])
    );

    if (st.lastFocusReport) {
      const r = st.lastFocusReport;
      root.appendChild(HC.el('div', { class: 'section-subtitle', text: '上次报告' }));
      root.appendChild(
        HC.el('div', { class: 'row glass', style: 'display:block;padding:12px;' }, [
          HC.el('div', { class: 'opt-desc', text:
            '专注 ' + r.minutes + ' 分钟 · 温和提醒 ' + (r.nudges || 0) + ' 次 · ' +
            new Date(r.end).toLocaleString('zh-CN') }),
        ])
      );
    }
  }
})();
