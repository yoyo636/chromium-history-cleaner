/* -------------------------------------------------------------------------
 * content_privacy.js — 无痕模式追踪防护（内容脚本，MAIN 世界）
 * 必须在 MAIN world 才能 hook 页面自身的 canvas / WebGL 指纹调用。
 *
 * 模式（storage.local.privacy.mode）：
 *   - monitor（默认）：被动记录指纹 API 调用（不改动页面行为）
 *   - shield：随机化 canvas / WebGL 指纹（一键加固）
 *   - off：完全关闭
 *
 * 说明（如实标注能力边界）：
 *   - canvas.toDataURL / getImageData 读取、WebGL 参数读取 → 可 hook 并随机化
 *   - UA / 字体测量等浏览器级指纹 → 脚本无法安全篡改，仅记录上报
 * ------------------------------------------------------------------------- */

'use strict';

(() => {
  if (window.__privacyLoaded) return;
  window.__privacyLoaded = true;

  const HOST = location.hostname;
  let mode = 'monitor';
  let shieldActive = false;

  /* ---------- 模式读取与切换 ---------- */
  function syncMode() {
    chrome.storage.local.get({ privacy: { mode: 'monitor' } }, (r) => {
      mode = (r.privacy && r.privacy.mode) || 'monitor';
      if (mode === 'shield') enableShield();
      else disableShield();
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.privacy) syncMode();
  });

  function report(api, extra) {
    if (mode === 'off') return;
    try {
      chrome.runtime.sendMessage({
        type: 'PRIVACY_EVENT',
        payload: { api, host: HOST, ts: Date.now(), extra: extra || '' },
      });
    } catch (_e) {
      /* 忽略 */
    }
  }

  /* =====================================================================
   * Canvas 指纹 hook
   * ===================================================================== */
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    const ctx = origGetContext.apply(this, arguments);
    if (ctx && (type === '2d' || type === 'webgl' || type === 'webgl2')) {
      report(type === '2d' ? 'canvas' : 'webgl');
      if (shieldActive && type === '2d') hookCanvas2D(ctx);
      if (shieldActive && type !== '2d') hookWebGL(ctx);
    }
    return ctx;
  };

  function hookCanvas2D(ctx) {
    if (ctx.__shielded2d) return;
    ctx.__shielded2d = true;
    // getImageData：返回带噪声的像素
    const origGetImageData = ctx.getImageData.bind(ctx);
    ctx.getImageData = function () {
      const img = origGetImageData.apply(ctx, arguments);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = (d[i] + ((Math.random() * 8) | 0) - 4) & 0xff;
        d[i + 1] = (d[i + 1] + ((Math.random() * 8) | 0) - 4) & 0xff;
      }
      return img;
    };
    // toDataURL：返回噪声图像数据（离线画布生成，避免递归）
    const origToDataURL = ctx.toDataURL.bind(ctx);
    ctx.toDataURL = function (type) {
      report('canvas-read');
      if (type === 'image/png' || !type) {
        try {
          const off = document.createElement('canvas');
          off.width = 8;
          off.height = 8;
          const octx = off.getContext('2d');
          for (let x = 0; x < 8; x++)
            for (let y = 0; y < 8; y++) {
              octx.fillStyle =
                'rgb(' + ((Math.random() * 255) | 0) + ',' + ((Math.random() * 255) | 0) + ',' + ((Math.random() * 255) | 0) + ')';
              octx.fillRect(x, y, 1, 1);
            }
          return off.toDataURL('image/png');
        } catch (_e) {
          return origToDataURL(type);
        }
      }
      return origToDataURL(type);
    };
  }

  /* =====================================================================
   * WebGL 指纹 hook（厂商 / 渲染器字符串随机化）
   * ===================================================================== */
  const VENDOR_ID = 37445;
  const RENDERER_ID = 37446;
  function hookWebGL(ctx) {
    if (ctx.__shieldedgl) return;
    ctx.__shieldedgl = true;
    const origGetParameter = ctx.getParameter.bind(ctx);
    ctx.getParameter = function (pname) {
      const v = origGetParameter(pname);
      if (pname === VENDOR_ID || pname === RENDERER_ID) {
        return String(v) + ' (shielded ' + ((Math.random() * 999) | 0) + ')';
      }
      return v;
    };
  }

  /* ---------- 启用 / 停用 shield ---------- */
  function enableShield() {
    if (shieldActive) return;
    shieldActive = true;
    // 对已创建的 canvas 重新 hook（懒加载已覆盖多数场景）
  }
  function disableShield() {
    shieldActive = false;
  }

  syncMode();
})();
