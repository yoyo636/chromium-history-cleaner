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
        if (payload.forget && payload.domain) {
          // 取消学习记忆（不改变静音状态）
          chrome.storage.local.get({ audioLearned: {} }, (r) => {
            const m = r.audioLearned || {};
            delete m[payload.domain];
            chrome.storage.local.set({ audioLearned: m });
          });
        } else if (payload.learn && payload.domain) {
          // 学习：用户手动静音/恢复某域名
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

    /* ------------------------- BrowserPilot（网页端 AI 操作浏览器） ------------------------- */
    case 'EXECUTE_TOOL':
      handleBrowserPilot(payload, reply, _sender);
      return true;

    case 'BP_INJECT_PROTOCOL':
      bpInjectProtocolToActiveAiTab(reply);
      return true;

    case 'BP_GET_CONTEXT':
      reply(true, {
        targetTabId: bpCtx.targetTabId,
        lastNonAiTabId: bpCtx.lastNonAiTabId,
      });
      return true;

    /* --------------------- 开发者模式 · 篡改（密码门禁在后台） --------------------- */
    case 'TAMPER_SET_DEV':
      handleTamperSetDev(payload, reply);
      return true;

    case 'TAMPER_LIST':
      handleTamperList(payload, reply);
      return true;

    case 'TAMPER_OP':
      handleTamperOp(payload, reply);
      return true;

    case 'FOCUS_START':
      handleFocusStart(payload, reply);
      return true;

    case 'FOCUS_STATE':
      handleFocusState(reply);
      return true;

    case 'FOCUS_THREATS':
      handleFocusThreats(reply);
      return true;

    case 'FOCUS_END':
      finalizeFocus(false).then((r) => reply(true, r));
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

/* =========================================================================
 * BrowserPilot — 网页端 AI 操作浏览器
 * 让 Kimi / DeepSeek / MiniMax 等网页 AI 通过 <tool_call> 结构化指令，
 * 在本扩展的代理下安全控制「用户当前操作的网页」。
 * 设计要点：
 *   - 所有目标页操作都通过 chrome.scripting.executeScript(func+args) 完成，
 *     绝不执行任意用户传入的 JavaScript（无 browser_execute 工具）。
 *   - 上下文锁定：记住「最近交互的非 AI 标签页」，连续指令默认落在该页。
 *   - 安全拦截：click/type 命中支付/密码/发送/删除等敏感词时，先弹系统通知
 *     + 页面内确认弹窗，用户点「确认执行」才真正执行。
 * ========================================================================= */

const bpCtx = { targetTabId: null, lastNonAiTabId: null };
const BP_AI_HOSTS = /kimi\.moonshot\.cn|chat\.deepseek\.com|chat\.minimaxi\.com/;
function bpIsAiTab(url) {
  return BP_AI_HOSTS.test(url || '');
}
function getTabSafe(id) {
  return new Promise((resolve) => {
    if (id == null) return resolve(null);
    chrome.tabs.get(id, (t) => resolve(chrome.runtime.lastError ? null : t));
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 目标页选择优先级：args.tabId > bpCtx.targetTabId > 最近非AI页 > 当前非AI活跃页
async function bpPickTarget(args, senderTabId) {
  if (args && args.tabId) return args.tabId;
  if (bpCtx.targetTabId) {
    const t = await getTabSafe(bpCtx.targetTabId);
    if (t && !bpIsAiTab(t.url)) return bpCtx.targetTabId;
  }
  if (bpCtx.lastNonAiTabId) {
    const t = await getTabSafe(bpCtx.lastNonAiTabId);
    if (t && !bpIsAiTab(t.url)) return bpCtx.lastNonAiTabId;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && !bpIsAiTab(active.url)) return active.id;
  return null;
}

// 在目标页注入执行某函数（func + args），返回 results[0].result
async function bpInject(tabId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: [args],
  });
  return results && results[0] ? results[0].result : null;
}

// 等待标签页加载完成（最多 15s）
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const onUpd = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpd);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      resolve();
    }, 15000);
  });
}

// 敏感词判定：支付/密码/发送/删除
const BP_SENSITIVE_RE = /支付|付款|提交订单|立即购买|下单|结算|发送|删除|确认支付|确认删除|pay|submit|send|delete|buy now|place order/i;
function bpIsSensitive(info) {
  if (!info || !info.found) return false;
  if (info.isPassword) return true;
  return BP_SENSITIVE_RE.test(info.text || '');
}

