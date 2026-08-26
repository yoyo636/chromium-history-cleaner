/* -------------------------------------------------------------------------
 * content.js — 视觉疲劳自适应（护眼）内容脚本
 * 运行于每个 http/https 页面（隔离世界）。
 *
 * 一、多维度疲劳信号采集
 *   - 鼠标动力学：速度、加速度、停顿频率、轨迹抖动（方向突变）
 *   - 滚动行为：滚动速度、频繁回滚（方向反转）、页面停留/活跃占比
 *   - 键盘节奏：输入间隔、退格键频率
 *   - 时间上下文：连续活跃时长、深夜时段加成
 *
 * 二、自适应渲染调整（疲劳等级 1-5，30 秒渐进）
 *   - 每 5 秒向目标等级靠近一级（transition 平滑），用户无感知
 *   - 区域级自适应：识别「主阅读区」（main/article/最长文本块），
 *     仅该区域做精细排版；导航栏/侧边栏保持原样
 *   - 内容类型感知：代码/长文章/表格 采用不同调整策略
 *   - 等级 4+ 开启聚焦阅读（高亮当前段落，其余淡化）+ 页面右下角提示
 *   - 等级 5 追加正文暖色微调（仅文字，图片/视频保持原色）
 *
 * 三、上报
 *   - 每 60 秒上报 {score, level, activeMinutesDelta} 给 background，
 *     由后台写当日疲劳曲线并更新扩展图标角标。
 * ------------------------------------------------------------------------- */

'use strict';

