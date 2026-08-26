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

    case 'FATIGUE_REPORT':
      handleFatigueReport(payload)
        .then(() => reply(true, true))
        .catch((e) => reply(false, null, e.message));
      return true;

    case 'FATIGUE_GET':
      chrome.storage.local.get({ eyecare: null }, (r) => reply(true, r.eyecare || null));
      return true;

    /* ------------------------- 标签页性能透视 ------------------------- */
    case 'PERFORM_REPORT':
      if (_sender && _sender.tab) {
        handlePerfReport(_sender.tab, payload);
      }
      reply(true, true);
      return false;

    case 'TABS_PERF':
      chrome.tabs.query({}, (tabs) => {
        chrome.storage.local.get({ perfTabs: {} }, (r) => {
          const map = r.perfTabs || {};
          reply(true, tabs.map((t) => ({
            id: t.id,
            title: t.title || t.url || '(无标题)',
            url: t.url || '',
            audible: !!t.audible,
            mutedInfo: t.mutedInfo || {},
            favIconUrl: t.favIconUrl || '',
            perf: map[t.id] || null,
          })));
        });
      });
      return true;

    case 'TAB_ACTION':
      doTabAction(payload, reply);
      return true;

    /* ------------------------- 音频管理 ------------------------- */
    case 'AUDIO_LIST':
      chrome.tabs.query({}, (tabs) => {
        chrome.storage.local.get({ audioLearned: {} }, (r) => {
          const learned = r.audioLearned || {};
          reply(true, tabs
            .filter((t) => t.audible)
            .map((t) => ({
              id: t.id,
              title: t.title || t.url || '',
              url: t.url || '',
              muted: !!(t.mutedInfo && t.mutedInfo.muted),
              domain: domainOf(t.url),
              learned: learned[domainOf(t.url)] || 'keep',
            })));
        });
      });
      return true;

    case 'AUDIO_SET_MUTED':
      chrome.tabs.update(payload.tabId, { muted: payload.muted }, (t) => {
        if (chrome.runtime.lastError) return reply(false, null, chrome.runtime.lastError.message);
        // 学习：用户手动静音/恢复某域名
        if (payload.learn && payload.domain) {
          chrome.storage.local.get({ audioLearned: {} }, (r) => {
            const m = r.audioLearned || {};
            m[payload.domain] = payload.muted ? 'mute' : 'keep';
            chrome.storage.local.set({ audioLearned: m });
          });
        }
        reply(true, true);
      });
      return true;

    case 'AUDIO_MUTE_ALL':
      chrome.tabs.query({ audible: true }, (tabs) => {
        const ids = (tabs || []).map((t) => t.id).filter((x) => x != null);
        if (!ids.length) return reply(true, 0);
        let done = 0;
        ids.forEach((id) => chrome.tabs.update(id, { muted: true }, () => done++));
        reply(true, ids.length);
      });
      return true;

    case 'AUDIO_ANALYZE':
      analyzeTabAudio(payload.tabId, reply);
      return true;

    case 'PRIVACY_EVENT':
      handlePrivacyEvent(_sender, payload);
      reply(true, true);
      return false;

    case 'PRIVACY_GET':
      chrome.storage.local.get({ privacyEvents: [], privacyMode: 'monitor' }, (r) => {
        reply(true, { events: r.privacyEvents || [], mode: r.privacyMode || 'monitor' });
      });
      return true;

    case 'PRIVACY_SET_MODE':
      chrome.storage.local.set({ privacyMode: payload.mode }, () => reply(true, true));
      return true;

    case 'PRIVACY_CLEAR':
      chrome.storage.local.set({ privacyEvents: [] }, () => reply(true, true));
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