/* -------------------------------------------------------------------------
 * bp_exec — 注入目标页执行的实际函数（必须自包含，仅用 document/window）
 * 通过 args.mode = 'probe' | 'act' 区分「探测（敏感判定用）」与「执行」。
 * 返回统一结构：{ success, data, error, current_url }
 * ------------------------------------------------------------------------- */
function bp_exec(args) {
  const { tool, mode } = args;
  const a = Object.assign({}, args);
  delete a.tool;
  delete a.mode;

  function locate(x) {
    let el = null;
    if (x.selector) el = document.querySelector(x.selector);
    else if (x.xpath) el = document.evaluate(x.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    else if (x.coords) el = document.elementFromPoint(x.coords.x, x.coords.y);
    else if (x.text || x.containsText) {
      const needle = x.text || x.containsText;
      const exact = !!x.text;
      const sels = ['a', 'button', '[role="button"]', 'input[type="button"]', 'input[type="submit"]', 'label', 'summary', 'div', 'span', 'p'];
      for (const s of sels) {
        const nodes = document.querySelectorAll(s);
        for (const n of nodes) {
          const t = (n.innerText || n.textContent || '').trim();
          if (!t) continue;
          if (exact ? t === needle : t.includes(needle)) { el = n; break; }
        }
        if (el) break;
      }
    }
    return el;
  }
  function sleepP(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }
  function probeInfo(el) {
    if (!el) return { found: false };
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.textContent || el.value || '').trim().slice(0, 120);
    const typeAttr = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    const isPassword = tag === 'input' && (typeAttr === 'password' || (el.name && /pass/i.test(el.name)));
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return {
      found: true, tagName: tag, text,
      type: el.type || typeAttr, isPassword,
      value: (tag === 'input' || tag === 'textarea') ? el.value : undefined,
      rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : undefined,
    };
  }

  async function run() {
    switch (tool) {
      case 'browser_click': {
        const el = locate(a);
        if (mode === 'probe') return Object.assign({ success: true, current_url: location.href }, probeInfo(el));
        if (!el) return { success: false, error: '未找到可点击元素，建议先用 browser_get_elements 重新探测', current_url: location.href };
        try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
        await sleepP(150);
        try { el.click(); }
        catch (e) { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
        return { success: true, data: { clicked: el.tagName.toLowerCase(), text: (el.innerText || '').slice(0, 80) }, current_url: location.href };
      }
      case 'browser_type': {
        const el = locate(a);
        if (mode === 'probe') return Object.assign({ success: true, current_url: location.href }, probeInfo(el));
        if (!el) return { success: false, error: '未找到输入元素', current_url: location.href };
        const value = a.value != null ? String(a.value) : '';
        if (a.clear) { setNativeValue(el, ''); await sleepP(150); }
        let cur = a.clear ? '' : (el.value || '');
        const interval = a.typeInterval || 50;
        for (const ch of value) { cur += ch; setNativeValue(el, cur); await sleepP(interval + Math.random() * interval); }
        if (a.pressEnter) pressEnter(el);
        if (a.submit && el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
        return { success: true, data: { value: cur, length: cur.length }, current_url: location.href };
      }
      case 'browser_scroll': {
        if (a.to === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: a.behavior || 'smooth' });
        else if (a.to === 'top') window.scrollTo({ top: 0, behavior: a.behavior || 'smooth' });
        else {
          const amt = a.amount || 500;
          const dx = a.direction === 'left' ? -amt : a.direction === 'right' ? amt : 0;
          const dy = a.direction === 'up' ? -amt : a.direction === 'down' ? amt : 0;
          window.scrollBy({ top: dy, left: dx, behavior: a.behavior || 'smooth' });
        }
        return { success: true, data: { scrollY: window.scrollY, direction: a.direction || a.to }, current_url: location.href };
      }
      case 'browser_read': {
        let node = document.body;
        if (a.selector) node = document.querySelector(a.selector);
        else if (a.xpath) node = document.evaluate(a.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!node) return { success: false, error: '未找到读取目标', current_url: location.href };
        let content = a.format === 'html' ? node.innerHTML : (node.innerText || node.textContent || '');
        const max = a.maxLength || 4000;
        if (content.length > max) content = content.slice(0, max) + '...(已截断)';
        return { success: true, data: { format: a.format || 'text', length: content.length, content }, current_url: location.href };
      }
      case 'browser_get_elements': {
        const nodes = document.querySelectorAll(a.selector || 'a,button,[role="button"],input');
        const limit = a.limit || 20;
        const out = [];
        for (let i = 0; i < Math.min(nodes.length, limit); i++) {
          const n = nodes[i];
          const r = n.getBoundingClientRect ? n.getBoundingClientRect() : null;
          out.push({
            index: i, tag: n.tagName.toLowerCase(),
            text: (n.innerText || n.textContent || '').trim().slice(0, 60),
            id: n.id || '', classes: n.className && n.className.toString ? n.className.toString().slice(0, 80) : '',
            type: n.type || '', href: n.href || '',
            rect: a.includeRect && r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : undefined,
          });
        }
        return { success: true, data: { count: out.length, total: nodes.length, elements: out }, current_url: location.href };
      }
      case 'browser_wait': {
        if (a.time) { await sleepP(a.time); return { success: true, data: { waited: a.time }, current_url: location.href }; }
        if (a.selector || a.xpath) {
          const timeout = a.timeout || 8000;
          const start = Date.now();
          while (Date.now() - start < timeout) {
            const el = a.selector ? document.querySelector(a.selector)
              : document.evaluate(a.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (el) return { success: true, data: { found: true, waited: Date.now() - start }, current_url: location.href };
            await sleepP(200);
          }
          return { success: false, error: '等待元素超时', current_url: location.href };
        }
        await sleepP(a.networkIdle ? 3000 : 1000);
        return { success: true, data: { networkIdle: !!a.networkIdle }, current_url: location.href };
      }
      case 'browser_keypress': {
        const active = document.activeElement || document.body;
        const mods = a.modifiers || [];
        const codeMap = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 };
        const code = codeMap[a.keys] || (a.keys ? a.keys.charCodeAt(0) : 0);
        const opts = {
          key: a.keys, code: a.keys, keyCode: code, which: code, bubbles: true, cancelable: true,
          ctrlKey: mods.includes('Control'), metaKey: mods.includes('Meta'),
          shiftKey: mods.includes('Shift'), altKey: mods.includes('Alt'),
        };
        for (const type of ['keydown', 'keypress', 'keyup']) active.dispatchEvent(new KeyboardEvent(type, opts));
        return { success: true, data: { keys: a.keys, modifiers: mods }, current_url: location.href };
      }
      default:
        return { success: false, error: '未知工具: ' + tool, current_url: location.href };
    }
  }
  return run().catch((e) => ({ success: false, error: '执行异常: ' + (e && e.message || e), current_url: location.href }));
}

/* -------------------------------------------------------------------------
 * bpShowConfirm — 注入目标页的「敏感操作确认弹窗」，返回 Promise<boolean>
 * ------------------------------------------------------------------------- */
function bpShowConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:sans-serif;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;color:#222;padding:20px 24px;border-radius:12px;max-width:420px;box-shadow:0 8px 30px rgba(0,0,0,.3)';
    const p = document.createElement('div');
    p.textContent = message;
    p.style.cssText = 'margin-bottom:16px;font-size:15px;line-height:1.5;white-space:pre-wrap;';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.style.cssText = 'padding:8px 16px;border:1px solid #ccc;background:#f5f5f5;border-radius:8px;cursor:pointer';
    const ok = document.createElement('button');
    ok.textContent = '确认执行';
    ok.style.cssText = 'padding:8px 16px;border:none;background:#e53935;color:#fff;border-radius:8px;cursor:pointer';
    const cleanup = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
    cancel.onclick = () => { cleanup(); resolve(false); };
    ok.onclick = () => { cleanup(); resolve(true); };
    wrap.appendChild(cancel); wrap.appendChild(ok);
    box.appendChild(p); box.appendChild(wrap);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

/* -------------------------------------------------------------------------
 * 导航 / 截图（background 直接处理，不走注入）
 * ------------------------------------------------------------------------- */
async function bpNavigate(args, senderTabId) {
  let target = await bpPickTarget(args, senderTabId);
  if (!target || bpIsAiTab((await getTabSafe(target))?.url)) {
    const t = await chrome.tabs.create({ url: args.url });
    target = t.id;
  } else {
    await chrome.tabs.update(target, { url: args.url });
  }
  await waitForTabLoad(target);
  bpCtx.targetTabId = target;
  const tab = await getTabSafe(target);
  return { success: true, data: { navigated: true, url: args.url }, current_url: tab ? tab.url : args.url };
}

async function bpScreenshot(args, senderTabId) {
  const target = bpCtx.targetTabId || (await bpPickTarget(args, senderTabId));
  if (!target) return { success: false, error: '没有可截图的目标页', current_url: '' };
  await chrome.tabs.update(target, { active: true });
  await sleep(400);
  const tab = await getTabSafe(target);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  await chrome.tabs.update(senderTabId, { active: true });
  return { success: true, data: { screenshot: dataUrl, note: '仅捕获可见区域（MV3 限制，非整页长图）' }, current_url: tab ? tab.url : '' };
}

/* -------------------------------------------------------------------------
 * 主入口：分发 BrowserPilot 工具调用
 * ------------------------------------------------------------------------- */
async function handleBrowserPilot(payload, reply, sender) {
  const { tool, args = {} } = payload || {};
  const senderTabId = sender && sender.tab ? sender.tab.id : null;
  try {
    if (tool === 'browser_navigate') return reply(true, await bpNavigate(args, senderTabId));
    if (tool === 'browser_screenshot') return reply(true, await bpScreenshot(args, senderTabId));

    const target = await bpPickTarget(args, senderTabId);
    if (!target) {
      return reply(true, { success: false, error: '未找到目标标签页：请先打开想操作的网页，或先用 browser_navigate 打开。', current_url: '' });
    }
    bpCtx.targetTabId = target; // 锁定上下文

    // 敏感拦截（仅 click / type）
    if (tool === 'browser_click' || tool === 'browser_type') {
      const info = await bpInject(target, bp_exec, { tool, mode: 'probe', ...args });
      if (info && info.success && info.found && bpIsSensitive(info)) {
        try {
          chrome.notifications.create({
            type: 'basic', title: 'BrowserPilot 敏感操作待确认',
            message: '检测到：' + (info.text || info.tagName) + '。请在页面弹窗中点击「确认执行」。',
          });
        } catch (_) {}
        const confirmed = await bpInject(target, bpShowConfirm,
          'BrowserPilot 检测到敏感操作：\n「' + (info.text || info.tagName) + '」\n涉及支付 / 密码 / 发送 / 删除等，确认执行？');
        if (!confirmed) {
          return reply(true, { success: false, error: '用户取消了敏感操作', current_url: info.current_url || '' });
        }
      }
    }

    const result = await bpInject(target, bp_exec, { tool, mode: 'act', ...args });
    reply(true, result);
  } catch (e) {
    reply(false, null, e && e.message ? e.message : String(e));
  }
}

/* 弹窗触发：把协议文档注入到当前活跃的 AI 对话页 */
function bpInjectProtocolToActiveAiTab(reply) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs[0];
    if (!t || !bpIsAiTab(t.url)) {
      reply(false, null, '请先打开 Kimi / DeepSeek / MiniMax 的对话页面，再点此按钮');
      return;
    }
    chrome.tabs.sendMessage(t.id, { type: 'BP_INJECT_PROTOCOL' }, (resp) => {
      if (chrome.runtime.lastError) {
        reply(false, null, '无法注入（请刷新 AI 页面后重试）：' + chrome.runtime.lastError.message);
        return;
      }
      reply(true, resp && resp.ok ? resp.data : { injected: true });
    });
  });
}


