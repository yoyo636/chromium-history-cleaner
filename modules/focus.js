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
  /* Day3：白名单模式默认许可站点（写作/文档/代码托管这类「主线」站点） */
  const DEFAULT_ALLOWLIST = ['docs.google.com', 'github.com', 'stackoverflow.com', 'mail.google.com'];

  /* Day5：分心原因（与 background.js 的 FOCUS_REASONS 保持一致） */
  const REASONS = [
    ['habit', '习惯性手滑'], ['need', '确实要查资料'], ['mood', '焦虑 / 想逃避'],
    ['notify', '被通知勾走'], ['bored', '卡住换换脑子'],
  ];

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

    /* Day5：给「忍住 / 破戒」事件补一句原因（威胁评分会按此加权） */
    function reasonRow(e) {
      if (!e || (e.kind !== 'resist' && e.kind !== 'broke')) return null;
      const row = HC.el('div', { class: 'reason-row' });
      if (e.reason) {
        const found = REASONS.find((r) => r[0] === e.reason);
        row.appendChild(HC.el('span', { class: 'reason-done', text: '📝 ' + (found ? found[1] : e.reason) }));
        return row;
      }
      row.appendChild(HC.el('span', { class: 'reason-ask', text: '当时是为什么？' }));
      REASONS.forEach(([id, label]) => {
        row.appendChild(HC.el('button', {
          class: 'mini', text: label,
          onclick: () => send('FOCUS_REASON', { t: e.t, host: e.host, reason: id }).then((r) => {
            if (r.ok) { HC.toast('已记录：' + label, 'success'); tick(); }
            else HC.toast(r.error || '记录失败', 'error');
          }),
        }));
      });
      return row;
    }

    function renderRecent(recent) {
      list.innerHTML = '';
      if (!recent.length) {
        list.appendChild(HC.el('div', { class: 'empty', text: '暂无事件 —— 保持住！' }));
        return;
      }
      recent.forEach((e) => {
        const icon = e.kind === 'resist' ? '💪' : e.kind === 'broke' ? '❌' : '🔔';
        const label = e.kind === 'resist' ? '忍住' : e.kind === 'broke' ? '破戒' : '提醒';
        const main = HC.el('div', { class: 'item-main' }, [
          HC.el('div', { class: 'item-title', text: icon + ' ' + label + ' · ' + e.host }),
          HC.el('div', { class: 'item-sub', text: new Date(e.t).toLocaleTimeString('zh-CN') + (e.dwellMs ? ' · 停留 ' + Math.round(e.dwellMs / 1000) + 's' : '') }),
        ]);
        const rr = reasonRow(e);
        if (rr) main.appendChild(rr);
        list.appendChild(HC.el('div', { class: 'item' }, [main]));
      });
    }
    renderRecent(st.recent || []);

    root.appendChild(
      HC.el('div', { class: 'row glass', style: 'flex-direction:column;align-items:center;gap:4px;padding:18px;' }, [
        HC.el('div', { class: 'opt-name', text: '🎯 专注中（' + st.focus.minutes + ' 分钟'
          + (st.mode === 'white' ? ' · 白名单' : ' · 黑名单') + (st.focus.pomodoro ? ' · 🍅' : '') + '）' }),
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

  /* ================= Day9：会话回放 =================
   * 把一次会话的事件按「时间比例」铺成条带：横轴 = 会话时长，
   * 绿=忍住 / 红=破戒 / 黄=提醒，条带宽度 = 停留时长。
   * 纯 CSS 绝对定位实现，不引任何图表库。 */
  const REPLAY_KIND = {
    resist: { color: '#2c9d6b', label: '忍住' },
    broke: { color: '#e5484d', label: '破戒' },
    nudge: { color: '#c98a16', label: '提醒' },
  };
  function replayStrip(r) {
    const evs = r.events || [];
    const track = HC.el('div', { class: 'replay-track' });
    const span = Math.max(1, r.end - r.start);
    track.appendChild(HC.el('div', { class: 'replay-base' }));
    if (!evs.length) {
      track.appendChild(HC.el('div', { class: 'replay-none', text: '本会话无事件记录' }));
      return track;
    }
    evs.forEach((e) => {
      const meta = REPLAY_KIND[e.kind] || { color: '#5b6472', label: e.kind };
      const left = Math.max(0, Math.min(100, ((e.t - r.start) / span) * 100));
      const w = e.dwellMs ? Math.max(1.2, (e.dwellMs / span) * 100) : 1.2;
      track.appendChild(HC.el('div', {
        class: 'replay-seg',
        style: `left:${left.toFixed(2)}%;width:${Math.min(w, 100 - left).toFixed(2)}%;background:${meta.color};`,
        title: `${meta.label} · ${e.host}`
          + (e.dwellMs ? ` · 停留 ${Math.round(e.dwellMs / 1000)}s` : '')
          + (e.reason ? ` · ${(REASONS.find((x) => x[0] === e.reason) || [e.reason, e.reason])[1]}` : '')
          + ` · ${new Date(e.t).toLocaleTimeString('zh-CN')}`,
      }));
    });
    return track;
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

    /* ---- Day3：两种拦截模式（黑名单正向 / 白名单反向） ---- */
    let mode = 'black';
    const ta = HC.el('textarea', { class: 'input', rows: '5', style: 'width:100%;font-size:12px;line-height:1.6;', spellcheck: 'false' });
    const whiteTa = HC.el('textarea', { class: 'input', rows: '4', style: 'width:100%;font-size:12px;line-height:1.6;', spellcheck: 'false' });
    const blockWrap = HC.el('div', {}, [
      HC.el('div', { class: 'opt-name', style: 'font-size:13px;', text: '黑名单域名（每行一个，命中即分心）' }),
      ta,
    ]);
    const allowWrap = HC.el('div', { style: 'display:none;' }, [
      HC.el('div', { class: 'opt-name', style: 'font-size:13px;', text: '白名单域名（每行一个，只有这些算专注内）' }),
      whiteTa,
      HC.el('div', { class: 'opt-desc', style: 'margin-top:4px;', text: '白名单模式更严格：所有不在列表里的站点都会被提醒，停留超过 45 秒记破戒。写作 / 文档 / 代码托管建议放进来。' }),
    ]);
    const modeBlack = HC.el('button', { class: 'chip active', text: '🚫 黑名单模式' });
    const modeWhite = HC.el('button', { class: 'chip', text: '✅ 白名单模式' });
    const modeRow = HC.el('div', { class: 'presets', style: 'margin:6px 0;' }, [modeBlack, modeWhite]);
    const modeHint = HC.el('div', { class: 'opt-desc', style: 'margin:4px 0 10px;' });
    const goalSlot = HC.el('div', {}); // 每日目标行（异步填充，始终可见）
    function syncMode() {
      modeBlack.className = 'chip' + (mode === 'black' ? ' active' : '');
      modeWhite.className = 'chip' + (mode === 'white' ? ' active' : '');
      blockWrap.style.display = mode === 'black' ? '' : 'none';
      allowWrap.style.display = mode === 'white' ? '' : 'none';
      modeHint.textContent = mode === 'black'
        ? '打开黑名单站点会温和提醒；45 秒内离开 = 忍住，否则记破戒。结束自动出报告。'
        : '白名单模式：只有列表内的站点算专注内，其余一律提醒；45 秒内离开 = 忍住。';
    }
    modeBlack.onclick = () => { mode = 'black'; syncMode(); };
    modeWhite.onclick = () => { mode = 'white'; syncMode(); };

    root.appendChild(
      HC.el('div', { class: 'row glass', style: 'display:block;padding:14px;' }, [
        HC.el('div', { class: 'opt-name', text: '🎯 专注模式' }),
        modeHint,
        HC.el('div', { class: 'opt-name', style: 'font-size:13px;', text: '专注时长' }),
        durSel,
        HC.el('label', { class: 'chk', style: 'display:flex;gap:6px;margin:8px 0;' }, [
          pomodoroChk, HC.el('span', { text: '🍅 番茄周期（完成后自动排 5 分钟短休，每 4 轮 15 分钟长休）' }),
        ]),
        goalSlot,
        HC.el('div', { class: 'opt-name', style: 'font-size:13px;', text: '拦截模式' }),
        modeRow,
        blockWrap,
        allowWrap,
        HC.el('div', { style: 'height:10px;' }),
        HC.el('button', {
          class: 'btn btn-primary',
          text: '开始专注',
          onclick: async () => {
            const norm = (v) => v.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
            const blocklist = norm(ta.value);
            const allowlist = norm(whiteTa.value);
            if (mode === 'white' && !allowlist.length) {
              HC.toast('白名单模式至少需要一个允许域名', 'error');
              return;
            }
            chrome.storage.local.set({ focusBlocklist: blocklist, focusAllowlist: allowlist });
            const r = await send('FOCUS_START', {
              minutes: parseInt(durSel.value, 10) || 25,
              blocklist,
              allowlist,
              mode,
              pomodoro: pomodoroChk.checked,
            });
            if (r.ok) { HC.toast('专注开始，加油！', 'success'); HC.modules.focus.render(root.parentNode); }
            else HC.toast(r.error || '启动失败', 'error');
          },
        }),
      ])
    );
    syncMode();

    // 载入黑名单 / 白名单 + 统计 + 每日目标
    getStorage({ focusBlocklist: DEFAULT_BLOCKLIST, focusAllowlist: DEFAULT_ALLOWLIST, focusStats: null, focusReports: [], focusGoalMinutes: 60 }).then((s) => {
      ta.value = (s.focusBlocklist || DEFAULT_BLOCKLIST).join('\n');
      whiteTa.value = (s.focusAllowlist || DEFAULT_ALLOWLIST).join('\n');

      /* ---- Day1 增量：每日目标 + 进度条 ---- */
      const goal = s.focusGoalMinutes || 60;
      const today = new Date().toDateString();
      const todayMin = (s.focusReports || [])
        .filter((r) => r.completed && new Date(r.end).toDateString() === today)
        .reduce((a, r) => a + r.minutes, 0);
      const goalRow = HC.el('div', { class: 'opt-row', style: 'margin:8px 0;align-items:center;' }, [
        HC.el('div', { class: 'opt-info' }, [
          HC.el('div', { class: 'opt-name', text: `今日目标 ${todayMin} / ${goal} 分钟` }),
          HC.el('div', { class: 'bar', style: 'width:220px;' }, [
            HC.el('div', { class: 'bar-fill', style: 'width:' + Math.min(100, Math.round((todayMin / goal) * 100)) + '%;background:' + (todayMin >= goal ? 'var(--success)' : 'var(--accent)') }),
          ]),
        ]),
      ]);
      const goalIn = HC.el('input', { class: 'input', type: 'number', min: '10', max: '600', value: String(goal), style: 'width:76px;flex:none;' });
      goalIn.addEventListener('change', () => {
        const v = Math.max(10, Math.min(600, parseInt(goalIn.value, 10) || 60));
        chrome.storage.local.set({ focusGoalMinutes: v });
        HC.toast('每日目标已设为 ' + v + ' 分钟', 'success');
        HC.modules.focus.render(root.parentNode);
      });
      goalRow.appendChild(goalIn);
      goalSlot.appendChild(goalRow);

      if (s.focusStats && (s.focusStats.completed || s.focusStats.streak)) {
        goalSlot.appendChild(
          HC.el('div', { class: 'opt-desc', style: 'margin:8px 0;', text:
            `📊 累计完成番茄 ${s.focusStats.completed} 个 · 当前连续 ${s.focusStats.streak} 个` })
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
      // Day7：把「此刻的时段风险」摆在明面上，用户能看懂分数为什么变高
      const risk = r.data.currentRisk || 0;
      const riskWord = risk >= 0.9 ? '深夜（自制力低谷）' : risk >= 0.6 ? '晚间' : risk >= 0.4 ? '过渡时段' : '工作时段';
      threatList.appendChild(
        HC.el('div', { class: 'opt-desc', style: 'margin:4px 0;', text:
          `⏰ 现在是 ${r.data.nowHour} 点 · ${riskWord}（时段系数 ${risk}）——同一域名在深夜的威胁分会整体上浮。` })
      );
      r.data.threats.forEach((t) => {
        const btn = mode === 'white'
          ? HC.el('span', { class: 'mini', text: '✓ 白名单外已拦', style: 'opacity:.6;' })
          : t.inList
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
              HC.el('div', { class: 'item-sub', text:
                `威胁分 ${t.threat} · 近 30 天 ${t.visits} 次 · 分心 ${t.temptations} 次`
                + ` · 时段敏感 ${t.timeSens}` + (t.peakHour != null ? `（高峰 ${t.peakHour} 点）` : '')
                + (t.nightShare >= 0.4 ? ` · 深夜占比 ${Math.round(t.nightShare * 100)}%` : '') }),
            ]),
            HC.el('div', { class: 'item-acts' }, [btn]),
          ])
        );
      });
    });

    /* ---------- 报告历史 ---------- */
    getStorage({ focusReports: [], focusReasonStats: {} }).then((s) => {
      const reports = (s.focusReports || []).slice(-8).reverse();
      if (!reports.length) return;
      root.appendChild(HC.el('div', { class: 'section-subtitle', text: '历史报告（最近 8 次）' }));
      const list = HC.el('div', { class: 'list' });
      reports.forEach((r) => {
        const eff = Math.round((r.efficiency || 0) * 100);
        const main = HC.el('div', { class: 'item-main' }, [
          HC.el('div', { class: 'item-title', text: (r.completed ? '✅ ' : '⏹ ') + r.minutes + ' 分钟 · 效率 ' + eff + '%' + (r.mode === 'white' ? ' · 白名单' : '') }),
          HC.el('div', { class: 'item-sub', text: `提醒 ${r.nudges} · 忍住 ${r.resisted} · 破戒 ${r.broken} · ${new Date(r.end).toLocaleString('zh-CN')}` }),
        ]);
        main.appendChild(replayStrip(r)); // Day9
        list.appendChild(HC.el('div', { class: 'item' }, [main]));
      });
      root.appendChild(list);

      /* ---- Day5：分心原因分布 ---- */
      const rs = s.focusReasonStats || {};
      const rsKeys = Object.keys(rs).filter((k) => rs[k] > 0).sort((a, b) => rs[b] - rs[a]);
      if (rsKeys.length) {
        const totalR = rsKeys.reduce((a, k) => a + rs[k], 0);
        root.appendChild(HC.el('div', { class: 'section-subtitle', text: '📝 分心原因分布（速记自事件流）' }));
        root.appendChild(HC.el('div', { class: 'row glass', style: 'display:block;padding:12px;' },
          rsKeys.map((k) => {
            const label = (REASONS.find((x) => x[0] === k) || [k, k])[1];
            const pct = Math.round((rs[k] / totalR) * 100);
            return HC.el('div', { class: 'bar-row', title: label + ' ' + rs[k] + ' 次' }, [
              HC.el('span', { class: 'bar-label', text: label }),
              HC.el('div', { class: 'bar-track' }, [
                HC.el('div', { class: 'bar-fill', style: `width:${Math.max(3, pct)}%;background:var(--accent);` }),
              ]),
              HC.el('span', { class: 'bar-val', text: rs[k] + ' 次' }),
            ]);
          })
        ));
      }

      /* ---- Day1 增量：周报聚合（近 7 天） ---- */
      const week = (s.focusReports || []).filter((r) => Date.now() - r.end <= 7 * 864e5);
      if (week.length >= 2) {
        const totalMin = week.reduce((a, r) => a + (r.completed ? r.minutes : 0), 0);
        const doneRate = Math.round((week.filter((r) => r.completed).length / week.length) * 100);
        const avgEff = Math.round((week.reduce((a, r) => a + (r.efficiency || 0), 0) / week.length) * 100);
        const resist = week.reduce((a, r) => a + r.resisted, 0);
        const broke = week.reduce((a, r) => a + r.broken, 0);
        const winRate = resist + broke ? Math.round((resist / (resist + broke)) * 100) : null;
        root.appendChild(HC.el('div', { class: 'section-subtitle', text: '📈 周报（近 7 天）' }));
        root.appendChild(
          HC.el('div', { class: 'row glass', style: 'display:block;padding:12px;' }, [
            HC.el('div', { class: 'opt-desc', text:
              `专注 ${totalMin} 分钟（${week.length} 次会话）· 完成率 ${doneRate}% · 平均效率 ${avgEff}%` +
              (winRate != null ? ` · 忍住率 ${winRate}%（${resist} 胜 / ${broke} 败）` : '') }),
          ])
        );
      }
    });
  }
})();
