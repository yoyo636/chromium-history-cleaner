/* -------------------------------------------------------------------------
 * content_perf.js — 标签页性能透视（内容脚本，隔离世界）
 *
 * 采集（替代已废弃的 chrome.processes，全部为真实可读指标）：
 *   - CPU 繁忙度：PerformanceObserver(longtask) 统计长任务时长占比（0-100%）
 *   - 内存：performance.memory.usedJSHeapSize（Chromium 特有，JS 堆近似值）
 *   - 渲染压力代理：requestAnimationFrame 帧率估算（帧率低 → 渲染/GPU 忙）
 *   - 归因：longtask 的 attribution 提取高频执行脚本 URL
 *   - 音频：页面自动播放元素 / 广告容器数量（供音频模块规则判定）
 * 每 60 秒经 background 汇总（sender.tab 定位标签）。
 * ------------------------------------------------------------------------- */

'use strict';

(() => {
  if (window.__perfLoaded) return;
  window.__perfLoaded = true;

  const REPORT_MS = 60000;

  /* ---------- CPU 繁忙度：长任务 ---------- */
  let longTaskMs = 0;
  let longTaskCount = 0;
  const attribMap = new Map();

  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTaskCount++;
        longTaskMs += e.duration;
        (e.attribution || []).forEach((a) => {
          if (a.scriptingUrl) {
            attribMap.set(a.scriptingUrl, (attribMap.get(a.scriptingUrl) || 0) + 1);
          }
        });
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch (_e) {
    /* 不支持 longtask 时忽略 */
  }

  /* ---------- 帧率估算（渲染/GPU 压力代理） ----------
   * rAF 在隐藏标签页会被浏览器节流/暂停，fps 会读到一个失真的陈旧值。
   * 可见时才采样；重新可见时重置窗口，避免把暂停时长算成一帧的超长间隔。 */
  let fps = 60;
  let frames = 0;
  let lastFpsAt = performance.now();
  function tickFps() {
    if (document.hidden) return; // 暂停；visibilitychange 可见时重启
    frames++;
    const now = performance.now();
    if (now - lastFpsAt >= 1000) {
      fps = Math.round((frames * 1000) / (now - lastFpsAt));
      frames = 0;
      lastFpsAt = now;
    }
    requestAnimationFrame(tickFps);
  }
  function startFps() {
    frames = 0;
    lastFpsAt = performance.now();
    requestAnimationFrame(tickFps);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) startFps(); }, { passive: true });
  startFps();

  /* ---------- 内存 ---------- */
  function readHeap() {
    try {
      return performance.memory ? performance.memory.usedJSHeapSize : 0;
    } catch (_e) {
      return 0;
    }
  }

  /* ---------- 音频 / 广告判定辅助 ---------- */
  function detectMedia() {
    let autoplay = 0;
    let adContainers = 0;
    try {
      document
        .querySelectorAll('video[autoplay], video[autoplay=""], audio[autoplay], audio[autoplay=""]')
        .forEach(() => autoplay++);
      const adSelectors = '[id*="ad-"], [id*="ad_"], [class*="ad-"], [class*="ad_"], [class*="ads"], [id*="advert"], [class*="advert"]';
      document.querySelectorAll(adSelectors).forEach((n) => {
        const r = n.getBoundingClientRect();
        if (r.width > 40 && r.height > 20) adContainers++;
      });
    } catch (_e) {
      /* 忽略 */
    }
    return { autoplay, adContainers };
  }

  /* ---------- 上报 ---------- */
  function report() {
    const longTasks = longTaskCount; // 先快照再清零（旧版清零后才读 → 上报恒为 0）
    const busy = Math.min(100, Math.round((longTaskMs / (REPORT_MS * 0.9)) * 100));
    const heap = readHeap();
    const attrib = [...attribMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([url, count]) => ({ url, count }));
    const media = detectMedia();
    longTaskMs = 0;
    longTaskCount = 0;
    attribMap.clear();
    try {
      chrome.runtime.sendMessage({
        type: 'PERFORM_REPORT',
        payload: { busy, longTasks, heap, fps, attrib, media },
      });
    } catch (_e) {
      /* 后台不可达时忽略 */
    }
  }

  setInterval(report, REPORT_MS);
})();