/* =========================================================================
 * 开发者模式 · 篡改模块（Tamper）
 * - 密码门禁：TAMPER_SET_DEV 校验密码后写 storage.local.devMode
 * - 所有 TAMPER_LIST / TAMPER_OP 均先检查 devMode，绕过 UI 也调不动
 * - 仅使用 Chrome 官方 API（history/bookmarks/downloads/cookies），不会损坏浏览器
 * - 边界（Chrome API 硬约束）：
 *     历史可「新增（时间为现在，可指定次数）」与「删除」，不能改已有条目的时间戳/次数
 *     书签可完全增删改；下载记录可删除；Cookie 可改值/删除
 * ========================================================================= */
const TAMPER_PASS = '248635';

function tamperReady() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ devMode: false }, (r) => resolve(!!r.devMode));
  });
}

function handleTamperSetDev(payload, reply) {
  const pass = String(payload.pass || '');
  if (pass !== TAMPER_PASS) return reply(false, null, '密码错误');
  chrome.storage.local.set({ devMode: !!payload.on }, () => reply(true, { devMode: !!payload.on }));
}

/* 列表：history / bookmarks / downloads / cookies */
function handleTamperList(payload, reply) {
  tamperReady().then((ok) => {
    if (!ok) return reply(false, null, '未开启开发者模式');
    const kind = payload.kind;
    if (kind === 'history') {
      chrome.history.search(
        { text: payload.query || '', startTime: Date.now() - 90 * 864e5, endTime: Date.now(), maxResults: 500 },
        (items) => {
          if (chrome.runtime.lastError) return reply(false, null, chrome.runtime.lastError.message);
          reply(true, (items || []).map(normItem));
        }
      );
      return;
    }
    if (kind === 'bookmarks') {
      chrome.bookmarks.getTree((tree) => {
        if (chrome.runtime.lastError) return reply(false, null, chrome.runtime.lastError.message);
        const out = [];
        (function walk(nodes, path) {
          (nodes || []).forEach((n) => {
            if (n.url) out.push({ id: n.id, title: n.title, url: n.url, path });
            if (n.children) walk(n.children, path + ' / ' + (n.title || 'root'));
          });
        })(tree, '');
        reply(true, out);
      });
      return;
    }
    if (kind === 'downloads') {
      chrome.downloads.search({ limit: 200, orderBy: ['-startTime'] }, (items) => {
        if (chrome.runtime.lastError) return reply(false, null, chrome.runtime.lastError.message);
        reply(true, items || []);
      });
      return;
    }
    if (kind === 'cookies') {
      chrome.cookies.getAll({}, (cookies) => {
        if (chrome.runtime.lastError) return reply(false, null, chrome.runtime.lastError.message);
        reply(
          true,
          (cookies || []).map((c) => ({
            name: c.name, domain: c.domain, value: c.value,
            path: c.path, secure: c.secure, storeId: c.storeId,
          }))
        );
      });
      return;
    }
    reply(false, null, '未知类别: ' + kind);
  });
}

