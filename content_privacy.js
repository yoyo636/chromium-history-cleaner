/* -------------------------------------------------------------------------
 * content_privacy.js — 无痕模式追踪防护（内容脚本，MAIN 世界）
 * 必须在 MAIN world 才能 hook 页面自身的 canvas / WebGL 指纹调用。
 *
 * 模式（storage.local.privacyMode，与 background / popup 保持一致）：
 *   - monitor（默认）：被动记录指纹 API 调用（不改动页面行为）
 *   - shield：对 canvas / WebGL 指纹读出结果加噪（一键加固）
 *   - off：完全关闭
 *
 * 设计要点：
 *   - 只 hook「读取类」方法（getImageData / toDataURL / toBlob /
 *     getParameter / readPixels），不改写 getContext 原型——
 *     创建上下文不是指纹行为，读取像素才是；且避免页面以
 *     getContext.toString() 检测环境异常。
 *   - shield 下 toDataURL / toBlob 返回「真实内容 + 小幅噪声」的
 *     离屏副本，不破坏图片导出 / 图表下载等正常功能。
 *
 * 说明（如实标注能力边界）：
 *   - UA / 字体测量等浏览器级指纹 → 脚本无法安全篡改，仅记录上报
 * ------------------------------------------------------------------------- */

'use strict';

(() => {
  if (window.__privacyLoaded) return;
  window.__privacyLoaded = true;

  const HOST = location.hostname;
  let mode = 'monitor';
  let internalOp = false; // shield 内部离屏操作时置位，避免重复上报 / 双重加噪

  /* ---------- 模式读取与切换 ---------- */
  function syncMode() {
    chrome.storage.local.get({ privacyMode: 'monitor' }, (r) => {
      mode = r.privacyMode || 'monitor';
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.privacyMode) {
      mode = changes.privacyMode.newValue || 'monitor';
    }
  });

  function shieldActive() {
    return mode === 'shield';
  }

  function report(api, extra) {
    if (mode === 'off' || internalOp) return;
    try {
      chrome.runtime.sendMessage({
        type: 'PRIVACY_EVENT',
        payload: { api, host: HOST, ts: Date.now(), extra: extra || '' },
      });
    } catch (_e) {
      /* 忽略 */
    }
  }

  /* ---------- 像素噪声 ---------- */
  function addNoise(data) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (data[i] + ((Math.random() * 8) | 0) - 4) & 0xff;
      data[i + 1] = (data[i + 1] + ((Math.random() * 8) | 0) - 4) & 0xff;
    }
  }

  /* =====================================================================
   * Canvas 2D：getImageData
   * ===================================================================== */
  if (typeof CanvasRenderingContext2D !== 'undefined') {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function () {
      const img = origGetImageData.apply(this, arguments);
      report('canvas-getImageData');
      if (shieldActive() && !internalOp) addNoise(img.data);
      return img;
    };
    if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
      const origOffGetImageData = OffscreenCanvasRenderingContext2D.prototype.getImageData;
      OffscreenCanvasRenderingContext2D.prototype.getImageData = function () {
        const img = origOffGetImageData.apply(this, arguments);
        report('canvas-getImageData');
        if (shieldActive() && !internalOp) addNoise(img.data);
        return img;
      };
    }
  }

  /* =====================================================================
   * Canvas：toDataURL / toBlob
   * shield 下返回真实内容的加噪离屏副本（保留正常导出功能）
   * ===================================================================== */
  function noisyCopy(canvas) {
    internalOp = true;
    try {
      const off = document.createElement('canvas');
      off.width = canvas.width;
      off.height = canvas.height;
      const octx = off.getContext('2d');
      octx.drawImage(canvas, 0, 0);
      const img = octx.getImageData(0, 0, off.width, off.height);
      addNoise(img.data);
      octx.putImageData(img, 0, 0);
      return off;
    } finally {
      internalOp = false;
    }
  }

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (type) {
    report('canvas-toDataURL');
    if (!shieldActive()) return origToDataURL.apply(this, arguments);
    try {
      const off = noisyCopy(this);
      internalOp = true;
      try {
        return origToDataURL.apply(off, arguments);
      } finally {
        internalOp = false;
      }
    } catch (_e) {
      // 画布被跨域内容污染（tainted）时回退原始行为
      return origToDataURL.apply(this, arguments);
    }
  };

  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
    report('canvas-toBlob');
    if (!shieldActive()) return origToBlob.apply(this, arguments);
    try {
      const off = noisyCopy(this);
      internalOp = true;
      try {
        return origToBlob.call(off, callback, type, quality);
      } finally {
        internalOp = false;
      }
    } catch (_e) {
      return origToBlob.apply(this, arguments);
    }
  };

  if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.convertToBlob) {
    const origConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = function (options) {
      report('canvas-convertToBlob');
      // OffscreenCanvas 无法 drawImage 到普通画布之外再加噪回写，
      // 此处仅监控；篡改离屏渲染结果会破坏 WebGL/图表正常工作，如实不加固。
      return origConvertToBlob.apply(this, arguments);
    };
  }

  /* =====================================================================
   * WebGL：getParameter（厂商 / 渲染器字符串随机化）
   * ===================================================================== */
  const GL_VENDOR = 0x1f00; // 7936
  const GL_RENDERER = 0x1f01; // 7937
  const GL_UNMASKED_VENDOR = 0x9245; // WEBGL_debug_renderer_info
  const GL_UNMASKED_RENDERER = 0x9246;

  function hookWebGLProto(proto) {
    if (!proto || proto.__privacyHooked) return;
    proto.__privacyHooked = true;

    const origGetParameter = proto.getParameter;
    proto.getParameter = function (pname) {
      const v = origGetParameter.apply(this, arguments);
      if (
        pname === GL_VENDOR ||
        pname === GL_RENDERER ||
        pname === GL_UNMASKED_VENDOR ||
        pname === GL_UNMASKED_RENDERER
      ) {
        report('webgl-getParameter');
        if (shieldActive()) return String(v) + ' (shielded ' + ((Math.random() * 999) | 0) + ')';
      }
      return v;
    };

    const origReadPixels = proto.readPixels;
    proto.readPixels = function (x, y, w, h, format, type, pixels) {
      const r = origReadPixels.apply(this, arguments);
      report('webgl-readPixels');
      if (shieldActive() && pixels && pixels.length) {
        const step = pixels.BYTES_PER_ELEMENT === 4 ? 4 : 1;
        for (let i = 0; i < pixels.length; i += 4 * step) {
          pixels[i] = (pixels[i] + ((Math.random() * 8) | 0) - 4) & 0xff;
        }
      }
      return r;
    };
  }

  hookWebGLProto(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext.prototype : null);
  hookWebGLProto(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null);

  syncMode();
})();