/* -------------------------------------------------------------------------
 * 视觉疲劳自适应：接收 content.js 上报，写当日疲劳曲线并更新图标角标
 * eyecare = {
 *   enabled: boolean,          // 开关（popup 设置）
 *   log: [{t, score}]          // 当日曲线（10 分钟一个桶，最多 288 点）
 *   minutes: number            // 今日累计高强度（活动）分钟
 *   lastLevel: number,         // 最近一次等级 1-5
 *   lastScore: number,
 *   date: 'YYYY-MM-DD',        // 当日标记（跨天自动重置曲线）
 *   updatedAt: number
 * }
 * ------------------------------------------------------------------------- */
const FATIGUE_BUCKET_MS = 10 * 60000;

function fatigueDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function handleFatigueReport(payload) {
  return new Promise((resolve) => {
    const now = Date.now();
    chrome.storage.local.get({ eyecare: null }, (r) => {
      let ec = r.eyecare;
      const today = fatigueDate(now);
      if (!ec || ec.date !== today) {
        // 跨天重置曲线（保留开关）
        ec = {
          enabled: ec ? ec.enabled !== false : true,
          log: [],
          minutes: 0,
          date: today,
        };
      }
      ec.log = ec.log || [];
      // 10 分钟一个桶，合并
      const bucket = Math.floor(now / FATIGUE_BUCKET_MS) * FATIGUE_BUCKET_MS;
      const last = ec.log[ec.log.length - 1];
      if (last && last.t === bucket) last.score = payload.score;
      else {
        ec.log.push({ t: bucket, score: payload.score });
        if (ec.log.length > 288) ec.log.shift();
      }
      ec.minutes = (ec.minutes || 0) + (payload.activeDeltaMs || 0) / 60;
      ec.lastLevel = payload.level;
      ec.lastScore = payload.score;
      ec.updatedAt = now;

      chrome.storage.local.set({ eyecare: ec }, () => {
        updateFatigueBadge(payload.level);
        resolve();
      });
    });
  });
}

function updateFatigueBadge(level) {
  try {
    chrome.action.setBadgeText({ text: String(level) });
    const hour = new Date().getHours();
    const night = hour >= 23 || hour < 6;
    chrome.action.setBadgeBackgroundColor({
      color: night ? '#c98a16' : '#4c7bf3', // 深夜用暖色提醒
    });
    chrome.action.setTitle({
      title: `视觉疲劳等级 ${level}/5\n点击图标查看护眼仪表盘`,
    });
  } catch (_e) {
    /* 忽略角标异常 */
  }
}


/* -------------------------------------------------------------------------
 * 标签页性能透视
 * ------------------------------------------------------------------------- */
function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_e) {
    return '';
  }
}

function handlePerfReport(tab, payload) {
  const now = Date.now();
  chrome.storage.local.get({ perfTabs: {} }, (r) => {
    const map = r.perfTabs || {};
    const prev = map[tab.id] || { highStreak: 0, lastNotify: 0 };
    map[tab.id] = {
      busy: payload.busy || 0,
      longTasks: payload.longTasks || 0,
      heap: payload.heap || 0,
      fps: payload.fps || 60,
      attrib: payload.attrib || [],
      media: payload.media || { autoplay: 0, adContainers: 0 },
      url: tab.url || '',
      title: tab.title || '',
      ts: now,
      highStreak: payload.busy >= 75 ? (prev.highStreak || 0) + 1 : 0,
      lastNotify: prev.lastNotify || 0,
    };
    chrome.storage.local.set({ perfTabs: map });

    // 高负载预警（替代「风扇预警」：系统无温度/风扇 API）
    const p = map[tab.id];
    if (p.highStreak >= 3 && now - (p.lastNotify || 0) > 10 * 60000) {
      p.lastNotify = now;
      map[tab.id] = p;
      chrome.storage.local.set({ perfTabs: map });
      try {
        chrome.notifications.create('perf-alert-' + tab.id, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: '⚠️ 标签页高负载持续',
          message: '「' + (tab.title || '未知页面').slice(0, 30) + '」已持续高占用，可能导致设备发热。点击查看或关闭该标签。',
          priority: 2,
        });
      } catch (_e) {
        /* 忽略 */
      }
    }
  });
}

