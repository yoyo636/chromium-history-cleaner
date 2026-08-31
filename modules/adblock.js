/* -------------------------------------------------------------------------
 * modules/adblock.js — 广告拦截（弹窗控制面板）
 * 两层拦截：网络层（declarativeNetRequest 静态规则集）+ 外观层（content_adblock.js 隐藏容器）
 * 控制：总开关、按站点白名单、今日/累计拦截计数。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  function curDomain(cb) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const t = (tabs || [])[0];
        let d = '';
        if (t && t.url) {
          try { d = new URL(t.url).hostname.replace(/^www\./, ''); } catch (e) {}
        }
        cb(d || '');
      });
    } catch (e) { cb(''); }
  }

  function rowEl(label, val, big) {
    return HC.el('div', { class: 'opt-row' }, [
      HC.el('div', { class: 'opt-info' }, [HC.el('div', { class: 'opt-name', text: label })]),
      HC.el('div', {
        class: big ? 'score-num' : 'opt-name',
        style: big ? 'font-size:22px;color:var(--accent);' : 'color:var(--text);',
        text: String(val),
      }),
    ]);
  }

  HC.modules.adblock = {
    render(container) {
      const root = HC.el('div', { class: 'view' });

      const state = { enabled: true, allow: [], today: 0, total: 0, rulesetOn: true };
      let domain = '';

      const toggle = HC.el('input', { type: 'checkbox' });
      toggle.checked = true;

      const statsBox = HC.el('div', { class: 'opt-list' });
      const siteBox = HC.el('div', { class: 'row glass', style: 'display:block;padding:14px;' });
      const noteBox = HC.el('div', { class: 'opt-desc', style: 'margin-top:10px;font-size:11.5px;' });

      // 顶部开关卡
      const head = HC.el('div', { class: 'row glass', style: 'display:block;padding:14px;' }, [
        HC.el('div', { class: 'opt-row' }, [
          HC.el('div', { class: 'opt-info' }, [
            HC.el('div', { class: 'opt-name', text: '🚫 广告拦截' }),
            HC.el('div', { class: 'opt-desc', style: 'margin-top:2px;',
              text: '网络层拦截广告/追踪请求 + 外观层隐藏页面广告容器。' }),
          ]),
          HC.el('label', { class: 'switch' }, [
            toggle,
            HC.el('span', { class: 'slider' }),
          ]),
        ]),
        statsBox,
      ]);

      function refreshStats() {
        statsBox.innerHTML = '';
        statsBox.appendChild(rowEl('今日拦截', state.today.toLocaleString('zh-CN'), true));
        statsBox.appendChild(rowEl('累计拦截', state.total.toLocaleString('zh-CN')));
        statsBox.appendChild(rowEl('规则引擎', state.rulesetOn ? '已启用（DNR）' : '当前浏览器不支持'));
      }

      function refreshSite() {
        siteBox.innerHTML = '';
        if (!domain) {
          siteBox.appendChild(HC.el('div', { class: 'opt-name', text: '当前站点' }));
          siteBox.appendChild(HC.el('div', { class: 'opt-desc', style: 'margin-top:4px;',
            text: '打开一个网页后再回到这里，可对该站点单独放行广告。' }));
          return;
        }
        const allowed = state.allow.includes(domain);
        siteBox.appendChild(HC.el('div', { class: 'opt-row' }, [
          HC.el('div', { class: 'opt-info' }, [
            HC.el('div', { class: 'opt-name', text: '当前站点' }),
            HC.el('div', { class: 'opt-desc', style: 'margin-top:2px;', text: domain }),
          ]),
          HC.el('button', {
            class: 'btn ' + (allowed ? 'btn-ghost' : 'btn-primary'),
            text: allowed ? '已放行 · 点此恢复拦截' : '在此站点允许广告',
            onclick: () => {
              if (allowed) {
                HC.callBackground('ADBLOCK_UNALLOW', { domain })
                  .then((r) => { state.allow = r.allow; refreshSite(); HC.toast('已恢复拦截：' + domain); })
                  .catch((e) => HC.toast('操作失败：' + e.message, 'error'));
              } else {
                HC.callBackground('ADBLOCK_ALLOW', { domain })
                  .then((r) => { state.allow = r.allow; refreshSite(); HC.toast('已允许广告：' + domain); })
                  .catch((e) => HC.toast('操作失败：' + e.message, 'error'));
              }
            },
          }),
        ]));

        // 白名单列表
        if (state.allow.length) {
          siteBox.appendChild(HC.el('div', { class: 'section-title', style: 'margin-top:10px;', text: '放行名单' }));
          const list = HC.el('div', { class: 'opt-list' });
          state.allow.forEach((d) => {
            list.appendChild(HC.el('div', { class: 'opt-row' }, [
              HC.el('div', { class: 'opt-name', text: d }),
              HC.el('button', {
                class: 'btn btn-ghost', style: 'padding:3px 10px;font-size:12px;',
                text: '移除',
                onclick: () => {
                  HC.callBackground('ADBLOCK_UNALLOW', { domain: d })
                    .then((r) => { state.allow = r.allow; refreshSite(); })
                    .catch((e) => HC.toast('操作失败：' + e.message, 'error'));
                },
              }),
            ]));
          });
          siteBox.appendChild(list);
        }
      }

      toggle.addEventListener('change', () => {
        HC.callBackground('ADBLOCK_TOGGLE', { on: toggle.checked })
          .then((r) => { state.enabled = r.enabled; HC.toast(r.enabled ? '广告拦截已开启' : '广告拦截已关闭'); })
          .catch((e) => { toggle.checked = !toggle.checked; HC.toast('操作失败：' + e.message, 'error'); });
      });

      function load() {
        HC.callBackground('ADBLOCK_GET', {})
          .then((s) => {
            state.enabled = s.enabled; state.allow = s.allow || [];
            state.today = s.today || 0; state.total = s.total || 0; state.rulesetOn = s.rulesetOn;
            toggle.checked = state.enabled;
            refreshStats();
            curDomain((d) => { domain = d; refreshSite(); });
          })
          .catch((e) => {
            root.appendChild(HC.el('div', { class: 'empty', text: '加载失败：' + e.message }));
          });
      }

      noteBox.textContent = '说明：网络层在请求发出前拦截常见广告/追踪域名；外观层在页面内隐藏已渲染的广告容器。'
        + '拦截计数以「页面广告元素」为主，网络层拦截不单独计数。白名单仅对当前站点放行，不影响全局。';

      root.appendChild(head);
      root.appendChild(siteBox);
      root.appendChild(HC.el('div', { class: 'row glass', style: 'display:block;padding:12px;' }, [noteBox]));
      container.appendChild(root);
      load();
    },
  };
})();
