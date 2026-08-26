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

    // 说明
    root.appendChild(
      HC.el('div', { class: 'row glass' }, [
        HC.el('p', { class: 'note-text', text: '说明：疲劳等级 1-5 由鼠标 / 滚动 / 键盘节奏与连续时长综合评估。等级 ≥4 时页面自动开启聚焦阅读（高亮当前段落），等级 5 时正文暖色微调；调整在 30 秒内渐进完成。扩展图标角标实时显示当前等级。' }),
      ])
    );
  }
})();
