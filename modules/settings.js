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
        ['dark', '深色玻璃（推荐）'],
        ['light', '浅色玻璃'],
        ['system', '跟随系统'],
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

      /* 房地产开发：密码解锁的隐藏工具集（房贷 / 税费 / 租金回报），再次输入同密码关闭 */
      const reBtn = HC.el('button', { class: 'mini', text: '…', onclick: toggleReEstate });
      function refreshReBtn(on) {
        reBtn.textContent = on ? '关闭房地产开发' : '开启房地产开发';
        reBtn.style.background = on ? 'rgba(63, 206, 143, 0.12)' : '';
        reBtn.style.color = on ? 'var(--success)' : '';
      }
      async function toggleReEstate() {
        const cur = await new Promise((res) =>
          chrome.storage.local.get({ reEstateUnlocked: false }, (r) => res(!!r.reEstateUnlocked)));
        const pass = await HC.prompt({
          title: cur ? '关闭房地产开发' : '开启房地产开发',
          body: cur ? '再次输入相同密码即可关闭' : '输入访问密码以启用房地产开发工具（入口出现在「更多」面板）',
          placeholder: '密码',
        });
        if (pass == null || !pass) return;
        chrome.runtime.sendMessage({ type: 'RE_SET_UNLOCK', payload: { on: !cur, pass } }, (resp) => {
          if (chrome.runtime.lastError) return HC.toast(chrome.runtime.lastError.message, 'error');
          if (resp && resp.ok) {
            HC.toast(cur ? '房地产开发已关闭' : '已解锁：入口在「更多 → 房地产开发」', 'success');
            refreshReBtn(!cur);
            if (window.__refreshMorePanel) window.__refreshMorePanel();
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
          HC.el('div', { class: 'opt-row' }, [
            HC.el('div', { class: 'opt-info' }, [
              HC.el('div', { class: 'opt-name', text: '房地产开发' }),
              HC.el('div', { class: 'opt-desc', text: '启用「更多 → 房地产开发」工具集：房贷计算 / 交易税费 / 租金回报。输入密码开启，再次输入同密码关闭。' }),
            ]),
            reBtn,
          ]),
        ])
      );
      root.appendChild(saveBtn);

      /* ---------- 数据随身带：导出 / 导入 ----------
       * 导出：hcPrefs / sessions / audioLearned / eyecare / privacyMode /
       *       tamperAuto / focusBlocklist（排除 devMode 等敏感与临时键）
       * 导入：JSON 校验（app 标识）后写回 storage.local，弹窗自动刷新
       */
      const EXPORT_KEYS = ['hcPrefs', 'sessions', 'audioLearned', 'eyecare', 'privacyMode', 'tamperAuto', 'focusBlocklist'];
      const fileIn = HC.el('input', { type: 'file', accept: '.json,application/json', style: 'display:none;' });
      fileIn.addEventListener('change', () => {
        const file = fileIn.files && fileIn.files[0];
        fileIn.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          let obj;
          try { obj = JSON.parse(reader.result); } catch { return HC.toast('文件不是有效 JSON', 'error'); }
          if (!obj || obj.app !== 'browser-companion' || !obj.data) return HC.toast('不是本扩展的备份文件', 'error');
          const data = {};
          EXPORT_KEYS.forEach((k) => { if (obj.data[k] !== undefined) data[k] = obj.data[k]; });
          chrome.storage.local.set(data, () => {
            HC.toast('导入成功，正在刷新…', 'success');
            setTimeout(() => location.reload(), 600);
          });
        };
        reader.readAsText(file);
      });
      const exportBtn = HC.el('button', {
        class: 'btn btn-primary',
        text: '⬇ 导出数据',
        onclick: async () => {
          const data = await new Promise((r) => chrome.storage.local.get(EXPORT_KEYS, (x) => r(x)));
          const payload = {
            app: 'browser-companion',
            version: chrome.runtime.getManifest().version,
            exportedAt: new Date().toISOString(),
            data,
          };
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = HC.el('a', { href: url, download: 'browser-companion-backup-' + new Date().toISOString().slice(0, 10) + '.json' });
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          HC.toast('已导出（不含密码类数据）', 'success');
        },
      });
      const importBtn = HC.el('button', {
        class: 'btn',
        text: '⬆ 导入数据',
        onclick: () => fileIn.click(),
      });
      root.appendChild(
        HC.el('div', { class: 'opt-list', style: 'margin-top:12px;' }, [
          HC.el('div', { class: 'opt-row' }, [
            HC.el('div', { class: 'opt-info' }, [
              HC.el('div', { class: 'opt-name', text: '数据随身带' }),
              HC.el('div', { class: 'opt-desc', text: '导出偏好 / 会话 / 学习记录 / 护眼曲线 / 专注黑名单为 JSON；导入后自动刷新。换浏览器 30 秒还原。' }),
            ]),
          ]),
          HC.el('div', { class: 'opt-row' }, [exportBtn, importBtn, fileIn]),
        ])
      );

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
      chrome.storage.local.get({ devMode: false, reEstateUnlocked: false }, (r) => {
        refreshDevBtn(!!r.devMode);
        refreshReBtn(!!r.reEstateUnlocked);
      });
    },
  };
})();