/* 操作：统一入口，op + args */
async function handleTamperOp(payload, reply) {
  if (!(await tamperReady())) return reply(false, null, '未开启开发者模式');
  const op = payload.op;
  const a = payload.args || {};
  const call = (api, opts) =>
    new Promise((resolve, reject) =>
      api(opts, (res) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(res)))
    );
  try {
    switch (op) {
      /* ---- 历史 ---- */
      case 'history_add': {
        if (!a.url) return reply(false, null, '缺少 url');
        const n = Math.max(1, Math.min(50, parseInt(a.count, 10) || 1));
        for (let i = 0; i < n; i++) await call(chrome.history.addUrl.bind(chrome.history), { url: a.url });
        return reply(true, { added: n, url: a.url });
      }
      case 'history_delete':
        await call(chrome.history.deleteUrl.bind(chrome.history), { url: a.url });
        return reply(true, true);
      case 'history_delete_domain': {
        const items = await call(chrome.history.search.bind(chrome.history),
          { text: a.domain || '', startTime: 0, endTime: Date.now(), maxResults: 10000 });
        let n = 0;
        for (const it of items || []) {
          let host = '';
          try { host = new URL(it.url).hostname; } catch (_e) { /* 忽略非法 URL */ }
          if (a.domain && (host === a.domain || host.endsWith('.' + a.domain))) {
            await call(chrome.history.deleteUrl.bind(chrome.history), { url: it.url });
            n++;
          }
        }
        return reply(true, { deleted: n });
      }
      case 'history_delete_range': {
        const days = Math.max(0, parseInt(a.days, 10) || 0);
        await call(chrome.history.deleteRange.bind(chrome.history),
          { startTime: 0, endTime: Date.now() - days * 864e5 });
        return reply(true, { keptDays: days });
      }
      case 'history_delete_all':
        await new Promise((resolve, reject) =>
          chrome.history.deleteAll(() => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve())));
        return reply(true, true);
      /* ---- 书签 ---- */
      case 'bookmark_create': {
        const b = await call(chrome.bookmarks.create.bind(chrome.bookmarks),
          { parentId: a.parentId || '1', title: a.title || '未命名', url: a.url });
        return reply(true, b);
      }
      case 'bookmark_save': {
        const ch = {};
        if (a.title != null) ch.title = a.title;
        if (a.url != null) ch.url = a.url;
        const b = await call(chrome.bookmarks.update.bind(chrome.bookmarks), a.id, ch);
        return reply(true, b);
      }
      case 'bookmark_delete':
        await new Promise((resolve, reject) =>
          chrome.bookmarks.remove(a.id, () => {
            if (!chrome.runtime.lastError) return resolve();
            chrome.bookmarks.removeTree(a.id, () =>
              chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve());
          }));
        return reply(true, true);
      /* ---- 下载 ---- */
      case 'downloads_erase': {
        const q = a.all ? {} : { id: a.id };
        const ids = await call(chrome.downloads.erase.bind(chrome.downloads), q);
        return reply(true, { erased: (ids || []).length });
      }
      /* ---- Cookie ---- */
      case 'cookie_set': {
        await call(chrome.cookies.set.bind(chrome.cookies),
          { url: a.url, name: a.name, value: a.value == null ? '' : String(a.value) });
        return reply(true, true);
      }
      case 'cookie_remove':
        await call(chrome.cookies.remove.bind(chrome.cookies), { url: a.url, name: a.name });
        return reply(true, true);
      default:
        return reply(false, null, '未知篡改操作: ' + op);
    }
  } catch (e) {
    return reply(false, null, e && e.message ? e.message : String(e));
  }
}




