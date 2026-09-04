/* -------------------------------------------------------------------------
 * content_adblock.js — 广告外观过滤（cosmetic blocking）
 * 与 background.js 的 declarativeNetRequest 网络层配合：
 *   network 层拦截广告/追踪请求；本脚本只负责「藏起」页面上已渲染的广告容器。
 * 仅用保守的显式选择器，避免误伤正文（不依赖 -ad- 这类易误匹配的子串）。
 * 通过 MutationObserver 兜底懒加载广告，单页操作上限封顶。
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  if (!chrome || !chrome.storage || !chrome.runtime) return;

  // 显式、低误伤的广告容器选择器
  const SELECTORS = [
    'ins.adsbygoogle',
    '[data-ad]', '[data-ads]', '[data-adsbygoogle-status]',
    '[data-ad-client]', '[data-ad-slot]', '[data-ad-format]',
    '.adsbygoogle',
    '.ad-banner', '.ad-container', '.ad-slot', '.ad-wrapper', '.ad-box',
    '.ad-placeholder', '.ad-region', '.ad-unit', '.ad-leaderboard',
    '.advert', '.advertisement', '.advertising', '.adv',
    '.sponsor', '.sponsored', '.sponsored-content', '.sponsorship',
    '.promo', '.promotion', '.promobox',
    '.google-ad', '.dfp', '.dfp-ad', '.dfp-slot', '.dfp-tag',
    '.banner-ad', '.text-ad', '.inread', '.native-ad', '.native-ad-unit',
    '#ad', '#ads', '#ad-slot', '#advert', '#sponsor', '#google_ads',
    '[class*="adsbygoogle"]',
    '[class*="div-gpt"]', '[id^="div-gpt-ad"]',
    '[id^="google_ads_"]', '[id^="google_ads_frame"]',
    '[aria-label*="advertisement" i]', '[aria-label*="广告" i]',
  ].join(',');

  const MAX_HIDE = 500;        // 单页最大隐藏数，防失控
  const MAX_MUTATIONS = 2000;  // 单页最大观察次数，防卡顿
  const SWEEP_DEBOUNCE_MS = 200; // 变动洪流合并：一批变动只跑一次全量查询
  const IDLE_STOP_SWEEPS = 6;    // 连续 N 次无新增隐藏 → 广告已加载完，彻底停止观察

  let enabled = true;
  let allowSet = new Set();
  let domain = '';
  let hiddenCount = 0;
  let lastReportedCount = 0;   // 上次已上报的隐藏数（上报增量用，避免累计值被重复累加）
  let hidden = new WeakSet();
  let hiddenEls = [];          // {el, prevDisplay}——本脚本隐藏的元素，关闭时还原
  let mutations = 0;
  let reportTimer = null;
  let sweepTimer = null;
  let idleSweeps = 0;
  let observer = null;

  function curDomain() {
    try { return new URL(location.href).hostname.replace(/^www\./, ''); }
    catch (e) { return location.hostname || ''; }
  }

  function loadState(cb) {
    chrome.storage.local.get({ adblockEnabled: true, adblockAllow: [] }, (r) => {
      enabled = r.adblockEnabled !== false;
      allowSet = new Set((r.adblockAllow || []).map((d) => String(d).replace(/^www\./, '')));
      domain = curDomain();
      cb();
    });
  }

  function isAllowed() {
    if (allowSet.has(domain)) return true;
    // 也匹配父域（如 a.b.example.com 命中 example.com 白名单）
    const parts = domain.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      if (allowSet.has(parts.slice(i).join('.'))) return true;
    }
    return false;
  }

  function hideOne(el) {
    if (hidden.has(el)) return false;
    const s = el.style;
    if (s.display === 'none') { hidden.add(el); return false; }
    const prevDisplay = s.display; // 记录原始内联 display，还原时用
    s.setProperty('display', 'none', 'important');
    hidden.add(el);
    hiddenEls.push({ el, prevDisplay });
    hiddenCount++;
    return true;
  }

      function report() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      // 上报自上次以来的增量：累计值若直接相加会把同一批隐藏重复计数
      const delta = hiddenCount - lastReportedCount;
      if (delta > 0) {
        lastReportedCount = hiddenCount;
        try {
          chrome.runtime.sendMessage({
            type: 'ADBLOCK_REPORT',
            payload: { count: delta, domain: domain },
          });
        } catch (e) { /* 后台未就绪时静默 */ }
      }
    }, 800);
  }

  /** 只关心元素节点新增；文本/注释节点的变动不触发 sweep */
  function hasElementAdded(records) {
    for (const rec of records) {
      const n = rec.addedNodes;
      if (!n || !n.length) continue;
      for (let i = 0; i < n.length; i++) {
        if (n[i].nodeType === 1) return true;
      }
    }
    return false;
  }

  /**
   * 合并变动洪流后再 sweep。
   * SELECTORS 有 43 条且含 [class*=]/[aria-label*=] 子串匹配（走不了选择器快速路径），
   * 全量 querySelectorAll 并不便宜；SPA / 无限滚动下 DOM 变动是持续的，
   * 不节流会退化成「每批 DOM 变动扫一遍全文档」。
   */
  function scheduleSweep() {
    if (sweepTimer) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      const before = hiddenCount;
      sweep();
      if (hiddenCount > before) {
        idleSweeps = 0;
        report();
      } else if (++idleSweeps >= IDLE_STOP_SWEEPS && observer) {
        // 连续多次都没新广告 → 广告已加载完，摘掉观察者，别一直挂到页面关闭
        observer.disconnect();
        observer = null;
      }
    }, SWEEP_DEBOUNCE_MS);
  }

  function teardown() {
    if (observer) { observer.disconnect(); observer = null; }
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    idleSweeps = 0;
    mutations = 0;
  }

  function start() {
    // 关闭开关或白名单站点：停掉观察与待跑任务，并把已隐藏的元素还原
    // （顺带修复「关闭后再开启不生效」——原来被 alreadyRan 一次性闸门挡住）
    if (!enabled || isAllowed()) { teardown(); unhideAll(); return; }
    if (observer) return; // 已在运行，避免重复挂观察者

    sweep();
    report();

    // 兜底懒加载：监听新增节点（iframe 由各自世界处理，这里仅主文档）
    observer = new MutationObserver((records) => {
      if (!observer) return;
      if (mutations >= MAX_MUTATIONS) { observer.disconnect(); observer = null; return; }
      mutations += records.length;
      if (hasElementAdded(records)) scheduleSweep();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // 等 DOM 就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => loadState(start));
  } else {
    loadState(start);
  }

  // 监听开关 / 白名单变化，即时生效（无需刷新）
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.adblockEnabled || changes.adblockAllow) loadState(() => start());
    });
  } catch (e) { /* 部分浏览器不支持 content 端 onChanged */ }
})();
