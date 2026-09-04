/* -------------------------------------------------------------------------
 * modules/privacy.js — 无痕模式追踪防护与隐私报告
 * - 监控：MAIN 世界内容脚本 hook canvas / WebGL 指纹调用，记录「哪个站点、
 *   哪个 API、是否无痕模式、调用次数」（真实归因）
 * - 加固：一键开启随机化指纹（canvas 加噪 + WebGL 厂商/渲染器加扰）
 * - 图谱：统计跨站出现的第三方指纹域名（追踪网络候选）
 * 能力边界（如实）：UA / 字体测量等浏览器级指纹无法由脚本安全篡改，
 * 仅记录；canvas/WebGL 可随机化。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  const RISK = {
    canvas: { lv: 3, label: 'Canvas 指纹', hint: '通过画布渲染像素识别设备（无痕下仍有效）' },
    webgl: { lv: 2, label: 'WebGL 指纹', hint: '读取 GPU 厂商/渲染器信息识别设备' },
    ua: { lv: 1, label: 'UA 读取', hint: '浏览器标识（无痕下与普通一致）' },
    fonts: { lv: 2, label: '字体测量', hint: '测量字体渲染差异（无痕下可识别）' },
  };
  /* 事件 api 形如 canvas-getImageData / webgl-readPixels（带方法后缀），
   * 按前缀归到 canvas / webgl 族再查风险表；直接整串查永远 miss，
   * 会导致风险等级全部落到默认、Canvas/WebGL 统计卡恒为 0 */
  function riskOf(api) {
    const k = String(api || '').split('-')[0];
    return RISK[k] || { lv: 2, label: String(api || ''), hint: '' };
  }

  function riskBadge(api) {
    const r = riskOf(api);
    const cls = r.lv >= 3 ? 'red' : r.lv === 2 ? 'yellow' : 'green';
    return HC.el('span', { class: 'size-badge ' + cls, text: '风险 ' + r.lv });
  }

  HC.modules.privacy = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      container.appendChild(root);
      build(root);
    },
  };

  function build(root) {
    root.innerHTML = '';
    HC.callBackground('PRIVACY_GET')
      .then((data) => renderAll(root, data))
      .catch((e) => {
        root.appendChild(HC.el('div', { class: 'empty', text: '加载失败：' + e.message }));
      });
  }

  function renderAll(root, data) {
    const mode = data.mode || 'monitor';
    const events = data.events || [];

    // 模式选择
    const modeSel = HC.el('select', { class: 'input opt-ctrl' });
    [
      ['monitor', '仅监控（默认）'],
      ['shield', '加固：随机化指纹'],
      ['off', '关闭'],
    ].forEach(([v, l]) => modeSel.appendChild(HC.el('option', { value: v, text: l })));
    modeSel.value = mode;
    modeSel.addEventListener('change', () => {
      HC.callBackground('PRIVACY_SET_MODE', { mode: modeSel.value })
        .then(() => HC.toast('已切换：' + modeSel.options[modeSel.selectedIndex].text, 'success'))
        .catch((e) => HC.toast(e.message, 'error'));
    });

    root.appendChild(HC.el('div', { class: 'row nowrap glass' }, [
      HC.el('div', { class: 'block', style: 'flex:1;' }, [
        HC.el('div', { class: 'section-title', text: '追踪防护模式' }),
        HC.el('p', { class: 'note-text', style: 'margin-top:4px;', text: '「加固」会对 canvas / WebGL 指纹注入随机化，让网站在无痕/普通模式下难以识别你的设备。' }),
      ]),
      modeSel,
    ]));

    // 统计卡（api 按前缀归族：canvas-* / webgl-*）
    const family = (e) => String(e.api || '').split('-')[0];
    const canvasCount = events.filter((e) => family(e) === 'canvas').reduce((s, e) => s + e.count, 0);
    const webglCount = events.filter((e) => family(e) === 'webgl').reduce((s, e) => s + e.count, 0);
    const hosts = new Set(events.map((e) => e.host));
    const incognitoHits = events.filter((e) => e.incognito).length;

    const cards = HC.el('div', { class: 'stats-grid' });
    const mk = (v, l) => HC.el('div', { class: 'stat glass' }, [
      HC.el('div', { class: 'stat-value', text: String(v) }),
      HC.el('div', { class: 'stat-label', text: l }),
    ]);
    cards.appendChild(mk(hosts.size, '被探测域名数'));
    cards.appendChild(mk(canvasCount + webglCount, '指纹读取调用'));
    cards.appendChild(mk(incognitoHits, '无痕模式下调用'));
    cards.appendChild(mk(mode === 'shield' ? '已开启' : mode === 'off' ? '已关闭' : '仅监控', '防护模式'));
    root.appendChild(cards);

    // 追踪图谱：出现多次的第三方域名（跨站追踪候选）
    const hostCount = {};
    events.forEach((e) => {
      hostCount[e.host] = (hostCount[e.host] || 0) + 1;
    });
    const crossHosts = Object.entries(hostCount).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (crossHosts.length) {
      const box = HC.el('div', { class: 'row glass' }, [
        HC.el('div', { class: 'block', style: 'flex:1;width:100%;' }, [
          HC.el('div', { class: 'section-title', text: '跨站追踪图谱（同一域名被多次读取指纹）' }),
          HC.el('div', { class: 'bar-list', style: 'margin-top:8px;' }, crossHosts.map(([h, c]) =>
            HC.el('div', { class: 'bar-row' }, [
              HC.el('span', { class: 'bar-label', title: h, text: h }),
              HC.el('div', { class: 'bar-track' }, [
                HC.el('div', { class: 'bar-fill', style: `width:${Math.min(100, c * 8)}%;` }),
              ]),
              HC.el('span', { class: 'bar-val', text: String(c) }),
            ])
          )),
        ]),
      ]);
      root.appendChild(box);
    }

    // 风险清单（按风险等级排序）
    const sorted = [...events].sort((a, b) => riskOf(b.api).lv - riskOf(a.api).lv).slice(0, 30);
    const listBox = HC.el('div', { class: 'row glass' }, [
      HC.el('div', { class: 'block', style: 'flex:1;width:100%;' }, [
        HC.el('div', { class: 'section-title', text: '具体风险项（站点 × 指纹 API）' }),
        HC.el('div', { class: 'clean-list', style: 'margin-top:8px;max-height:260px;' }, [
          sorted.length ? sorted.map((e) => {
            const r = riskOf(e.api);
            return HC.el('div', { class: 'clean-item' }, [
              riskBadge(e.api),
              HC.el('div', { class: 'clean-body' }, [
                HC.el('div', { class: 'clean-head' }, [
                  HC.el('span', { class: 'clean-name', text: e.host }),
                  HC.el('span', { class: 'tag', text: e.incognito ? '无痕' : '普通' }),
                  HC.el('span', { class: 'tag', text: r.label }),
                ]),
                HC.el('div', { class: 'clean-detail', text: r.hint + ` — 调用 ${e.count} 次` }),
              ]),
            ]);
          }) : HC.el('div', { class: 'empty', text: '暂无记录——访问网站后自动采集' }),
        ]),
      ]),
    ]);
    root.appendChild(listBox);

    // 操作 + 说明
    root.appendChild(HC.el('div', { class: 'row glass' }, [
      HC.el('button', { class: 'btn', text: '清空记录', onclick: () => {
        HC.callBackground('PRIVACY_CLEAR').then(() => { HC.toast('已清空', 'success'); build(root); });
      } }),
      HC.el('p', { class: 'note-text', style: 'margin:0;flex:1;', text: '说明：无痕模式仅阻止本地持久化，网站在无痕下仍可用指纹识别设备。本模块监控 canvas / WebGL 指纹读取，「加固」可随机化这些指纹。UA / 字体等浏览器级指纹无法由脚本安全篡改。' }),
    ]));
  }
})();