/* =========================================================================
 * 专注模式 v2（后台侧）：注意力状态机 + 自适应威胁模型 + 番茄周期
 *
 * 状态机（每次黑名单访问独立评估）：
 *   命中黑名单站点 → 进入「评估中」(dwell)
 *     ├─ 停留 < 45s 后离开 → resisted（忍住）✅
 *     └─ 停留 ≥ 45s        → broken（破戒）❌
 *
 * 自适应提醒（对抗习惯化）：
 *   - 同一 host 的提醒间隔从 90s 起，每次 ×1.35，封顶 5 分钟
 *   - 提醒文案轮换（6 条），避免「看腻失效」
 *
 * 威胁评分（建议黑名单，而非硬拦）：
 *   threat(d) = 0.5·norm(近30天访问次数) + 0.3·norm(专注期犯戒次数) + 0.2·新近度
 *
 * 番茄周期：会话结束（自然到期）后自动安排 5 分钟短休 / 每 4 轮 15 分钟长休，
 *   focusStats 统计完成数与连续天数，用于建议下次时长。
 * ========================================================================= */
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const focusNudgeAt = {};    // host -> 上次提醒时间
const focusNudgeN = {};     // host -> 本次会话提醒次数（习惯化计数）
const focusDwell = {};      // tabId -> {host, since}  评估中的黑名单访问
const FOCUS_DWELL_MS = 45000;

