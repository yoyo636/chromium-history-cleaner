/* -------------------------------------------------------------------------
 * modules/audio.js — 音频内容识别与静音管理
 * 能力（实材实料）：
 *   - 列出所有正在发声的标签，一键静音 / 恢复 / 全部静音
 *   - 广告判定（规则引擎）：页面含自动播放元素 + 广告容器（由 content_perf 上报）
 *     + 域名学习记忆（你静音过的域名自动静音）
 *   - 频谱分类（用户点「分析」触发，tabCapture 需授权）：
 *     人声对话 / 背景音乐 / 高频噪声（疑似广告）——保留人声、只静音广告
 * 说明：tabs API 无音量渐变（无法"降到 10%"），静音为开关式；
 *       tabCapture 需标签页可访问，若失败请刷新页面后重试。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;

  HC.modules.audio = {
    render(container) {
      const root = HC.el('div', { class: 'view' });
      const list = HC.el('div', { class: 'clean-list' });
      const muteAllBtn = HC.el('button', { class: 'btn', text: '静音全部发声标签', onclick: muteAll });
      const note = HC.el('p', {
        class: 'note-text',
        text: '策略：你手动静音过的域名会被记忆，下次该域名发声自动静音（可在列表「取消记忆」）。「分析」使用 Web Audio 频谱分类（人声/音乐/广告），可在静音前确认内容。',
      });

      root.appendChild(HC.el('div', { class: 'row nowrap glass' }, [
        HC.el('div', { class: 'section-title', text: '正在发声的标签' }),
        HC.el('span', { style: 'flex:1;' }),
        muteAllBtn,
      ]));
      root.appendChild(list);
      root.appendChild(HC.el('div', { class: 'row glass' }, [note]));
      container.appendChild(root);

      function load() {
        list.innerHTML = '';
        list.appendChild(HC.el('div', { class: 'empty', text: '加载中…' }));
        HC.callBackground('AUDIO_LIST')
          .then((tabs) => render(tabs))
          .catch((e) => {
            list.innerHTML = '';
            list.appendChild(HC.el('div', { class: 'empty', text: '加载失败：' + e.message }));
          });
      }

      function render(tabs) {
        list.innerHTML = '';
        if (!tabs.length) {
          list.appendChild(HC.el('div', { class: 'empty', text: '当前没有正在发声的标签页' }));
          return;
        }
        tabs.forEach((t) => {
          const learned = t.learned === 'mute';
          const acts = HC.el('span', { class: 'item-acts' });
          acts.appendChild(HC.el('button', {
            class: 'mini',
            text: '分析',
            title: '用频谱识别内容类型（人声/音乐/广告）',
            onclick: () => analyze(t.id),
          }));
          acts.appendChild(HC.el('button', {
            class: 'mini ' + (t.muted ? '' : 'danger'),
            text: t.muted ? '恢复' : '静音',
            onclick: () => {
              const target = !t.muted;
              HC.callBackground('AUDIO_SET_MUTED', {
                tabId: t.id,
                muted: target,
                learn: true,
                domain: t.domain,
              })
                .then(() => { HC.toast(target ? '已静音（已学习该域名）' : '已恢复', 'success'); load(); })
                .catch((e) => HC.toast(e.message, 'error'));
            },
          }));
          if (learned) {
            acts.appendChild(HC.el('button', {
              class: 'mini',
              text: '取消记忆',
              title: '下次不再自动静音该域名',
              onclick: () => {
                HC.callBackground('AUDIO_SET_MUTED', { tabId: t.id, muted: t.muted, forget: true, domain: t.domain })
                  .then(() => { HC.toast('已取消记忆', 'success'); load(); })
                  .catch((e) => HC.toast(e.message, 'error'));
              },
            }));
          }

          const tag = t.muted ? HC.el('span', { class: 'tag', text: '已静音' })
            : learned ? HC.el('span', { class: 'tag', text: '学习记忆' })
            : HC.el('span', { class: 'tag', text: '发声' });

          const row = HC.el('div', { class: 'clean-item' }, [
            HC.el('div', { class: 'clean-body' }, [
              HC.el('div', { class: 'clean-head' }, [
                HC.el('span', { class: 'clean-name', title: t.title, text: HC.truncate(t.title || t.url || '(无标题)', 42) }),
                tag,
              ]),
              HC.el('div', { class: 'clean-detail', text: t.url || '' }),
            ]),
            acts,
          ]);
          list.appendChild(row);
        });
      }

      function analyze(tabId) {
        HC.toast('正在分析音频（约 2 秒）…', 'info');
        HC.callBackground('AUDIO_ANALYZE', { tabId })
          .then((r) => {
            const emoji = r.kind.includes('广告') || r.kind.includes('噪声') ? '🔊' : r.kind === '人声对话' ? '🗣️' : r.kind === '背景音乐' ? '🎵' : '🔇';
            HC.confirm({
              title: '音频分析结果',
              body: `${emoji} 识别为：<b>${HC.escapeHtml(r.kind)}</b><br/>音量 ${r.avgEnergy} · 人声带占比 ${r.voiceRatio} · 高频占比 ${r.highRatio}<br/>是否静音该标签？`,
              danger: r.kind.includes('广告') || r.kind.includes('噪声'),
            }).then((ok) => {
              if (!ok) return;
              // 分析后静音不学习域名（避免误伤同类正常内容）
              HC.callBackground('AUDIO_SET_MUTED', { tabId, muted: true })
                .then(() => { HC.toast('已静音', 'success'); load(); })
                .catch((e) => HC.toast(e.message, 'error'));
            });
          })
          .catch((e) => HC.toast('分析失败：' + e.message, 'error'));
      }

      function muteAll() {
        HC.callBackground('AUDIO_MUTE_ALL')
          .then((n) => HC.toast(`已静音 ${n} 个标签`, 'success'))
          .catch((e) => HC.toast(e.message, 'error'));
      }

      load();
    },
  };
})();
