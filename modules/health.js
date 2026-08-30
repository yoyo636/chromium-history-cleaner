/* -------------------------------------------------------------------------
 * modules/health.js — 浏览器健康分
 * 六个分项加权合成 0-100 分：
 *   标签(20%) 历史(18%) 下载(12%) 护眼(18%) 隐私(12%) 专注纪律(20%)
 * 全部本地计算：tabs / history / downloads /
 *               storage(eyecare, privacyMode, focusReports, focusGoalMinutes)
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));

  async function countSearch(api, opts) {
    return new Promise((res) => api(opts, (x) => res(x || [])));
  }

  function scoreTabs(n) { return clamp(100 - Math.max(0, n - 8) * 4); }        // 8 个以内满分
  function scoreHistory(n) { return n <= 500 ? 100 : clamp(100 - (n - 500) / 45); } // 5000 条 → 0
  function scoreDownloads(n) { return clamp(100 - n); }                        // 100 条记录 → 0
  function scoreEyes(min) {                                                    // 今日高强度用眼分钟
    if (min == null) return 80;                                                // 无数据给中性分
    return min <= 60 ? 100 : clamp(100 - (min - 60) / 2.4);                    // 300 分钟 → 0
  }
  function scorePrivacy(mode) { return mode === 'shield' ? 100 : 60; }

  /* Day10：专注纪律 —— 忍住率 60% + 目标完成率 40%
   * 忍住率 = 忍住 / (忍住 + 破戒)，没有分心样本时按满分计（全程无分心当然满分）；
   * 目标完成率 = 近 7 天完成的专注分钟 / (每日目标 × 7)，封顶 100%。 */
  function scoreFocus(reports, goal) {
    const week = (reports || []).filter((r) => Date.now() - r.end <= 7 * 864e5);
    if (!week.length) return { score: 70, desc: '近 7 天还没有专注记录（给中性分）' };
    const resist = week.reduce((a, r) => a + (r.resisted || 0), 0);
    const broke = week.reduce((a, r) => a + (r.broken || 0), 0);
    const winRate = resist + broke ? resist / (resist + broke) : null;
    const doneMin = week.reduce((a, r) => a + (r.completed ? r.minutes : 0), 0);
    const target = Math.max(1, (goal || 60) * 7);
    const goalRate = Math.min(1, doneMin / target);
    const wr = winRate == null ? 1 : winRate;
    const score = clamp(100 * (0.6 * wr + 0.4 * goalRate));
    const desc = `近 7 天专注 ${Math.round(doneMin)} / ${Math.round(target)} 分钟`
      + (winRate == null ? ' · 期间没有分心记录' : ` · 忍住率 ${Math.round(winRate * 100)}%（${resist} 胜 / ${broke} 败）`);
    return { score, desc };
  }

  HC.modules.health = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      const hero = HC.el('div', { class: 'row glass score-hero' });
      const bars = HC.el('div', { class: 'opt-list' });
      const tips = HC.el('div', { class: 'opt-list' });
      const again = HC.el('button', { class: 'btn btn-primary', text: '重新评估', onclick: run });

      root.appendChild(hero);
      root.appendChild(bars);
      root.appendChild(HC.el('div', { class: 'section-subtitle', text: '改进建议' }));
      root.appendChild(tips);
      root.appendChild(again);
      container.appendChild(root);

      function bar(label, score, desc) {
        return HC.el('div', { class: 'opt-row' }, [
          HC.el('div', { class: 'opt-info' }, [
            HC.el('div', { class: 'opt-name', text: label + ' · ' + score }),
            HC.el('div', { class: 'bar' }, [
              HC.el('div', { class: 'bar-fill', style: 'width:' + score + '%;background:' + (score >= 80 ? 'var(--success)' : score >= 60 ? 'var(--accent)' : 'var(--danger)') }),
            ]),
            HC.el('div', { class: 'opt-desc', text: desc }),
          ]),
        ]);
      }

      async function run() {
        hero.innerHTML = '';
        hero.appendChild(HC.el('div', { class: 'opt-name', text: '评估中…' }));

        const [tabs, hist, dls, ey, fs] = await Promise.all([
          new Promise((r) => chrome.tabs.query({}, (t) => r(t || []))),
          countSearch(chrome.history.search.bind(chrome.history),
            { text: '', startTime: Date.now() - 7 * 864e5, endTime: Date.now(), maxResults: 5000 }),
          countSearch(chrome.downloads.search.bind(chrome.downloads), { limit: 500 }),
          new Promise((r) => chrome.storage.local.get({ eyecare: null, privacyMode: 'monitor' }, (x) => r(x))),
          new Promise((r) => chrome.storage.local.get({ focusReports: [], focusGoalMinutes: 60 }, (x) => r(x))),
        ]);

        const eyeMin = ey.eyecare && typeof ey.eyecare.minutes === 'number' ? ey.eyecare.minutes : null;
        const fr = scoreFocus(fs.focusReports, fs.focusGoalMinutes); // Day10
        const comps = [
          ['标签', scoreTabs(tabs.length), '当前打开 ' + tabs.length + ' 个标签（8 个以内满分）'],
          ['历史', scoreHistory(hist.length), '近 7 天 ' + hist.length + ' 条记录（500 条内满分）'],
          ['下载', scoreDownloads(dls.length), dls.length + ' 条下载记录堆积（可到「下载」页清理）'],
          ['护眼', scoreEyes(eyeMin), eyeMin == null ? '暂无今日护眼数据' : '今日高强度用眼 ' + eyeMin + ' 分钟'],
          ['隐私', scorePrivacy(ey.privacyMode), ey.privacyMode === 'shield' ? '指纹加固已开启' : '指纹加固未开启（可在「隐私防护」开启）'],
          ['专注纪律', fr.score, fr.desc],
        ];
        // 六项权重合计 1.0（原五项各让出一部分给「专注纪律」）
        const weights = [0.2, 0.18, 0.12, 0.18, 0.12, 0.2];
        const total = clamp(comps.reduce((s, c, i) => s + c[1] * weights[i], 0));
        const grade = total >= 85 ? '优' : total >= 70 ? '良' : total >= 50 ? '中' : '差';
        const gcolor = total >= 85 ? 'var(--success)' : total >= 70 ? 'var(--accent)' : total >= 50 ? '#e8a33d' : 'var(--danger)';

        hero.innerHTML = '';
        hero.style.cssText = 'flex-direction:column;align-items:center;gap:4px;padding:18px;';
        hero.appendChild(HC.el('div', { class: 'score-num', style: 'color:' + gcolor, text: String(total) }));
        hero.appendChild(HC.el('div', { class: 'opt-name', text: '健康分 · ' + grade }));
        hero.appendChild(HC.el('div', { class: 'opt-desc', text: new Date().toLocaleDateString('zh-CN') + ' 体检结果' }));

        bars.innerHTML = '';
        comps.forEach((c) => bars.appendChild(bar(c[0], c[1], c[2])));

        tips.innerHTML = '';
        const tipsMap = {
          标签: '打开「标签页」页，关闭或挂起不用的标签；超过 8 个会开始拖慢浏览器。',
          历史: '到「清理」页清理久远历史，或用「历史」页按域名删除。',
          下载: '到「下载」页移除无用下载记录（不会删除文件本身）。',
          护眼: '休息一下！离开屏幕 5 分钟，或在「护眼助手」查看今日疲劳曲线。',
          隐私: '到「隐私防护」开启指纹加固。',
          专注纪律: '到「专注模式」开一次 25 分钟番茄；分心后 45 秒内离开就算「忍住」，能拉高这项分。',
        };
        let any = false;
        comps.forEach((c) => {
          if (c[1] < 70) { any = true; tips.appendChild(HC.el('div', { class: 'opt-row' }, [HC.el('div', { class: 'opt-info' }, [HC.el('div', { class: 'opt-desc', text: '• ' + tipsMap[c[0]] })])])); }
        });
        if (!any) tips.appendChild(HC.el('div', { class: 'opt-row' }, [HC.el('div', { class: 'opt-desc', text: '一切正常，保持！✅' })]));
      }

      run();
    },
  };
})();