const FOCUS_NUDGE_MSGS = [
  '正在专注中，这个站点先放一放？',
  '「{host}」在黑名单里，剩余 {min} 分钟。深呼吸，回去！',
  '刚刚才专注没多久，别让 {host} 打断你。',
  '再坚持 {min} 分钟，今天的你就赢了昨天的你。',
  '提醒：你正在专注模式里。{host} 可以稍后再看。',
  '忍一次是一次 —— {host} 已被记录。',
];

function focusHostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_e) { return ''; }
}

function focusGet(keys) {
  return new Promise((r) => chrome.storage.local.get(keys, (x) => r(x)));
}
function focusSet(obj) {
  return new Promise((r) => chrome.storage.local.set(obj, r));
}
function focusNotify(title, message) {
  try { chrome.notifications.create({ type: 'basic', title, message }); } catch (_e) { /* 忽略 */ }
}

/* ---------- 开始专注 ---------- */
async function handleFocusStart(payload, reply) {
  const minutes = clamp(Math.round(payload.minutes || 25), 5, 240);
  const blocklist = (payload.blocklist || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const pomodoro = !!payload.pomodoro;
  const start = Date.now();
  await focusSet({
    focus: { start, until: start + minutes * 60000, minutes, blocklist, pomodoro },
    focusEvents: [], // 新会话清空事件
  });
  for (const k of Object.keys(focusNudgeAt)) delete focusNudgeAt[k];
  for (const k of Object.keys(focusNudgeN)) delete focusNudgeN[k];
  try {
    chrome.alarms.create('hc-focus-end', { when: start + minutes * 60000 });
    chrome.action.setBadgeText({ text: String(minutes) });
    chrome.action.setBadgeBackgroundColor({ color: '#4c7bf3' });
  } catch (_e) { /* 忽略 */ }
  reply(true, { started: true, until: start + minutes * 60000 });
}

/* ---------- 当前状态（弹窗轮询） ---------- */
async function handleFocusState(reply) {
  const { focus, focusEvents } = await focusGet({ focus: null, focusEvents: [] });
  if (!focus) {
    const suggestion = await suggestNextMinutes();
    return reply(true, { active: false, suggestion });
  }
  const now = Date.now();
  if (focus.until <= now) { // 已过期但 alarm 尚未触发（SW 曾休眠）
    await finalizeFocus(true);
    return reply(true, { active: false });
  }
  const ev = (focusEvents || []).filter((e) => e.t >= focus.start);
  reply(true, {
    active: true,
    focus,
    timeLeftMs: focus.until - now,
    nudges: ev.filter((e) => e.kind === 'nudge').length,
    resisted: ev.filter((e) => e.kind === 'resist').length,
    broken: ev.filter((e) => e.kind === 'broke').length,
    recent: ev.slice(-12).reverse(),
  });
}

/* ---------- 威胁评分（Top 建议） ---------- */
async function handleFocusThreats(reply) {
  const { focusBlocklist: list, focusEvents, focus } = await focusGet({ focusBlocklist: [], focusEvents: [], focus: null });
  const items = await new Promise((r) =>
    chrome.history.search({ text: '', startTime: Date.now() - 30 * 864e5, endTime: Date.now(), maxResults: 10000 },
      (x) => r(x || [])));
  const visits = {};   // host -> 次数
  const lastSeen = {}; // host -> 最近访问时间
  for (const it of items) {
    const h = focusHostOf(it.url);
    if (!h) continue;
    visits[h] = (visits[h] || 0) + (it.visitCount || 1);
    lastSeen[h] = Math.max(lastSeen[h] || 0, it.lastVisitTime || 0);
  }
  const tempt = {}; // host -> 专注期提醒次数（含历史会话）
  (focusEvents || []).forEach((e) => { if (e.host) tempt[e.host] = (tempt[e.host] || 0) + 1; });
  const maxV = Math.max(1, ...Object.values(visits));
  const now = Date.now();
  const threats = Object.keys(visits)
    .filter((h) => h && !h.startsWith('chrome') && visits[h] >= 5)
    .map((h) => {
      const v = visits[h] / maxV;                                   // 频次 0-1
      const t = clamp((tempt[h] || 0) / 6, 0, 1);                   // 犯戒史 0-1
      const recency = clamp01(1 - (now - (lastSeen[h] || 0)) / (30 * 864e5)); // 新近度
      const threat = 0.5 * v + 0.3 * t + 0.2 * recency;
      return { host: h, visits: visits[h], temptations: tempt[h] || 0, threat: Math.round(threat * 100) / 100 };
    })
    .filter((x) => x.threat >= 0.35)
    .sort((a, b) => b.threat - a.threat)
    .slice(0, 12)
    .map((x) => ({ ...x, inList: list.includes(x.host) }));
  reply(true, { threats, inFocus: !!focus });
}

/* ---------- 标签检查：状态机 + 自适应提醒 ---------- */
async function focusCheckTab(tab) {
  if (!tab || !tab.active || !tab.url || !tab.url.startsWith('http')) return;
  const { focus } = await focusGet({ focus: null });
  if (!focus || focus.until <= Date.now()) return;
  const host = focusHostOf(tab.url);
  if (!host) return;
  const list = (focus.blocklist || []).map((s) => String(s).trim().toLowerCase());
  const hit = list.some((d) => host === d || host.endsWith('.' + d));
  if (!hit) return;

  const now = Date.now();
  // 状态机：标记「评估中」的访问
  if (!focusDwell[tab.id] || focusDwell[tab.id].host !== host) {
    focusDwell[tab.id] = { host, since: now };
  }

  // 自适应提醒间隔：90s × 1.35^n，封顶 5 分钟
  const n = focusNudgeN[host] || 0;
  const interval = Math.min(90000 * Math.pow(1.35, n), 300000);
  if (focusNudgeAt[host] && now - focusNudgeAt[host] < interval) return;
  focusNudgeAt[host] = now;
  focusNudgeN[host] = n + 1;

  const mins = Math.max(1, Math.round((focus.until - now) / 60000));
  const msg = FOCUS_NUDGE_MSGS[n % FOCUS_NUDGE_MSGS.length]
    .replace('{host}', host).replace('{min}', String(mins));
  focusNotify('🎯 专注模式', msg);

  const { focusEvents } = await focusGet({ focusEvents: [] });
  (focusEvents || []).push({ t: now, host, kind: 'nudge' });
  await focusSet({ focusEvents: (focusEvents || []).slice(-200) });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' || info.url) focusCheckTab(tab);
});
chrome.tabs.onActivated.addListener((ai) => {
  getTabSafe(ai.tabId).then(focusCheckTab);
});