function doTabAction(payload, reply) {
  const id = payload.tabId;
  if (id == null) return reply(false, null, '缺少 tabId');
  if (payload.action === 'discard') {
    chrome.tabs.discard(id, () => {
      if (chrome.runtime.lastError) return reply(false, null, chrome.runtime.lastError.message);
      reply(true, true);
    });
  } else if (payload.action === 'close') {
    chrome.tabs.remove(id, () => {
      if (chrome.runtime.lastError) return reply(false, null, chrome.runtime.lastError.message);
      reply(true, true);
    });
  } else if (payload.action === 'mute') {
    chrome.tabs.update(id, { muted: true }, () => {
      if (chrome.runtime.lastError) return reply(false, null, chrome.runtime.lastError.message);
      reply(true, true);
    });
  } else if (payload.action === 'unmute') {
    chrome.tabs.update(id, { muted: false }, () => {
      if (chrome.runtime.lastError) return reply(false, null, chrome.runtime.lastError.message);
      reply(true, true);
    });
  } else if (payload.action === 'focus') {
    chrome.tabs.update(id, { active: true }, () => reply(true, true));
  } else {
    reply(false, null, '未知操作');
  }
}

/* -------------------------------------------------------------------------
 * 音频：频谱分类分析（用户触发，需授权）
 * ------------------------------------------------------------------------- */
function analyzeTabAudio(tabId, reply) {
  if (tabId == null) return reply(false, null, '缺少 tabId');
  try {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError)
        return reply(false, null, '无法获取音频流：' + chrome.runtime.lastError.message);
      chrome.tabs.sendMessage(tabId, { type: 'AUDIO_ANALYZE', streamId }, (resp) => {
        if (chrome.runtime.lastError)
          return reply(false, null, '标签页未就绪，请刷新页面后重试（' + chrome.runtime.lastError.message + '）');
        if (resp && resp.ok) return reply(true, resp.data);
        reply(false, null, (resp && resp.error) || '分析失败');
      });
    });
  } catch (e) {
    reply(false, null, 'tabCapture 不可用：' + e.message);
  }
}

/* -------------------------------------------------------------------------
 * 隐私事件：记录指纹调用（含无痕标记）
 * ------------------------------------------------------------------------- */
function handlePrivacyEvent(sender, payload) {
  const incognito = !!(sender && sender.tab && sender.tab.incognito);
  chrome.storage.local.get({ privacyEvents: [] }, (r) => {
    const events = r.privacyEvents || [];
    const key = payload.host + '|' + payload.api;
    const found = events.find((e) => e.key === key);
    if (found) {
      found.count = (found.count || 1) + 1;
      found.lastTs = Date.now();
    } else {
      events.push({
        key: key,
        host: payload.host,
        api: payload.api,
        count: 1,
        incognito: incognito,
        firstTs: Date.now(),
        lastTs: Date.now(),
      });
    }
    if (events.length > 500) events.splice(0, events.length - 500);
    chrome.storage.local.set({ privacyEvents: events });
  });
}

/* -------------------------------------------------------------------------
 * 自动静音学习：用户静音某域名后，该域名再次发声自动静音
 * ------------------------------------------------------------------------- */
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.audible || !tab.audible) return;
  const dom = domainOf(tab.url || '');
  if (!dom) return;
  chrome.storage.local.get({ audioLearned: {} }, (r) => {
    const learned = r.audioLearned || {};
    if (learned[dom] === 'mute' && !(tab.mutedInfo && tab.mutedInfo.muted)) {
      chrome.tabs.update(tabId, { muted: true }, () => {
        try {
          chrome.notifications.create('audio-mute-' + tabId, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: '🔇 已自动静音（学习记忆）',
            message: dom + ' 你之前选择静音，本次自动静音。可在「音频」页恢复或取消记忆。',
          });
        } catch (_e) {
          /* 忽略 */
        }
      });
    }
  });
});