(() => {
  if (window.__eyeCareLoaded) return; // 防止重复注入
  window.__eyeCareLoaded = true;

  const REPORT_MS = 60000; // 上报周期
  const STEP_MS = 5000; // 渐进步长（30 秒完成 1→5 共 6 级）
  const PAUSE_MS = 1200; // 判定「停顿」的最小静止时长

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

  /* ============================ 信号状态 ============================ */
  const mouse = {
    lastX: 0, lastY: 0, lastT: 0, lastSpeed: 0,
    speedSum: 0, speedN: 0, // 平均速度
    pauseMs: 0, pausedAt: 0, // 停顿累计
    jerks: 0, samples: 0, // 抖动次数 / 采样数
    lastAngle: null,
  };
  const scroll = {
    lastY: window.scrollY || 0, lastT: 0,
    dist: 0, speedSum: 0, speedN: 0,
    reversals: 0, lastDir: 0, samples: 0,
  };
  const key = {
    lastT: 0, gaps: [], backspaces: 0, total: 0,
  };
  const session = {
    start: Date.now(),
    lastActivity: Date.now(),
    activeMs: 0, // 有交互的时间占比
    totalMs: 0,
    lastReportedMs: 0,
  };

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

  /* ============================ 信号采集 ============================ */
  function touch() {
    session.lastActivity = Date.now();
  }

  // 鼠标动力学
  window.addEventListener(
    'mousemove',
    (e) => {
      touch();
      const now = performance.now();
      if (!mouse.lastT) {
        mouse.lastX = e.clientX; mouse.lastY = e.clientY; mouse.lastT = now;
        return;
      }
      const dt = now - mouse.lastT;
      if (dt < 40) return; // 节流
      const dx = e.clientX - mouse.lastX;
      const dy = e.clientY - mouse.lastY;
      const dist = Math.hypot(dx, dy);
      const speed = dist / dt; // px/ms
      mouse.speedSum += speed;
      mouse.speedN++;

      // 抖动：方向角突变 > 45°
      if (dist > 2) {
        const angle = Math.atan2(dy, dx);
        if (mouse.lastAngle != null) {
          let diff = Math.abs(angle - mouse.lastAngle);
          if (diff > Math.PI) diff = Math.PI * 2 - diff;
          if (diff > Math.PI / 4) mouse.jerks++;
        }
        mouse.lastAngle = angle;
      }
      // 加速度大（急停/急起）也记入抖动
      if (mouse.lastSpeed > 0 && Math.abs(speed - mouse.lastSpeed) / dt > 0.02)
        mouse.jerks++;
      mouse.samples++;
      mouse.lastSpeed = speed;

      // 停顿检测
      if (mouse.pausedAt) {
        if (now - mouse.pausedAt > PAUSE_MS) mouse.pauseMs += now - mouse.pausedAt;
        mouse.pausedAt = 0;
      }
      mouse.lastX = e.clientX; mouse.lastY = e.clientY; mouse.lastT = now;
    },
    { passive: true }
  );
  window.addEventListener(
    'mouseout',
    () => {
      mouse.pausedAt = performance.now();
    },
    { passive: true }
  );
  window.addEventListener(
    'mouseover',
    () => {
      mouse.pausedAt = 0;
    },
    { passive: true }
  );

  // 滚动行为
  window.addEventListener(
    'scroll',
    () => {
      touch();
      const now = performance.now();
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      if (!scroll.lastT) {
        scroll.lastY = y; scroll.lastT = now;
        return;
      }
      const dt = now - scroll.lastT;
      if (dt < 50) return;
      const d = Math.abs(y - scroll.lastY);
      scroll.dist += d;
      scroll.speedSum += d / dt;
      scroll.speedN++;
      scroll.samples++;
      const dir = y > scroll.lastY ? 1 : y < scroll.lastY ? -1 : 0;
      if (dir !== 0 && scroll.lastDir !== 0 && dir !== scroll.lastDir)
        scroll.reversals++; // 回滚（反复寻找内容）
      scroll.lastDir = dir;
      scroll.lastY = y; scroll.lastT = now;
    },
    { passive: true }
  );

  // 键盘节奏
  window.addEventListener(
    'keydown',
    (e) => {
      touch();
      const now = performance.now();
      if (key.lastT) {
        const gap = now - key.lastT;
        if (gap > 30 && gap < 10000) key.gaps.push(gap);
      }
      key.lastT = now;
      key.total++;
      if (e.key === 'Backspace') key.backspaces++;
    },
    { passive: true }
  );

  // 活动占比
  setInterval(() => {
    const now = Date.now();
    const idle = now - session.lastActivity;
    if (idle < 5000) session.activeMs += Math.min(idle, 5000);
    session.totalMs += 5000;
  }, 5000);

  /* ============================ 疲劳评分（0-100） ============================ */
  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }
  function avg(arr, n) {
    return n ? arr / n : 0;
  }

  function computeScore() {
    const now = Date.now();

    // 鼠标：速度慢 + 停顿多 + 抖动多 → 疲劳
    const mSpeed = avg(mouse.speedSum, mouse.speedN); // px/ms，常态 ~0.5-1.5
    const mouseSlow = clamp01(1 - mSpeed / 0.6);
    const mousePause = clamp01(mouse.pauseMs / (session.totalMs || 1) / 0.5);
    const mouseJerk = clamp01(mouse.jerks / Math.max(1, mouse.samples) / 0.35);
    const mouseScore = (mouseSlow * 0.4 + mousePause * 0.3 + mouseJerk * 0.3) * 100;

    // 滚动：速度下降 + 回滚频繁
    const sSpeed = avg(scroll.speedSum, scroll.speedN);
    const scrollSlow = clamp01(1 - sSpeed / 4);
    const scrollReversal = clamp01(scroll.reversals / Math.max(1, scroll.samples) / 0.12);
    const scrollScore = (scrollSlow * 0.6 + scrollReversal * 0.4) * 100;

    // 键盘：输入间隔增大 + 退格率上升
    const gapAvg = key.gaps.length ? key.gaps.reduce((a, b) => a + b, 0) / key.gaps.length : 0;
    const keySlow = clamp01(gapAvg / 1200);
    const keyBack = key.total ? clamp01(key.backspaces / key.total / 0.25) : 0;
    const keyScore = (keySlow * 0.5 + keyBack * 0.5) * 100;

    // 时间上下文：连续活跃分钟 + 深夜加成
    const activeMinutes = session.activeMs / 60000;
    const timeBase = clamp01(activeMinutes / 60) * 60;
    const hour = new Date(now).getHours();
    const night = hour >= 23 || hour < 6; // 深夜自动提高阈值（+15）
    const timeScore = Math.min(100, timeBase + (night ? 15 : 0));

    // 加权综合（缺什么信号就降权，避免误判）
    let wMouse = mouse.speedN > 5 ? 0.3 : 0;
    let wScroll = scroll.samples > 3 ? 0.3 : 0;
    let wKey = key.total > 3 ? 0.2 : 0;
    let wTime = 1;
    const wSum = wMouse + wScroll + wKey + wTime || 1;
    wMouse /= wSum; wScroll /= wSum; wKey /= wSum; wTime /= wSum;

    return Math.round(
      mouseScore * wMouse + scrollScore * wScroll + keyScore * wKey + timeScore * wTime
    );
  }

  function levelOf(score) {
    if (score < 15) return 1;
    if (score < 35) return 2;
    if (score < 55) return 3;
    if (score < 75) return 4;
    return 5;
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

  /* ============================ 上报 ============================ */
  setInterval(() => {
    const score = computeScore();
    const level = levelOf(score);
    targetLevel = level; // 供渐进使用
    const deltaMs = session.activeMs - session.lastReportedMs;
    session.lastReportedMs = session.activeMs;
    try {
      chrome.runtime.sendMessage({
        type: 'FATIGUE_REPORT',
        payload: {
          score,
          level,
          activeDeltaMs: Math.round(deltaMs / 1000),
        },
      });
    } catch (_e) {
      /* 后台不可达时忽略 */
    }
  }, REPORT_MS);

  /* ---------- 初始化 ---------- */
  ensureZone();
  applyLevel(1);
})();