/* -------------------------------------------------------------------------
 * 音频频谱分类（由 background 触发：用户点「分析音频」后获取流）
 * 规则引擎：基于 AnalyserNode 频谱特征区分 静音/人声/音乐/广告噪声
 * ------------------------------------------------------------------------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'AUDIO_ANALYZE') {
    analyzeStream(msg.streamId).then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: err.message })
    );
    return true; // 异步响应
  }
});

function analyzeStream(streamId) {
  return new Promise((resolve, reject) => {
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      })
      .then((stream) => {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
          stream.getTracks().forEach((t) => t.stop());
          return reject(new Error('当前浏览器不支持 AudioContext'));
        }
        const ctx = new AudioCtx();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        src.connect(analyser);
        const freq = new Uint8Array(analyser.frequencyBinCount);
        const samples = 30; // 采样 30 帧（约 1.5 秒）

        // 累加频谱统计
        let frames = 0;
        let totalEnergy = 0;
        let voiceEnergy = 0; // 200-3400Hz（人声区）
        let highEnergy = 0; // 8kHz+（高频噪声/广告剪辑）
        let lowEnergy = 0; // <200Hz
        const bins = analyser.frequencyBinCount;
        const nyquist = ctx.sampleRate / 2;
        /* 频段对应的 bin 数随 sampleRate 变化——旧版用魔数 17/21/5 估算，
         * 48kHz 与 44.1kHz 设备上结果会漂移。按实际 nyquist 精确计算。 */
        const binPerHz = bins / nyquist;
        const voiceBins = Math.max(1, Math.ceil(3400 * binPerHz) - Math.floor(200 * binPerHz));
        const highBins = Math.max(1, bins - Math.floor(8000 * binPerHz));
        const lowBins = Math.max(1, Math.floor(200 * binPerHz));

        function sample() {
          analyser.getByteFrequencyData(freq);
          let v = 0, h = 0, l = 0, t = 0;
          for (let i = 0; i < bins; i++) {
            const f = (i / bins) * nyquist;
            const val = freq[i];
            t += val;
            if (f >= 200 && f <= 3400) v += val;
            if (f > 8000) h += val;
            if (f < 200) l += val;
          }
          totalEnergy += t / bins;
          voiceEnergy += v;
          highEnergy += h;
          lowEnergy += l;
          frames++;
          if (frames < samples) {
            setTimeout(sample, 50);
            return;
          }
          // 分类
          const avg = totalEnergy / samples;
          // 各频段「每 bin 平均能量」相对「全频段每 bin 平均能量」的占比，
          // 随 sampleRate 自适应（替代旧版硬编码 17/21/5）
          const voiceRatio = avg > 0 ? (voiceEnergy / samples / voiceBins) / avg : 0;
          const highRatio = avg > 0 ? (highEnergy / samples / highBins) / avg : 0;
          const lowRatio = avg > 0 ? (lowEnergy / samples / lowBins) / avg : 0;
          stream.getTracks().forEach((t) => t.stop());
          ctx.close().catch(() => {});

          let kind = '静音';
          if (avg < 4) kind = '静音';
          else if (voiceRatio > 0.5 && highRatio < 0.35) kind = '人声对话';
          else if (highRatio > 0.45 && lowRatio < 0.3) kind = '高频噪声（疑似广告/提示音）';
          else kind = '背景音乐';

          resolve({
            kind,
            avgEnergy: Math.round(avg),
            voiceRatio: voiceRatio.toFixed(2),
            highRatio: highRatio.toFixed(2),
          });
        }
        sample();
      })
      .catch((e) => reject(new Error('无法获取音频流：' + e.message)));
  });
}
