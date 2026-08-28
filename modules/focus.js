/* -------------------------------------------------------------------------
 * modules/focus.js — 专注模式 v2
 * 后台负责：注意力状态机（忍住/破戒判定）、自适应提醒、威胁评分、
 *           番茄周期排程、报告历史。本模块负责 UI。
 * 数据流：
 *   FOCUS_START {minutes, blocklist, pomodoro}  开始
 *   FOCUS_STATE                                 轮询（含实时计数 + 建议时长）
 *   FOCUS_THREATS                               威胁评分 Top12（一键加黑名单）
 *   FOCUS_END                                   手动结束
 *   storage: focusReports / focusStats / focusBlocklist 直读展示
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  const DEFAULT_BLOCKLIST = ['weibo.com', 'douyin.com', 'bilibili.com', 'zhihu.com', 'tieba.baidu.com', 'xiaohongshu.com'];

  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload: payload || {} }, (resp) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(resp || { ok: false, error: '空响应' });
      });
    });
  }
  function getStorage(keys) {
    return new Promise((r) => chrome.storage.local.get(keys, (x) => r(x)));
  }

  HC.modules.focus = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      container.appendChild(root);
      send('FOCUS_STATE').then((st) => {
        if (st.ok && st.data && st.data.active) renderRunning(root, st.data);
        else renderIdle(root, st.data || {});
      });
    },
  };

  /* ================= 进行中 ================= */
  function renderRunning(root, st) {
    root.innerHTML = '';
    const remainEl = HC.el('div', { class: 'score-num', text: '—' });
    const barFill = HC.el('div', { class: 'bar-fill', style: 'width:0%;background:var(--accent);' });
    const statEl = HC.el('div', { class: 'opt-desc', style: 'margin-top:6px;', text: '' });
    const list = HC.el('div', { class: 'list' });

    function fmt(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      return Math.floor(s / 60) + ' 分 ' + (s % 60 < 10 ? '0' : '') + (s % 60) + ' 秒';
    }
    function statText() {
      return `🎯 提醒 ${st.nudges} · 💪 忍住 ${st.resisted} · ❌ 破戒 ${st.broken}`;
    }
    statEl.textContent = statText();

    function tick() {
      if (!root.isConnected) { clearInterval(timer); clearInterval(pollTimer); return; }
      send('FOCUS_STATE').then((s2) => {
        if (!s2.ok || !s2.data || !s2.data.active) {
          clearInterval(timer); clearInterval(pollTimer);
          HC.toast('专注结束', 'success');
          HC.modules.focus.render(root.parentNode);
          return;
        }
        st = s2.data;
        remainEl.textContent = fmt(st.timeLeftMs);
        const total = st.focus.until - st.focus.start;
        barFill.style.width = Math.min(100, ((total - st.timeLeftMs) / total) * 100).toFixed(1) + '%';
        statEl.textContent = statText();
        renderRecent(st.recent || []);
      });
    }
    tick();
    const timer = setInterval(tick, 1000);
    const pollTimer = setInterval(tick, 5000);

    function renderRecent(recent) {
      list.innerHTML = '';
      if (!recent.length) {
        list.appendChild(HC.el('div', { class: 'empty', text: '暂无事件 —— 保持住！' }));
        return;
      }
      recent.forEach((e) => {
        const icon = e.kind === 'resist' ? '💪' : e.kind === 'broke' ? '❌' : '🔔';
        const label = e.kind === 'resist' ? '忍住' : e.kind === 'broke' ? '破戒' : '提醒';
        list.appendChild(HC.el('div', { class: 'item' }, [
          HC.el('div', { class: 'item-main' }, [
            HC.el('div', { class: 'item-title', text: icon + ' ' + label + ' · ' + e.host }),
            HC.el('div', { class: 'item-sub', text: new Date(e.t).toLocaleTimeString('zh-CN') + (e.dwellMs ? ' · 停留 ' + Math.round(e.dwellMs / 1000) + 's' : '') }),
          ]),
        ]));
      });
    }
    renderRecent(st.recent || []);

    root.appendChild(
      HC.el('div', { class: 'row glass', style: 'flex-direction:column;align-items:center;gap:4px;padding:18px;' }, [
        HC.el('div', { class: 'opt-name', text: '🎯 专注中（' + st.focus.minutes + ' 分钟' + (st.focus.pomodoro ? ' · 🍅' : '') + '）' }),
        remainEl,
        HC.el('div', { class: 'bar', style: 'width:100%;' }, [barFill]),
        statEl,
      ])
    );
    root.appendChild(HC.el('div', { class: 'section-subtitle', text: '事件流（忍住 45s 内离开算赢）' }));
    root.appendChild(list);
    root.appendChild(
      HC.el('button', {
        class: 'btn btn-primary',
        text: '结束专注',
        onclick: () => send('FOCUS_END').then(() => HC.modules.focus.render(root.parentNode)),
      })
    );
  }

  /* ================= 未开始 ================= */
  function renderIdle(root, st) {
    root.innerHTML = '';

    const durSel = HC.el('select', { class: 'input opt-ctrl' });
    const suggestion = st.suggestion || 25;
    [
      ['25', '25 分钟（番茄）'], ['45', '45 分钟'], ['60', '60 分钟'], ['90', '90 分钟'],
    ].forEach(([v, l]) => durSel.appendChild(HC.el('option', { value: v, text: l })));
    if (!['25', '45', '60', '90'].includes(String(suggestion))) {
      const opt = HC.el('option', { value: String(suggestion), text: '★ 建议 ' + suggestion + ' 分钟（按你近期完成率算的）' });
      durSel.appendChild(opt);
    }
    durSel.value = String(suggestion);

    const pomodoroChk = HC.el('input', { type: 'checkbox' });
    pomodoroChk.checked = true;
    const ta = HC.el('textarea', {
      class: 'input', rows: '5',
      style: 'width:100%;font-size:12px;line-height:1.6;',
      spellcheck: 'false',
    });

    root.appendChild(
      HC.el('div', { class: 'row glass', style: 'display:block;padding:14px;' }, [
        HC.el('div', { class: 'opt-name', text: '🎯 专注模式' }),
        HC.el('div', { class: 'opt-desc', style: 'margin:4px 0 10px;', text: '打开黑名单站点会温和提醒；45 秒内离开 = 忍住，否则记破戒。结束自动出报告。' }),
        HC.el('div', { class: 'opt-name', style: 'font-size:13px;', text: '专注时长' }),
        durSel,
        HC.el('label', { class: 'chk', style: 'display:flex;gap:6px;margin:8px 0;' }, [
          pomodoroChk, HC.el('span', { text: '🍅 番茄周期（完成后自动排 5 分钟短休，每 4 轮 15 分钟长休）' }),
        ]),
        HC.el('div', { class: 'opt-name', style: 'font-size:13px;', text: '黑名单域名（每行一个）' }),
        ta,
        HC.el('div', { style: 'height:10px;' }),
        HC.el('button', {
          class: 'btn btn-primary',
          text: '开始专注',
          onclick: async () => {
            const blocklist = ta.value.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
            const r = await send('FOCUS_START', {
              minutes: parseInt(durSel.value, 10) || 25,
              blocklist,
              pomodoro: pomodoroChk.checked,
            });
            if (r.ok) { HC.toast('专注开始，加油！', 'success'); HC.modules.focus.render(root.parentNode); }
            else HC.toast(r.error || '启动失败', 'error');
          },
        }),
      ])
    );

    // 载入黑名单 + 统计
    getStorage({ focusBlocklist: DEFAULT_BLOCKLIST, focusStats: null }).then((s) => {
      ta.value = (s.focusBlocklist || DEFAULT_BLOCKLIST).join('\n');
      if (s.focusStats && (s.focusStats.completed || s.focusStats.streak)) {
        root.insertBefore(
          HC.el('div', { class: 'opt-desc', style: 'margin:8px 0;', text:
            `📊 累计完成番茄 ${s.focusStats.completed} 个 · 当前连续 ${s.focusStats.streak} 个` }),
          ta
        );
      }
    });

    /* ---------- 威胁评分建议 ---------- */
    const threatList = HC.el('div', { class: 'list' });
    root.appendChild(HC.el('div', { class: 'section-subtitle', text: '🧠 自适应威胁评分（按你的历史算的，一键加入黑名单）' }));
    root.appendChild(threatList);
    send('FOCUS_THREATS').then((r) => {
      threatList.innerHTML = '';
      if (!r.ok || !r.data || !(r.data.threats || []).length) {
        threatList.appendChild(HC.el('div', { class: 'empty', text: '数据不足，多专注几次后会出现个性化建议' }));
        return;
      }
      r.data.threats.forEach((t) => {
        const btn = t.inList
          ? HC.el('span', { class: 'mini', text: '✓ 已在名单', style: 'opacity:.6;' })
          : HC.el('button', {
            class: 'mini danger', text: '加入',
            onclick: () => {
              ta.value = (ta.value + '\n' + t.host).split('\n').map((x) => x.trim()).filter(Boolean).join('\n');
              btn.textContent = '✓ 已加入';
            },
          });
        threatList.appendChild(
          HC.el('div', { class: 'item' }, [
            HC.el('div', { class: 'item-main' }, [
              HC.el('div', { class: 'item-title', text: t.host }),
              HC.el('div', { class: 'bar', style: 'width:70%;' }, [
                HC.el('div', { class: 'bar-fill', style: 'width:' + Math.round(t.threat * 100) + '%;background:' + (t.threat >= 0.7 ? 'var(--danger)' : t.threat >= 0.5 ? '#e8a33d' : 'var(--accent)') }),
              ]),
              HC.el('div', { class: 'item-sub', text: `威胁分 ${t.threat} · 近 30 天 ${t.visits} 次 · 专注期提醒 ${t.temptations} 次` }),
            ]),
            HC.el('div', { class: 'item-acts' }, [btn]),
          ])
        );
      });
    });

    /* ---------- 报告历史 ---------- */
    getStorage({ focusReports: [] }).then((s) => {
      const reports = (s.focusReports || []).slice(-8).reverse();
      if (!reports.length) return;
      root.appendChild(HC.el('div', { class: 'section-subtitle', text: '历史报告（最近 8 次）' }));
      const list = HC.el('div', { class: 'list' });
      reports.forEach((r) => {
        const eff = Math.round((r.efficiency || 0) * 100);
        list.appendChild(HC.el('div', { class: 'item' }, [
          HC.el('div', { class: 'item-main' }, [
            HC.el('div', { class: 'item-title', text: (r.completed ? '✅ ' : '⏹ ') + r.minutes + ' 分钟 · 效率 ' + eff + '%' }),
            HC.el('div', { class: 'item-sub', text: `提醒 ${r.nudges} · 忍住 ${r.resisted} · 破戒 ${r.broken} · ${new Date(r.end).toLocaleString('zh-CN')}` }),
          ]),
        ]));
      });
      root.appendChild(list);
    });
  }
})();
