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
    },
  };
})();
