/* -------------------------------------------------------------------------
 * content.js — 视觉疲劳自适应（护眼）内容脚本 · 渲染与上报层
 * 运行于每个 http/https 页面（隔离世界）。
 *
 * 职责划分（v2 重构）：
 *   - 感知 + 建模 + 个性化 → fatigue-engine.js（window.__EyeCareEngine）
 *     多信号融合（鼠标运动学/滚动路径熵/键入节奏/内容卷入/昼夜节律/任务曲线）、
 *     Welford 在线归一化、P² 个人基线校准、迟滞分级、双 EMA 平滑。
 *   - 本文件只负责：
 *     ① 自适应渲染（等级 1-5 渐进、主阅读区、内容类型、聚焦阅读）
 *     ② 每 60s 向 background 上报 {score, level, confidence, trend, activeDeltaSec}
 * ------------------------------------------------------------------------- */

'use strict';

(() => {
  if (window.__eyeCareLoaded) return; // 防止重复注入
  window.__eyeCareLoaded = true;

  const ENGINE = window.__EyeCareEngine;
  const REPORT_MS = 60000; // 上报周期
  const STEP_MS = 5000;    // 渐进步长（30 秒完成 1→5 共 6 级）

  /* ============================ 配置开关 ============================ */
  let enabled = true;
  chrome.storage.local.get({ eyecare: { enabled: true } }, (r) => {
    enabled = !!(r.eyecare && r.eyecare.enabled !== false);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.eyecare) {
      const v = changes.eyecare.newValue || {};
      enabled = v.enabled !== false;
      if (!enabled) applyLevel(1); // 关闭时立即恢复
    }
  });

  /* ============================ 主阅读区识别 ============================ */
  function findMainZone() {
    const selectors = [
      'main', 'article', '[role="main"]', '.article', '.post',
      '.post-content', '.entry-content', '.content', '#content',
      '#main', '.article-content',
    ];
    let best = null;
    let bestLen = 0;
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const n of nodes) {
        const len = (n.textContent || '').trim().length;
        if (len > bestLen) {
          bestLen = len;
          best = n;
        }
      }
    }
    if (best) return best;
    // 兜底：最长文本的 <p> 的块级祖先
    let bestP = null;
    let bestPLen = 0;
    document.querySelectorAll('p, li, td').forEach((n) => {
      const len = (n.textContent || '').trim().length;
      if (len > bestPLen) {
        bestPLen = len;
        bestP = n;
      }
    });
    if (bestP) {
      const parent = bestP.closest('section, div, body') || document.body;
      if (parent !== document.body) return parent;
    }
    return document.body;
  }

  /* ============================ 内容类型检测 ============================ */
  function detectType() {
    const codes = document.querySelectorAll('pre, code').length;
    const tables = document.querySelectorAll('table').length;
    const paras = document.querySelectorAll('p').length;
    if (codes > 8) return 'code';
    if (tables > 3) return 'table';
    if (paras > 20) return 'article';
    return 'generic';
  }

  let mainZone = null;
  function ensureZone() {
    if (!mainZone || !document.contains(mainZone)) {
      mainZone = findMainZone();
      mainZone.setAttribute('data-eyecare-zone', 'main');
    }
    return mainZone;
  }

  /* ============================ 渲染调整（渐进） ============================ */
  let currentLevel = 1;
  let targetLevel = 1;

  function applyLevel(l) {
    const root = document.documentElement;
    const type = detectType();
    root.setAttribute('data-eyecare-type', type);
    if (!enabled || l <= 1) {
      root.removeAttribute('data-eyecare');
      hideTip();
      clearFocus();
      return;
    }
    root.setAttribute('data-eyecare', String(l));
    ensureZone();
    if (l >= 4) {
      enableFocus();
      showTip(l);
    } else {
      clearFocus();
      hideTip();
    }
  }

  // 渐进：每 STEP_MS 向目标靠近一级（30 秒完成全部过渡）
  setInterval(() => {
    if (currentLevel < targetLevel) {
      currentLevel++;
      applyLevel(currentLevel);
    } else if (currentLevel > targetLevel) {
      currentLevel--;
      applyLevel(currentLevel);
    }
  }, STEP_MS);

  /* ---------- 聚焦阅读模式 ---------- */
  const FOCUS_TAGS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'TD', 'PRE', 'BLOCKQUOTE', 'SECTION', 'ARTICLE']);
  let focusOn = false;
  function onHover(e) {
    if (!focusOn) return;
    const zone = ensureZone();
    if (!zone.contains(e.target)) return;
    const el = e.target.closest
      ? e.target.closest(FOCUS_TAGS.join(','))
      : null;
    if (el && zone.contains(el)) {
      zone.querySelectorAll('.ec-active').forEach((n) => n.classList.remove('ec-active'));
      el.classList.add('ec-active');
    }
  }
  function enableFocus() {
    if (!focusOn) {
      focusOn = true;
      window.addEventListener('mouseover', onHover, { passive: true });
    }
  }
  function clearFocus() {
    focusOn = false;
    window.removeEventListener('mouseover', onHover);
    const zone = mainZone;
    if (zone) zone.querySelectorAll('.ec-active').forEach((n) => n.classList.remove('ec-active'));
  }

  /* ---------- 右下角提示浮层 ---------- */
  let tipEl = null;
  function getTip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'ec-tip';
      tipEl.id = 'ec-tip';
      document.documentElement.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(level) {
    const msgs = {
      4: '👀 已连续阅读较久，试试远眺 20 秒',
      5: '😌 疲劳等级高，建议闭眼休息 1 分钟',
    };
    const tip = getTip();
    tip.textContent = msgs[level] || '';
    tip.classList.add('show');
  }
  function hideTip() {
    if (tipEl) tipEl.classList.remove('show');
  }

  /* ============================ 引擎驱动循环 ============================ */
  /* Day1 增量：20-20-20 微休息教练
   * 连续活跃满 20 分钟且疲劳 ≥2 级时，提示远眺 20 秒；
   * 提示期间（20s）不计入连续时长（相当于承认了一次微休息）。 */
  let continuousActiveMin = 0;
  let coaching = false;
  function runCoach(level) {
    if (!ENGINE || coaching) return;
    const s = ENGINE.summary();
    if (level >= 2) continuousActiveMin += 1; // 每 REPORT_MS 一格
    if (continuousActiveMin >= 20 && s.confidence >= 0.4) {
      coaching = true;
      continuousActiveMin = 0;
      const tip = getTip();
      tip.textContent = '⏸ 20-20-20：看 6 米外 20 秒，我在替你计时';
      tip.classList.add('show');
      setTimeout(() => {
        tip.classList.remove('show');
        coaching = false;
      }, 20000);
    }
  }

  if (ENGINE && ENGINE.ready) {
    // 每 5s：活跃时间心跳（引擎 M1 任务曲线 / M3 恢复模型 / 活跃占比）
    setInterval(() => ENGINE.heartbeat(), 5000);

    // 每 60s：引擎评分 → 渲染目标 + 上报 + 微休息教练
    setInterval(() => {
      let r;
      try { r = ENGINE.tick(); } catch (_e) { return; }
      targetLevel = r.level; // 供渐进使用
      runCoach(r.level);
      try {
        chrome.runtime.sendMessage({
          type: 'FATIGUE_REPORT',
          payload: {
            score: r.score,
            level: r.level,
            confidence: r.confidence,
            trend: r.trend,
            activeDeltaMs: ENGINE.activeDeltaSec(),
          },
        });
      } catch (_e) {
        /* 后台不可达时忽略 */
      }
    }, REPORT_MS);
  } else {
    // 引擎不可用（异常环境）：保持旧版最小可用行为——只做渲染不评分
    setInterval(() => { if (enabled) targetLevel = 1; }, REPORT_MS);
  }

  /* ---------- 初始化 ---------- */
  ensureZone();
  applyLevel(1);
})();
