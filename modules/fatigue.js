/* -------------------------------------------------------------------------
 * modules/fatigue.js — 护眼仪表盘
 * 展示：当前疲劳等级 / 当日疲劳曲线 / 今日高强度阅读时长 / 休息建议 / 开关
 * 数据来源：background 汇总的 storage.local.eyecare（content.js 每 60s 上报）
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  const LEVEL_META = {
    1: { label: '状态良好', color: '#2c9d6b', tip: '保持当前节奏，每 45 分钟远眺休息一次' },
    2: { label: '轻微疲劳', color: '#7cb342', tip: '远眺 20 秒，活动一下肩颈' },
    3: { label: '中度疲劳', color: '#c98a16', tip: '建议暂停 2 分钟：远眺 20 秒 + 深呼吸' },
    4: { label: '较重度疲劳', color: '#e67e22', tip: '建议闭眼休息 1 分钟，或离开屏幕远眺' },
    5: { label: '重度疲劳', color: '#e5484d', tip: '强烈建议离开屏幕走动 3 分钟，喝杯水' },
  };

  /* Day2：四类页面的权重解读（对应 fatigue-engine.js 的 PAGE_WEIGHTS / PAGE_SIGNAL_SCALE） */
  const PAGE_META = {
    code: { label: '代码', color: '#7cb342', desc: '键入权重最高；持续打字按正常工作打折（×0.6），升级阈值放宽 3 分' },
    article: { label: '长文', color: '#4c7bf3', desc: '鼠标 / 滚动权重最高；来回扫读属正常（路径熵 ×0.7），阈值放宽 2 分' },
    table: { label: '表格', color: '#c98a16', desc: '鼠标 / 滚动主导；频繁点击切筛选属正常（×0.7），阈值放宽 1 分' },
    generic: { label: '通用', color: '#5b6472', desc: '默认均衡权重，信号不打折，阈值不偏移' },
  };
  const PAGE_ORDER = ['code', 'article', 'table', 'generic'];

  /* Day6：引擎自诊断的健康度与单信号状态配色 */
  const HEALTH_META = {
    good: { label: '良好', color: '#2c9d6b', tip: '基线已建立，各信号有区分度' },
    warming: { label: '校准中', color: '#c98a16', tip: '部分信号仍在积累样本，结果仅供参考' },
    cold: { label: '样本不足', color: '#5b6472', tip: '刚开始使用，个人基线尚未建立，引擎按保守值运行' },
  };
  const SIGNAL_LABEL = {
    keyRate: '键入速率', clickRate: '点击速率', scrollSpeed: '滚动速度',
    mouseSpeed: '鼠标速度', mouseReversal: '方向反转', keyGap: '键入节奏',
  };
  const SIGNAL_STATUS = {
    ok: { label: '正常', color: '#2c9d6b' },
    cold: { label: '样本不足', color: '#5b6472' },
    degenerate: { label: '方差塌缩', color: '#e5484d' },
  };

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  HC.modules.fatigue = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      container.appendChild(root);
      render(root);
    },
  };

  function render(root) {
    root.innerHTML = '';
    HC.callBackground('FATIGUE_GET')
      .then((ec) => build(root, ec))
      .catch(() => build(root, null));
  }

  function build(root, ec) {
    const enabled = !ec || ec.enabled !== false;
    const level = (ec && ec.lastLevel) || 1;
    const meta = LEVEL_META[level] || LEVEL_META[1];
    const minutes = Math.round((ec && ec.minutes) || 0);

    // 开关
    const toggle = HC.el('input', { type: 'checkbox' });
    toggle.checked = enabled;
    toggle.addEventListener('change', () => {
      const next = { enabled: toggle.checked };
      chrome.storage.local.get({ eyecare: null }, (r) => {
        const ec2 = Object.assign({}, r.eyecare || {}, next);
        chrome.storage.local.set({ eyecare: ec2 }, () => {
          HC.toast(toggle.checked ? '护眼自适应已开启' : '护眼自适应已暂停', 'success');
        });
      });
    });

    root.appendChild(
      HC.el('div', { class: 'row glass' }, [
        HC.el('div', { class: 'block', style: 'flex:1;' }, [
          HC.el('div', { class: 'section-title', text: '视觉疲劳自适应' }),
          HC.el('p', { class: 'note-text', style: 'margin-top:4px;', text: '实时分析鼠标 / 滚动 / 键盘节奏，自动渐进调整阅读排版；页面右下角会在疲劳时给出提醒。' }),
        ]),
        HC.el('label', { class: 'chk opt-ctrl' }, [toggle, HC.el('span', { text: '启用' })]),
      ])
    );

    // 当前等级
    const levelCard = HC.el('div', { class: 'row glass' }, [
      HC.el('div', { class: 'block', style: 'flex:1;' }, [
        HC.el('div', { class: 'stat-value', text: String(level) + ' / 5', style: `color:${meta.color};` }),
        HC.el('div', { class: 'stat-label', text: '当前疲劳等级' }),
      ]),
      HC.el('div', { class: 'block', style: 'flex:1;' }, [
        HC.el('div', { class: 'stat-value', text: String(minutes) + ' 分钟', style: `color:${meta.color};` }),
        HC.el('div', { class: 'stat-label', text: '今日高强度阅读' }),
      ]),
    ]);
    root.appendChild(levelCard);

    // 休息建议
    const advice = HC.el('div', { class: 'row glass' }, [
      HC.el('div', { class: 'block', style: 'flex:1;' }, [
        HC.el('div', { class: 'section-title', text: '休息建议' }),
        HC.el('p', { class: 'note-text', style: 'margin-top:4px;font-size:13px;color:var(--text);', text: meta.tip }),
        minutes >= 45
          ? HC.el('p', { class: 'warn-text', style: 'margin-top:6px;', text: `已连续高强度阅读约 ${minutes} 分钟，建议休息。` })
          : null,
      ]),
    ]);
    root.appendChild(advice);

    // 当日疲劳曲线
    const log = (ec && ec.log) || [];
    const points = log.slice(-24); // 最近 24 个点（约 4 小时）
    const box = HC.el('div', { class: 'row glass' }, [
      HC.el('div', { class: 'block', style: 'flex:1;width:100%;' }, [
        HC.el('div', { class: 'section-title', text: '当日疲劳曲线（最近 ' + (points.length || 0) + ' 个采样点）' }),
        HC.el('div', { class: 'bar-list', style: 'margin-top:8px;' }, [
          points.length
            ? points.map((p) => {
                const lv = p.score < 15 ? 1 : p.score < 35 ? 2 : p.score < 55 ? 3 : p.score < 75 ? 4 : 5;
                const color = LEVEL_META[lv].color;
                return HC.el('div', { class: 'bar-row', title: `${fmtTime(p.t)}  疲劳 ${p.score}/100（${LEVEL_META[lv].label}）` }, [
                  HC.el('span', { class: 'bar-label', text: fmtTime(p.t) }),
                  HC.el('div', { class: 'bar-track' }, [
                    HC.el('div', { class: 'bar-fill', style: `width:${Math.max(3, p.score)}%;background:${color};` }),
                  ]),
                  HC.el('span', { class: 'bar-val', text: String(p.score) }),
                ]);
              })
            : HC.el('div', { class: 'empty', text: '暂无数据——在网页上活动一段时间后自动生成' }),
        ]),
      ]),
    ]);
    root.appendChild(box);

    /* ---------- Day2：页面类型自适应 ---------- */
    const ptm = (ec && ec.pageTypeMinutes) || null;
    const lastType = (ec && ec.lastPageType) || 'generic';
    const typeMeta = PAGE_META[lastType] || PAGE_META.generic;
    const typeBars = PAGE_ORDER.map((t) => ({ t, m: ptm ? (ptm[t] || 0) : 0 }));
    const maxType = Math.max(1, ...typeBars.map((b) => b.m));

    root.appendChild(
      HC.el('div', { class: 'row glass' }, [
        HC.el('div', { class: 'block', style: 'flex:1;width:100%;' }, [
          HC.el('div', { class: 'section-title', text: '页面类型自适应' }),
          HC.el('div', { class: 'row', style: 'padding:6px 0 2px;gap:8px;' }, [
            HC.el('span', { class: 'pt-badge', style: `background:${typeMeta.color};`, text: typeMeta.label }),
            HC.el('span', { class: 'note-text', style: 'font-size:12px;flex:1;min-width:180px;', text: typeMeta.desc }),
          ]),
          HC.el('div', { class: 'bar-list', style: 'margin-top:6px;' },
            typeBars.map((b) => HC.el('div', { class: 'bar-row', title: `${PAGE_META[b.t].label}页 · 高强度 ${Math.round(b.m)} 分钟` }, [
              HC.el('span', { class: 'bar-label', text: PAGE_META[b.t].label + '页' }),
              HC.el('div', { class: 'bar-track' }, [
                HC.el('div', { class: 'bar-fill', style: `width:${Math.max(2, (b.m / maxType) * 100)}%;background:${PAGE_META[b.t].color};` }),
              ]),
              HC.el('span', { class: 'bar-val', text: Math.round(b.m) + ' 分' }),
            ]))
          ),
        ]),
      ])
    );

    /* ---------- Day6：引擎自诊断 ---------- */
    const diag = ec && ec.diagnostics;
    if (diag && diag.signals) {
      const hm = HEALTH_META[diag.health] || HEALTH_META.cold;
      root.appendChild(
        HC.el('div', { class: 'row glass' }, [
          HC.el('div', { class: 'block', style: 'flex:1;width:100%;' }, [
            HC.el('div', { class: 'section-title', text: '引擎状态' }),
            HC.el('div', { class: 'row', style: 'padding:6px 0 2px;gap:8px;' }, [
              HC.el('span', { class: 'pt-badge', style: `background:${hm.color};`, text: hm.label }),
              HC.el('span', { class: 'note-text', style: 'font-size:12px;flex:1;min-width:180px;', text: hm.tip }),
            ]),
            HC.el('div', { class: 'diag-list' }, diag.signals.map((s) => {
              const st = SIGNAL_STATUS[s.status] || SIGNAL_STATUS.cold;
              return HC.el('span', {
                class: 'diag-chip',
                style: `border-color:${st.color};color:${st.color};`,
                title: `样本 ${s.n} · 均值 ${s.mean} · 标准差 ${s.std}`,
                text: `${SIGNAL_LABEL[s.name] || s.name} ${st.label}`,
              });
            })),
          ]),
        ])
      );
    }

    /* ---------- Day8：爆表信号源追溯 ---------- */
    const top = ec && ec.lastTopSignal;
    if (top && level >= 3) {
      root.appendChild(
        HC.el('div', { class: 'row glass' }, [
          HC.el('div', { class: 'block', style: 'flex:1;width:100%;' }, [
            HC.el('div', { class: 'section-title', text: '这次是谁把分数顶上去的' }),
            HC.el('div', { class: 'row', style: 'padding:6px 0 2px;gap:8px;' }, [
              HC.el('span', { class: 'pt-badge', style: 'background:#e67e22;', text: top.label || top.key }),
              HC.el('span', { class: 'note-text', style: 'font-size:12px;flex:1;min-width:180px;',
                text: `贡献占比 ${Math.round((top.share || 0) * 100)}% · 该信号强度 ${Math.round((top.value || 0) * 100)}/100` }),
            ]),
            ec.lastAdvice
              ? HC.el('p', { class: 'note-text', style: 'margin-top:6px;font-size:13px;color:var(--text);', text: '👉 ' + ec.lastAdvice })
              : null,
          ]),
        ])
      );
    }

    /* ---------- Backlog：马尔可夫链（等级跳变） ---------- */
    const mk = ec && ec.markov;
    if (mk && mk.samples > 0) {
      const nextTxt = mk.next
        ? `从 ${mk.current} 级出发，历史上最可能去 ${mk.next.level} 级（${Math.round((mk.next.p || 0) * 100)}%，基于 ${mk.next.samples} 次观测）`
        : '当前等级还没有足够的跳变样本';
      root.appendChild(
        HC.el('div', { class: 'row glass' }, [
          HC.el('div', { class: 'block', style: 'flex:1;width:100%;' }, [
            HC.el('div', { class: 'section-title', text: '等级转移模型（马尔可夫）' }),
            HC.el('p', { class: 'note-text', style: 'margin-top:4px;font-size:12.5px;', text: nextTxt }),
            HC.el('div', { class: 'bar-list', style: 'margin-top:6px;' },
              (mk.stationary || []).map((p, i) => HC.el('div', { class: 'bar-row', title: `长期停留在 ${i + 1} 级的时间占比 ${Math.round(p * 100)}%` }, [
                HC.el('span', { class: 'bar-label', text: (i + 1) + ' 级' }),
                HC.el('div', { class: 'bar-track' }, [
                  HC.el('div', { class: 'bar-fill', style: `width:${Math.max(2, p * 100)}%;background:${LEVEL_META[i + 1].color};` }),
                ]),
                HC.el('span', { class: 'bar-val', text: Math.round(p * 100) + '%' }),
              ]))
            ),
            HC.el('p', { class: 'note-text', style: 'margin-top:4px;font-size:12px;',
              text: `稳态分布：长期看你有 ${mk.highRatio}% 的时间处在 4 级以上（累计 ${mk.samples} 次等级跳变）。` }),
          ]),
        ])
      );
    }

    /* ---------- Day4：周级疲劳画像 ---------- */
    chrome.storage.local.get({ eyecareHistory: [] }, (hs) => {
      const hist = ((hs && hs.eyecareHistory) || []).slice(-7);
      if (hist.length < 2) return;
      const avgs = hist.map((d) => d.avg).filter((v) => typeof v === 'number');
      if (avgs.length < 2) return;
      const mu = avgs.reduce((a, b) => a + b, 0) / avgs.length;
      const sigma = Math.sqrt(avgs.reduce((a, b) => a + (b - mu) ** 2, 0) / avgs.length);
      const isOutlier = (v) => sigma > 1e-6 && Math.abs(v - mu) / sigma >= 1.5;
      const maxAvg = Math.max(...avgs, 1);
      const card = HC.el('div', { class: 'row glass' }, [
        HC.el('div', { class: 'block', style: 'flex:1;width:100%;' }, [
          HC.el('div', { class: 'section-title', text: '周级疲劳画像（近 ' + hist.length + ' 天）' }),
          HC.el('p', { class: 'note-text', style: 'margin-top:4px;font-size:12.5px;',
            text: `每日常态 μ = ${mu.toFixed(1)} 分，标准差 σ = ${sigma.toFixed(1)} 分；偏离 μ 超过 1.5σ 的日子标记为离群日 ⚠。` }),
          HC.el('div', { class: 'bar-list', style: 'margin-top:6px;' },
            hist.map((d) => {
              const out = isOutlier(d.avg);
              return HC.el('div', { class: 'bar-row', title:
                `${d.date} · 日均 ${d.avg} 分 · 峰值 ${d.max} 分 · 高强度 ${d.minutes} 分钟 · ${d.samples} 个采样点` }, [
                HC.el('span', { class: 'bar-label', text: d.date.slice(5) + (out ? ' ⚠' : '') }),
                HC.el('div', { class: 'bar-track' }, [
                  HC.el('div', { class: 'bar-fill', style: `width:${Math.max(3, (d.avg / maxAvg) * 100)}%;background:${out ? 'var(--danger)' : 'var(--accent)'};` }),
                ]),
                HC.el('span', { class: 'bar-val', text: d.avg + ' 分' }),
              ]);
            })
          ),
        ]),
      ]);
      root.insertBefore(card, root.lastChild);
    });

    // 说明
    root.appendChild(
      HC.el('div', { class: 'row glass' }, [
        HC.el('p', { class: 'note-text', text: '说明：疲劳等级 1-5 由鼠标 / 滚动 / 键盘节奏与连续时长综合评估。等级 ≥4 时页面自动开启聚焦阅读（高亮当前段落），等级 5 时正文暖色微调；调整在 30 秒内渐进完成。扩展图标角标实时显示当前等级。' }),
      ])
    );
  }
})();