/* 离开黑名单站点时评估 dwell：忍住 or 破戒 */
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  const d = focusDwell[tabId];
  if (!d) return;
  const host = focusHostOf(tab && tab.url);
  if (host && (host === d.host || host.endsWith('.' + d.host))) return; // 还在该站
  const dwellMs = Date.now() - d.since;
  delete focusDwell[tabId];
  if (dwellMs < 5000) return; // 误判（瞬时跳转）
  (async () => {
    const { focus } = await focusGet({ focus: null });
    if (!focus || focus.until <= Date.now()) return;
    const kind = dwellMs >= FOCUS_DWELL_MS ? 'broke' : 'resist';
    const { focusEvents } = await focusGet({ focusEvents: [] });
    (focusEvents || []).push({ t: Date.now(), host: d.host, kind, dwellMs });
    await focusSet({ focusEvents: (focusEvents || []).slice(-200) });
    if (kind === 'resist') focusNotify('💪 干得漂亮', '你离开了「' + d.host + '」，已记入「忍住」。');
  })();
});

/* ---------- 结束/到期：生成报告 + 番茄排程 ---------- */
async function finalizeFocus(auto) {
  const { focus, focusEvents, focusStats } = await focusGet({ focus: null, focusEvents: [], focusStats: { completed: 0, cycle: 0, streak: 0, lastDay: '' } });
  if (!focus) return { ended: false };
  const now = Date.now();
  const ev = (focusEvents || []).filter((e) => e.t >= focus.start);
  const nudges = ev.filter((e) => e.kind === 'nudge').length;
  const resisted = ev.filter((e) => e.kind === 'resist').length;
  const broken = ev.filter((e) => e.kind === 'broke').length;
  const completed = now >= focus.until - 5000;
  // 专注效率：1 - 破戒×0.15 - 提醒×0.03，下限 0
  const efficiency = Math.max(0, Math.round((1 - broken * 0.15 - nudges * 0.03) * 100) / 100);

  const report = {
    start: focus.start, end: now, minutes: focus.minutes,
    nudges, resisted, broken, efficiency, completed, auto: !!auto,
  };
  const reports = ((await focusGet({ focusReports: [] })).focusReports || []);
  reports.push(report);
  await focusSet({
    focus: null,
    lastFocusReport: report,
    focusReports: reports.slice(-30),
    focusStats: {
      ...focusStats,
      completed: focusStats.completed + (completed ? 1 : 0),
      cycle: focusStats.cycle + (completed ? 1 : 0),
      streak: completed ? focusStats.streak + 1 : 0,
      lastDay: new Date().toDateString(),
    },
  });
  try { chrome.action.setBadgeText({ text: '' }); } catch (_e) { /* 忽略 */ }
  for (const k of Object.keys(focusDwell)) delete focusDwell[k];

  // 番茄周期：自然到期才排休息
  if (auto && focus.pomodoro && completed) {
    const cycle = (focusStats.cycle || 0) + 1;
    const breakMin = cycle % 4 === 0 ? 15 : 5;
    try { chrome.alarms.create('hc-focus-break', { when: now + breakMin * 60000 }); } catch (_e) { /* 忽略 */ }
    focusNotify('🍅 番茄完成！', '休息 ' + breakMin + ' 分钟，我会提醒你回来开始下一个番茄。');
  } else if (!completed) {
    focusNotify('专注已结束', '本次提前结束：专注效率 ' + Math.round(efficiency * 100) + '%。');
  }
  return report;
}

chrome.alarms.onAlarm.addListener((al) => {
  if (al.name === 'hc-focus-end') {
    finalizeFocus(true);
  } else if (al.name === 'hc-focus-break') {
    focusNotify('☕ 休息结束', '准备好就开始下一个番茄吧 —— 打开扩展的「专注模式」点击开始。');
  }
});

/* 建议下次时长：按最近 5 次完成率 */
async function suggestNextMinutes() {
  const { focusReports } = await focusGet({ focusReports: [] });
  const last5 = (focusReports || []).slice(-5);
  if (last5.length < 2) return 25;
  const doneRate = last5.filter((r) => r.completed).length / last5.length;
  const avgMin = last5.reduce((a, r) => a + r.minutes, 0) / last5.length;
  let sug = avgMin;
  if (doneRate >= 0.8) sug = Math.min(90, avgMin + 10);      // 完成率高 → 加量
  else if (doneRate <= 0.4) sug = Math.max(15, avgMin - 10); // 完成率低 → 减量
  return Math.round(sug / 5) * 5;
}
