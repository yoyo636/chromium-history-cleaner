/* -------------------------------------------------------------------------
 * background.js — Manifest V3 Service Worker
 * 集中代理危险的 history 操作（查询 / 全量查询 / 统计 / 按范围删除 / 按 URL 删除），
 * 并提供书签「死链检测」（通过 no-cors 探测，无需额外主机权限）。
 *
 * 全量查询说明：chrome.history.search 单次最多返回约 100 条（maxResults 上限），
 * 为了「无限期展示全部数据」，这里采用「时间窗二分」策略：
 * 当某时间窗返回数量达到上限时，将该窗口对半拆分后递归查询并去重合并，
 * 从而可以拿到任意时间跨度内的全部历史记录。
 * ------------------------------------------------------------------------- */

'use strict';

const CAP = 500; // 单窗口请求上限（越大调用次数越少，但受浏览器 API 限制）
const MAX_DEPTH = 12; // 二分最大深度，防止极端历史下递归过深

/* ------------------------- 基础 history 查询 ------------------------- */
function historySearch(startTime, endTime, maxResults) {
  return new Promise((resolve, reject) => {
    chrome.history.search(
      { text: '', startTime, endTime, maxResults },
      (items) => {
        if (chrome.runtime.lastError)
          return reject(new Error(chrome.runtime.lastError.message));
        resolve((items || []).map(normItem));
      }
    );
  });
}

function normItem(i) {
  return {
    title: i.title,
    url: i.url,
    lastVisitTime: i.lastVisitTime,
    visitCount: i.visitCount,
  };
}

/* ------------------- 全量查询（时间窗二分 + 去重） ------------------- */
function searchAll(startTime, endTime) {
  return (async () => {
    const out = await collectAll([], startTime, endTime, 0);
    out.sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0));
    return dedupe(out);
  })();
}

async function collectAll(arr, startTime, endTime, depth) {
  if (endTime <= startTime || depth > MAX_DEPTH) return arr;
  const items = await historySearch(startTime, endTime, CAP);
  if (items.length < CAP) {
    arr.push(...items); // 窗口未触顶，本窗口已取全
    return arr;
  }
  // 触顶 → 对半拆分递归，丢弃不完整的本次结果
  const mid = startTime + Math.floor((endTime - startTime) / 2);
  await collectAll(arr, startTime, mid, depth + 1);
  await collectAll(arr, mid + 1, endTime, depth + 1);
  return arr;
}

function dedupe(items) {
  const m = new Map();
  for (const i of items) {
    const k = (i.url || '') + '|' + i.lastVisitTime;
    if (!m.has(k)) m.set(k, i);
  }
  return [...m.values()];
}

/* ------------------------- 统计（聚合式） ------------------------- */
function collectStats(startTime, endTime) {
  return (async () => {
    const acc = {
      count: 0,
      totalVisits: 0,
      earliest: null,
      latest: null,
      domains: new Set(),
      top: new Map(),
      limited: false,
    };
    await walkStats(acc, startTime, endTime, 0);
    const top = [...acc.top.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([url, count]) => ({ url, count }));
    return {
      count: acc.count,
      totalVisits: acc.totalVisits,
      earliest: acc.earliest,
      latest: acc.latest,
      domains: [...acc.domains],
      top,
      limited: acc.limited,
    };
  })();
}

async function walkStats(acc, startTime, endTime, depth) {
  if (endTime <= startTime) return;
  const items = await historySearch(startTime, endTime, CAP);
  const hitCap = items.length >= CAP;
  if (hitCap) {
    if (depth >= MAX_DEPTH) {
      acc.limited = true;
      return;
    }
    const mid = startTime + Math.floor((endTime - startTime) / 2);
    await walkStats(acc, startTime, mid, depth + 1);
    await walkStats(acc, mid + 1, endTime, depth + 1);
    return;
  }
  for (const i of items) {
    acc.count++;
    acc.totalVisits += i.visitCount || 1;
    if (acc.earliest == null || i.lastVisitTime < acc.earliest)
      acc.earliest = i.lastVisitTime;
    if (acc.latest == null || i.lastVisitTime > acc.latest)
      acc.latest = i.lastVisitTime;
    let dom = '(未知)';
    try {
      dom = new URL(i.url).hostname;
    } catch (_e) {
      /* 忽略非法 URL */
    }
    acc.domains.add(dom);
    const k = i.url;
    acc.top.set(k, (acc.top.get(k) || 0) + (i.visitCount || 1));
  }
}

/* --------------------------- 消息分发 --------------------------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg && msg.type;
  const payload = (msg && msg.payload) || {};
  const reply = (ok, data, error) =>
    sendResponse({ ok, data: data == null ? null : data, error: error || null });

  switch (type) {
    case 'SEARCH':
      chrome.history.search(
        {
          text: '',
          startTime: payload.startTime,
          endTime: payload.endTime,
          maxResults: payload.maxResults || 100,
        },
        (items) => {
          if (chrome.runtime.lastError)
            return reply(false, null, chrome.runtime.lastError.message);
          reply(true, (items || []).map(normItem));
        }
      );
      return true;

    case 'SEARCH_ALL':
      searchAll(payload.startTime || 0, payload.endTime || Date.now())
        .then((items) => reply(true, items))
        .catch((e) => reply(false, null, e.message));
      return true;

    case 'SEARCH_STATS':
      collectStats(payload.startTime || 0, payload.endTime || Date.now())
        .then((s) => reply(true, s))
        .catch((e) => reply(false, null, e.message));
      return true;

    case 'DELETE_RANGE':
      chrome.history.deleteRange(
        { startTime: payload.startTime, endTime: payload.endTime },
        () => {
          if (chrome.runtime.lastError)
            return reply(false, null, chrome.runtime.lastError.message);
          reply(true, true);
        }
      );
      return true;

    case 'DELETE_URL':
      chrome.history.deleteUrl({ url: payload.url }, () => {
        if (chrome.runtime.lastError)
          return reply(false, null, chrome.runtime.lastError.message);
        reply(true, true);
      });
      return true;

    case 'CHECK_LINKS':
      Promise.all((payload.urls || []).map(checkLink))
        .then((res) => reply(true, res))
        .catch((e) => reply(false, null, e.message));
      return true;

    default:
      reply(false, null, '未知的消息类型: ' + type);
      return false;
  }
});

/**
 * 探测单个 URL 是否可达。
 * 使用 no-cors 模式，故只会因「网络层失败」（域名失效 / 连接被拒）而标记为失效，
 * 404/500 等仍会 resolve（得到不透明响应）。这足以识别「死链 / 失效书签」。
 * @param {string} url
 * @returns {Promise<{url:string, ok:boolean}>}
 */
function checkLink(url) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    fetch(url, {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      signal: ctrl.signal,
    })
      .then(() => {
        clearTimeout(timer);
        resolve({ url, ok: true });
      })
      .catch(() => {
        clearTimeout(timer);
        resolve({ url, ok: false });
      });
  });
}
