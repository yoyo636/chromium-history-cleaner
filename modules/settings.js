/* -------------------------------------------------------------------------
 * modules/settings.js — 偏好设置
 * - 主题：跟随系统 / 亮色 / 暗色（即时生效，持久化到 storage.local）
 * - 历史默认范围：今天 / 7 天 / 30 天 / 全部时间（下次打开历史页生效）
 * - 清理二次确认：开 / 关
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  HC.modules.settings = {
    render(container) {
      const root = HC.el('div', { class: 'view' });

      // 主题
      const themeSel = HC.el('select', { class: 'input opt-ctrl' });
      [
        ['system', '跟随系统'],
        ['light', '亮色'],
        ['dark', '暗色'],
      ].forEach(([v, l]) => themeSel.appendChild(HC.el('option', { value: v, text: l })));

      // 历史默认范围
      const rangeSel = HC.el('select', { class: 'input opt-ctrl' });
      [
        ['today', '今天'],
        ['7', '最近 7 天'],
        ['30', '最近 30 天'],
        ['all', '全部时间'],
      ].forEach(([v, l]) => rangeSel.appendChild(HC.el('option', { value: v, text: l })));

      // 清理二次确认
      const confirmChk = HC.el('input', { type: 'checkbox' });

      // 开发者模式（篡改功能总开关，密码校验在 background）
      const devBtn = HC.el('button', { class: 'mini', text: '…', onclick: toggleDev });
      function refreshDevBtn(on) {
        devBtn.textContent = on ? '关闭开发者模式' : '开启开发者模式';
        devBtn.style.background = on ? 'rgba(229, 57, 53, 0.12)' : '';
        devBtn.style.color = on ? '#e53935' : '';
      }
      async function toggleDev() {
        const cur = await new Promise((res) => chrome.storage.local.get({ devMode: false }, (r) => res(!!r.devMode)));
        const pass = await HC.prompt({
          title: cur ? '关闭开发者模式' : '开启开发者模式',
          body: cur ? '再次输入相同密码即可关闭' : '输入开发者密码以启用「篡改」功能',
          placeholder: '密码',
        });
        if (pass == null || !pass) return;
        chrome.runtime.sendMessage({ type: 'TAMPER_SET_DEV', payload: { on: !cur, pass } }, (resp) => {
          if (chrome.runtime.lastError) return HC.toast(chrome.runtime.lastError.message, 'error');
          if (resp && resp.ok) {
            HC.toast(!cur ? '开发者模式已开启，可在「更多 → 开发者·篡改」使用' : '开发者模式已关闭', 'success');
            refreshDevBtn(!cur);
          } else HC.toast((resp && resp.error) || '密码错误', 'error');
        });
      }

      const saveBtn = HC.el('button', { class: 'btn btn-primary', text: '保存设置', onclick: save });

      root.appendChild(
        HC.el('div', { class: 'opt-list' }, [
          HC.el('div', { class: 'opt-row' }, [
            HC.el('div', { class: 'opt-info' }, [
              HC.el('div', { class: 'opt-name', text: '界面主题' }),
              HC.el('div', { class: 'opt-desc', text: '默认跟随系统，可强制亮 / 暗' }),
            ]),
            themeSel,
          ]),
          HC.el('div', { class: 'opt-row' }, [
            HC.el('div', { class: 'opt-info' }, [
              HC.el('div', { class: 'opt-name', text: '历史默认范围' }),
              HC.el('div', { class: 'opt-desc', text: '打开「历史」页时默认查询的时间范围' }),
            ]),
            rangeSel,
          ]),
          HC.el('div', { class: 'opt-row' }, [
            HC.el('div', { class: 'opt-info' }, [
              HC.el('div', { class: 'opt-name', text: '清理二次确认' }),
              HC.el('div', { class: 'opt-desc', text: '执行清理 / 删除前是否弹窗确认（建议保持开启）' }),
            ]),
            HC.el('label', { class: 'chk opt-ctrl' }, [confirmChk, HC.el('span', { text: '开启确认' })]),
          ]),
          HC.el('div', { class: 'opt-row' }, [
            HC.el('div', { class: 'opt-info' }, [
              HC.el('div', { class: 'opt-name', text: '开发者模式（篡改）' }),
              HC.el('div', { class: 'opt-desc', text: '启用「更多 → 开发者·篡改」模块，可修改历史 / 书签 / 下载 / Cookie' }),
            ]),
            devBtn,
          ]),
        ])
      );
      root.appendChild(saveBtn);
      container.appendChild(root);

      function save() {
        const prefs = {
          theme: themeSel.value,
          defRange: rangeSel.value,
          cleanupConfirm: confirmChk.checked,
        };
        HC.setPrefs(prefs).then(() => {
          HC.applyTheme(prefs.theme); // 即时生效
          HC.toast('设置已保存', 'success');
        });
      }

      // 载入当前偏好
      HC.getPrefs().then((prefs) => {
        themeSel.value = prefs.theme;
        rangeSel.value = prefs.defRange;
        confirmChk.checked = !!prefs.cleanupConfirm;
      });
      chrome.storage.local.get({ devMode: false }, (r) => refreshDevBtn(!!r.devMode));
    },
  };
})();
