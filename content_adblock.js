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

  let enabled = true;
  let allowSet = new Set();
  let domain = '';
  let hiddenCount = 0;
  let hidden = new WeakSet();
  let mutations = 0;
  let reportTimer = null;
  let alreadyRan = false;

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
    s.setProperty('display', 'none', 'important');
    hidden.add(el);
    hiddenCount++;
    return true;
  }

  function sweep() {
    if (hiddenCount >= MAX_HIDE) return;
    const els = document.querySelectorAll(SELECTORS);
    for (let i = 0; i < els.length && hiddenCount < MAX_HIDE; i++) {
      hideOne(els[i]);
    }
  }

  function report() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      if (hiddenCount > 0) {
        try {
          chrome.runtime.sendMessage({
            type: 'ADBLOCK_REPORT',
            payload: { count: hiddenCount, domain: domain },
          });
        } catch (e) { /* 后台未就绪时静默 */ }
      }
    }, 800);
  }

  function start() {
    if (alreadyRan) return;
    alreadyRan = true;
    if (!enabled || isAllowed()) return;

    sweep();
    report();

    // 兜底懒加载：监听新增节点（含 iframe 由各自世界处理，这里仅主文档）
    const observer = new MutationObserver((records) => {
      if (mutations >= MAX_MUTATIONS) { observer.disconnect(); return; }
      mutations += records.length;
      let dirty = false;
      for (const rec of records) {
        if (rec.addedNodes && rec.addedNodes.length) { dirty = true; break; }
      }
      if (dirty) {
        sweep();
        report();
      }
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
