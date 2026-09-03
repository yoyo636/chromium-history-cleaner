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

/* CAP 必须等于「浏览器单次实际能返回的最大条数」，否则触顶判定永远为假、
 * 二分永不触发 —— 表现就是「查询被静默截断到 CAP 条，历史永远删不完」。
 * chrome.history.search 的 maxResults 默认 100，实测单次上限也是 100。 */
let CAP = 100; // 可被自检下调：若实测浏览器上限低于 100，运行时自适应修正
/* 二分深度：时间轴是 [1970, now] 约 56 年，而历史往往集中在最近几个月。
 * 光把「有数据的那一段」从 56 年里切出来就要十几层，再切到每窗 <100 条又要几层。
 * 12 层在真实数据上不够，会静默丢数据，故放到 28（触顶路径才会递归，空窗口一层就返回）。 */
const MAX_DEPTH = 28;

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
  if (endTime < startTime) return arr;
  const items = await historySearch(startTime, endTime, CAP);
  // 触顶 = 本窗口很可能还有没返回的记录 → 继续对半拆
  // 但必须留退路：深度用尽或时间粒度已到 1ms 时，保留本次结果而不是丢弃
  const splittable = endTime - startTime >= 1;
  if (items.length >= CAP && depth < MAX_DEPTH && splittable) {
    const mid = startTime + Math.floor((endTime - startTime) / 2);
    await collectAll(arr, startTime, mid, depth + 1);
    await collectAll(arr, mid + 1, endTime, depth + 1);
    return arr;
  }
  arr.push(...items); // 未触顶（已取全），或无法再拆（宁可不全，也不能丢）
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

/* ------------------------- 自检（跨浏览器诊断） -------------------------
 * CAP 是按 Chromium 实测硬编码的，但不同内核/版本的上限未必一样。
 * 这个自检把「浏览器单次到底返回多少条」实测出来，让用户可以自己证实
 * 查询有没有被截断，而不是靠「感觉删不干净」。 */
async function historyDiagnostics() {
  const PROBE = 1000;
  const out = {
    cap: CAP,
    probeRequested: PROBE,
    probeReturned: null,
    capInferred: null,
    totalCount: null,
    apiOk: {},
    error: null,
    scanError: null,
  };
  out.apiOk = {
    history: !!chrome.history,
    search: !!(chrome.history && chrome.history.search),
    deleteUrl: !!(chrome.history && chrome.history.deleteUrl),
    deleteRange: !!(chrome.history && chrome.history.deleteRange),
    deleteAll: !!(chrome.history && chrome.history.deleteAll),
    browsingData: !!(chrome.browsingData && chrome.browsingData.remove),
  };
  try {
    const now = Date.now();
    const probe = await historySearch(0, now, PROBE);
    out.probeReturned = probe.length;
    out.fullWindow = probe.length;
    /* 单窗口查询无法区分「返回 R 条」是浏览器上限还是真实总量 ——
     * maxResults 是我们自己传的，返回数永远 ≤ maxResults。
     * 可靠判据：以 probe 里最早一条的时间为分割点切两半。
     * probe 是最新的一批，若更早的半窗还有数据，halfSum 必然 > fullWindow → 存在截断。 */
    if (probe.length === 0) {
      out.halfSum = 0;
      out.capInferred = '无历史数据';
    } else {
      const splitAt = probe[probe.length - 1].lastVisitTime || 0;
      const left = splitAt > 0 ? await historySearch(0, splitAt - 1, PROBE) : [];
      const right = await historySearch(splitAt, now, PROBE);
      out.halfSum = left.length + right.length;
      if (probe.length >= PROBE) {
        out.capInferred = '≥' + PROBE + '（单次能返回 ' + PROBE + ' 条以上）';
      } else if (out.halfSum > probe.length) {
        out.capInferred = '全窗单次只返回 ' + probe.length + ' 条，但以 probe 最早一条为界，'
          + '两窗合计 ' + out.halfSum + ' 条 → 确认被浏览器上限截断，二分机制在工作';
        /* 自适应：实测上限可能低于代码 CAP，下调以保证触顶判定可靠 */
        if (probe.length < CAP) {
          CAP = Math.max(10, probe.length);
          out.capAdjusted = CAP;
        }
      } else {
        out.capInferred = '全窗 ' + probe.length + ' 条 = 两窗之和，未触到浏览器上限';
      }
    }
  } catch (e) {
    out.error = e.message;
  }
  try {
    const all = await searchAll(0, Date.now());
    out.totalCount = all.length;
  } catch (e) {
    out.scanError = e.message;
  }
  return out;
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
  const splittable = endTime - startTime >= 1;
  if (hitCap && depth < MAX_DEPTH && splittable) {
    const mid = startTime + Math.floor((endTime - startTime) / 2);
    await walkStats(acc, startTime, mid, depth + 1);
    await walkStats(acc, mid + 1, endTime, depth + 1);
    return;
  }
  // 深度/粒度用尽时仍要把这批算进去，并如实标记「统计不完整」
  if (hitCap) acc.limited = true;
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

/* ------------------------- 消息来源校验 -------------------------
 * 边界约定：
 *   - 扩展页（popup.html）：sender 无 tab
 *   - 内容脚本：sender.tab 存在，sender.tab.url 为所在页面 URL
 * 历史/标签/音频/隐私等写操作只允许扩展页发起（内容脚本一律拒绝）。 */
function fromContentScript(sender) {
  return !!(sender && sender.tab);
}

function isOwnExtension(sender) {
  return !sender || !sender.id || sender.id === chrome.runtime.id;
}

/* --------------------------- 消息分发 --------------------------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg && msg.type;
  const payload = (msg && msg.payload) || {};
  const reply = (ok, data, error) =>
    sendResponse({ ok, data: data == null ? null : data, error: error || null });

  if (!isOwnExtension(_sender)) return reply(false, null, '仅接受本扩展消息');

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

    case 'HISTORY_DIAG':
      historyDiagnostics()
        .then((d) => reply(true, d))
        .catch((e) => reply(false, null, e.message));
      return true;

    case 'DELETE_RANGE':
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可执行删除');
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
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可执行删除');
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
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可操作标签页');
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
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可设置静音');
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

    /* 等全部回调后返回真实成功数（旧版立即返回「尝试数」，失败对用户不可见） */
    case 'AUDIO_MUTE_ALL':
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可设置静音');
      chrome.tabs.query({ audible: true }, (tabs) => {
        const ids = (tabs || []).map((t) => t.id).filter((x) => x != null);
        if (!ids.length) return reply(true, 0);
        Promise.all(ids.map((id) => new Promise((res) =>
          chrome.tabs.update(id, { muted: true }, () => res(!chrome.runtime.lastError)))))
          .then((rs) => reply(true, rs.filter(Boolean).length));
      });
      return true;

    case 'AUDIO_ANALYZE':
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可发起分析');
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
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可切换模式');
      chrome.storage.local.set({ privacyMode: payload.mode }, () => reply(true, true));
      return true;

    case 'PRIVACY_CLEAR':
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可清空记录');
      chrome.storage.local.set({ privacyEvents: [] }, () => reply(true, true));
      return true;

    /* --------------------- 开发者模式 · 篡改（密码门禁在后台） --------------------- */
    case 'RE_SET_UNLOCK':
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可操作');
      handleReEstateUnlock(payload, reply);
      return true;

    case 'TAMPER_SET_DEV':
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可操作');
      handleTamperSetDev(payload, reply);
      return true;

    case 'TAMPER_LIST':
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可操作');
      handleTamperList(payload, reply);
      return true;

    case 'TAMPER_OP':
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可操作');
      handleTamperOp(payload, reply);
      return true;

    case 'FOCUS_START':
      handleFocusStart(payload, reply);
      return true;

    case 'FOCUS_STATE':
      handleFocusState(reply);
      return true;

    /* Day5：分心原因速记 —— 给最近一次 resist/broke 事件补记原因 */
    case 'FOCUS_REASON':
      handleFocusReason(payload, reply);
      return true;

    case 'FOCUS_THREATS':
      handleFocusThreats(reply);
      return true;

    case 'FOCUS_END':
      finalizeFocus(false).then((r) => reply(true, r));
      return true;

    /* --------------------------- 广告拦截 --------------------------- */
    case 'ADBLOCK_GET':
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可查询');
      getAdblockState()
        .then((s) => reply(true, s))
        .catch((e) => reply(false, null, e.message));
      return true;

    case 'ADBLOCK_TOGGLE':
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可切换');
      setAdblockEnabled(!!payload.on)
        .then((s) => reply(true, s))
        .catch((e) => reply(false, null, e.message));
      return true;

    case 'ADBLOCK_ALLOW':
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可加白');
      allowSite(payload.host, true)
        .then((s) => reply(true, s))
        .catch((e) => reply(false, null, e.message));
      return true;

    case 'ADBLOCK_UNALLOW':
      if (fromContentScript(_sender)) return reply(false, null, '仅扩展页可取消');
      allowSite(payload.host, false)
        .then((s) => reply(true, s))
        .catch((e) => reply(false, null, e.message));
      return true;

    case 'ADBLOCK_REPORT':
      // 来自内容脚本的拦截计数上报
      bumpAdblockCount(payload.count || 0).then(() => reply(true, true)).catch(() => reply(true, true));
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
 *   lastPageType: 'code'|'article'|'table'|'generic'   // Day2：最近一次页面类型
 *   pageTypeMinutes: {code,article,table,generic}      // Day2：按类型累计高强度分钟
 *   diagnostics: {...}                                 // Day6：引擎自诊断快照
 * }
 * ------------------------------------------------------------------------- */
const FATIGUE_BUCKET_MS = 10 * 60000;
// Day2：页面类型白名单（上报值需校验后入库，脏数据一律按 generic 处理）
const PAGE_TYPES = ['code', 'article', 'table', 'generic'];

function fatigueDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function handleFatigueReport(payload) {
  return new Promise((resolve) => {
    const now = Date.now();
    chrome.storage.local.get({ eyecare: null, eyecareHistory: [] }, async (r) => {
      let ec = r.eyecare;
      const today = fatigueDate(now);
      if (!ec || ec.date !== today) {
        /* Day4：跨天时先把昨日曲线汇总成「日画像」，供周级统计（μ/σ + 离群日） */
        let hist = (r.eyecareHistory || []).slice();
        if (ec && ec.date && (ec.log || []).length) {
          const scores = (ec.log || []).map((p) => p.score).filter((s) => typeof s === 'number');
          if (scores.length) {
            hist.push({
              date: ec.date,
              minutes: Math.round(ec.minutes || 0),
              avg: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10,
              max: Math.max(...scores),
              samples: scores.length,
            });
            // 保留约两个月：必须用切片收敛，只 shift 一次的话长度会卡在超限的旧值上
            if (hist.length > 60) hist = hist.slice(-60);
          }
        }
        await new Promise((res) => chrome.storage.local.set({ eyecareHistory: hist }, res));
        // 跨天重置曲线（保留开关）
        ec = {
          enabled: ec ? ec.enabled !== false : true,
          log: [],
          minutes: 0,
          date: today,
          pageTypeMinutes: { code: 0, article: 0, table: 0, generic: 0 },
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
      ec.minutes = (ec.minutes || 0) + (payload.activeDeltaMs || 0) / 60000;
      ec.lastLevel = payload.level;
      ec.lastScore = payload.score;
      ec.updatedAt = now;
      // Day2：按页面类型累计高强度分钟（弹窗展示「今天的时间花在哪类页面上」）
      const pt = PAGE_TYPES.indexOf(payload.pageType) >= 0 ? payload.pageType : 'generic';
      ec.lastPageType = pt;
      if (!ec.pageTypeMinutes) ec.pageTypeMinutes = { code: 0, article: 0, table: 0, generic: 0 };
      ec.pageTypeMinutes[pt] = (ec.pageTypeMinutes[pt] || 0) + (payload.activeDeltaMs || 0) / 60000;
      // Day6：引擎自诊断快照（各信号样本量 / 方差塌缩 / 健康度）
      if (payload.diagnostics) ec.diagnostics = payload.diagnostics;
      // Day8：本次的主要贡献信号与针对性休息建议
      if (payload.topSignal) ec.lastTopSignal = payload.topSignal;
      if (payload.advice != null) ec.lastAdvice = payload.advice;
      // Backlog：马尔可夫链（下一等级预测 + 稳态分布）
      if (payload.markov) ec.markov = payload.markov;

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
    /* 收敛：条目上限 200，超出按最旧 ts 淘汰（旧版无上限，长期堆积） */
    const keys = Object.keys(map);
    if (keys.length > 200) {
      keys.sort((a, b) => (map[a].ts || 0) - (map[b].ts || 0));
      for (let i = 0; i < keys.length - 200; i++) delete map[keys[i]];
    }
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

/* 标签页关闭后同步清理性能数据（旧版只增不删，条目永久堆积） */
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get({ perfTabs: {} }, (r) => {
    const map = r.perfTabs || {};
    if (!(tabId in map)) return;
    delete map[tabId];
    chrome.storage.local.set({ perfTabs: map });
  });
});

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
 * 开发者模式 · 篡改模块（Tamper）
 * - 密码门禁：TAMPER_SET_DEV 校验密码后写 storage.local.devMode
 * - 所有 TAMPER_LIST / TAMPER_OP 均先检查 devMode，绕过 UI 也调不动
 * - 仅使用 Chrome 官方 API（history/bookmarks/downloads/cookies），不会损坏浏览器
 * - 边界（Chrome API 硬约束）：
 *     历史可「新增（时间为现在，可指定次数）」与「删除」，不能改已有条目的时间戳/次数
 *     书签可完全增删改；下载记录可删除；Cookie 可改值/删除
 * ========================================================================= */
const TAMPER_PASS = '248635';

/* 房地产开发（隐藏工具集）：与开发者模式同款密码门禁，密码在设置里二次输入开/关 */
const RE_ESTATE_PASS = 'easonwu12345';

/* =========================================================================
 * 广告拦截（Ad-block）
 * 网络层：declarativeNetRequest 静态规则集（rules/adblock-rules.json）拦截
 *         常见广告 / 追踪 / 数据交易域名；白名单通过「允许」动态规则实现。
 * 外观层：content_adblock.js 按保守选择器隐藏广告元素并上报计数。
 * 计数：每日 / 累计拦截数存 storage.local。
 * ========================================================================= */
const ADBLOCK_RULESET_ID = 'adblock-static';

function getAdblockState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      { adblockEnabled: true, adblockAllow: [], adblockToday: 0, adblockDate: '', adblockTotal: 0 },
      (r) => {
        let enabled = !!r.adblockEnabled;
        // 与浏览器实际生效的规则集对齐（避免存储与 DNR 漂移）
        if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.getEnabledRulesets) {
          chrome.declarativeNetRequest.getEnabledRulesets((sets) => {
            if (chrome.runtime.lastError) {
              resolve({ enabled, allow: r.adblockAllow || [], today: r.adblockToday, total: r.adblockTotal });
              return;
            }
            enabled = (sets || []).includes(ADBLOCK_RULESET_ID);
            resolve({ enabled, allow: r.adblockAllow || [], today: r.adblockToday, total: r.adblockTotal });
          });
        } else {
          resolve({ enabled, allow: r.adblockAllow || [], today: r.adblockToday, total: r.adblockTotal });
        }
      }
    );
  });
}

function setAdblockEnabled(on) {
  return new Promise((resolve, reject) => {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateEnabledRulesets) {
      return reject(new Error('当前浏览器不支持 declarativeNetRequest'));
    }
    const enable = !!on ? [ADBLOCK_RULESET_ID] : [];
    chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesets: enable, disableRulesets: [ADBLOCK_RULESET_ID] },
      () => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        chrome.storage.local.set({ adblockEnabled: !!on }, () => resolve({ enabled: !!on }));
      });
  });
}

// 白名单：通过一条「allow」动态规则覆盖静态规则集对该站发起的请求
function allowSite(host, allow) {
  return new Promise((resolve, reject) => {
    if (!host) return reject(new Error('缺少域名'));
    chrome.storage.local.get({ adblockAllow: [] }, (r) => {
      let list = (r.adblockAllow || []).slice();
      const has = list.includes(host);
      if (allow && !has) list.push(host);
      if (!allow && has) list = list.filter((h) => h !== host);
      chrome.storage.local.set({ adblockAllow: list }, () => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        syncAllowRules().then(() => resolve({ allow: list })).catch(reject);
      });
    });
  });
}

let _allowRuleId = 900000; // 动态规则 id 区间，避开静态 id（1..191）
function syncAllowRules() {
  return new Promise((resolve, reject) => {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) {
      return reject(new Error('当前浏览器不支持动态调整规则'));
    }
    chrome.storage.local.get({ adblockAllow: [] }, (r) => {
      const hosts = r.adblockAllow || [];
      const rules = hosts.map((h, i) => ({
        id: _allowRuleId + i,
        priority: 2, // 高于静态规则（priority 1），从而放行白名单域名
        action: { type: 'allow' },
        condition: {
          initiatorDomains: [h],
          resourceTypes: ['script', 'image', 'stylesheet', 'xmlhttprequest', 'sub_frame', 'ping', 'font', 'media', 'websocket', 'other'],
        },
      }));
      const removeIds = hosts.length
        ? []
        : []; // updateDynamicRules 用 addRules / removeRuleIds 时需要先取旧 id
      chrome.declarativeNetRequest.getDynamicRules((existing) => {
        const oldIds = (existing || []).map((x) => x.id);
        chrome.declarativeNetRequest.updateDynamicRules(
          { addRules: rules, removeRuleIds: oldIds },
          () => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve(true);
          }
        );
      });
    });
  });
}

// 内容脚本上报的外观拦截计数（累计 + 当日）
function bumpAdblockCount(n) {
  return new Promise((resolve) => {
    if (!n || n <= 0) return resolve(true);
    const today = new Date().toISOString().slice(0, 10);
    chrome.storage.local.get({ adblockToday: 0, adblockDate: '', adblockTotal: 0 }, (r) => {
      const sameDay = r.adblockDate === today;
      const todayCount = sameDay ? (r.adblockToday || 0) + n : n;
      chrome.storage.local.set(
        { adblockToday: todayCount, adblockDate: today, adblockTotal: (r.adblockTotal || 0) + n },
        () => resolve(true)
      );
    });
  });
}

function handleReEstateUnlock(payload, reply) {
  const pass = String(payload.pass || '');
  if (pass !== RE_ESTATE_PASS) return reply(false, null, '密码错误');
  chrome.storage.local.set({ reEstateUnlocked: !!payload.on }, () =>
    reply(true, { unlocked: !!payload.on }));
}

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
/* 运行态（提醒/停留/待触发）持久化到 storage.session：
 * MV3 SW 空闲约 30s 即被终止——旧版这些状态全在内存，
 * SW 休眠后 dwell 判定静默丢失（破戒不被记录）、pending 的
 * setTimeout 永不触发。重启后从 storage.session 恢复并重新排定时器。 */
const focusRt = { nudgeAt: {}, nudgeN: {}, dwell: {}, pending: {} };
const focusTimers = {}; // tabId -> setTimeout 句柄（句柄本身不可持久化）
const FOCUS_DWELL_MS = 45000;

function focusRtSave() {
  try { chrome.storage.session.set({ focusRt }); } catch (_e) { /* 忽略 */ }
}

/* 为某标签页排提醒定时器（SW 重启恢复时也走这里） */
function armNudgeTimer(tabId, rec, delayMs) {
  if (focusTimers[tabId]) clearTimeout(focusTimers[tabId]);
  focusTimers[tabId] = setTimeout(() => {
    delete focusTimers[tabId];
    rec.fired = true;
    delete focusRt.pending[tabId];
    focusRtSave();
    fireNudge(rec.host);
  }, delayMs);
}

(async function focusRtLoad() {
  try {
    const r = await chrome.storage.session.get({ focusRt: null });
    if (!r.focusRt) return;
    focusRt.nudgeAt = r.focusRt.nudgeAt || {};
    focusRt.nudgeN = r.focusRt.nudgeN || {};
    focusRt.dwell = r.focusRt.dwell || {};
    const pend = r.focusRt.pending || {};
    const now = Date.now();
    for (const [tabId, p] of Object.entries(pend)) {
      if (!p || p.fired) continue;
      focusRt.pending[tabId] = p;
      // SW 休眠期间已到期的提醒：立即补发（RL 延迟精度让给可用性）
      armNudgeTimer(Number(tabId), p, Math.max(0, (p.fireAt || now) - now));
    }
  } catch (_e) { /* 首次运行无数据 */ }
})();

/* ---- Backlog：强化学习式提醒时机（reward = 忍住率） ----
 * 观察：很多分心是「手滑点进去、自己两秒就退出来」，提醒反而打扰。
 * 策略：给每个 host 学一个「提醒延迟」 delay ∈ [0,60s]。
 *   - 未提醒就自己离开（resist 且 pending 未触发）→ reward +1 → delay +5s（多给自我纠正的机会）
 *   - 提醒过仍然破戒（broke 且已触发）          → reward −1 → delay −10s（下次更早拦）
 * 初始 0s（立即提醒），随数据自适应。 */
let focusNudgeDelay = {};   // host -> 延迟毫秒（持久化到 focusPolicy.delays）
const NUDGE_DELAY_MIN = 0;
const NUDGE_DELAY_MAX = 60000;

/* ---- Day7：时段敏感性 ----
 * 同一域名在深夜 vs 工作时段的「杀伤力」不同：深夜刷短视频比午后更致命。
 * 为每个域名维护 24 小时直方图，用「时段风险加权均值」刻画其高危程度。 */
let focusHostHours = {};    // host -> number[24]
function hourRisk(h) {
  if (h >= 23 || h <= 4) return 1.00;   // 深夜：自制力最低
  if (h >= 20) return 0.65;             // 晚间
  if (h >= 9 && h <= 18) return 0.30;   // 工作时段：相对可控
  return 0.45;                          // 清晨/傍晚过渡
}

/* ---- Day5：分心原因（速记） ---- */
const FOCUS_REASONS = [
  { id: 'habit', label: '习惯性手滑' },
  { id: 'need', label: '确实要查资料' },
  { id: 'mood', label: '焦虑 / 想逃避' },
  { id: 'notify', label: '被通知勾走' },
  { id: 'bored', label: '卡住了想换换脑子' },
];

const FOCUS_NUDGE_MSGS = [
  '正在专注中，这个站点先放一放？',
  '「{host}」在名单里，剩余 {min} 分钟。深呼吸，回去！',
  '刚刚才专注没多久，别让 {host} 打断你。',
  '再坚持 {min} 分钟，今天的你就赢了昨天的你。',
  '提醒：你正在专注模式里。{host} 可以稍后再看。',
  '忍一次是一次 —— {host} 已被记录。',
];
/* 白名单模式专用文案（语气不同：不是「禁止」，而是「不在此次许可内」） */
const FOCUS_NUDGE_MSGS_WHITE = [
  '这个站点不在本次专注的白名单里，先回主线？',
  '「{host}」未获许可，剩余 {min} 分钟。',
  '白名单模式：只有列出来的站点才算专注内。',
  '还剩 {min} 分钟，回到白名单站点上去吧。',
  '提醒：白名单模式下「{host}」会被记为分心。',
  '先记下来，专注结束再看 {host}。',
];

/* ---------- Day3：命中判定（黑名单正向 / 白名单反向） ---------- */
function hostMatches(host, list) {
  return list.some((d) => host === d || host.endsWith('.' + d));
}
/** 是否算「分心」：黑名单模式 = 命中即分心；白名单模式 = 不在列表内即分心 */
function isDistracting(host, focus) {
  if (!host) return false;
  const lower = (arr) => (arr || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (focus.mode === 'white') {
    const allow = lower(focus.allowlist);
    if (!allow.length) return false;      // 白名单为空则退化：不做任何拦截（保险）
    return !hostMatches(host, allow);
  }
  return hostMatches(host, lower(focus.blocklist));
}

/* ---------- 启动：载入持久化的 RL 策略与时段直方图 ---------- */
(async function loadFocusPolicy() {
  try {
    const s = await focusGet({ focusPolicy: null, focusHostHours: null });
    if (s.focusPolicy && s.focusPolicy.delays) focusNudgeDelay = s.focusPolicy.delays || {};
    if (s.focusHostHours) focusHostHours = s.focusHostHours || {};
  } catch (_e) { /* 首次运行无数据 */ }
})();

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

/** 追加一条专注事件（统一上限 200 条，避免 storage 膨胀） */
async function pushFocusEvent(ev) {
  const { focusEvents } = await focusGet({ focusEvents: [] });
  const list = (focusEvents || []).concat([ev]).slice(-200);
  await focusSet({ focusEvents: list });
  return list;
}

/** 关闭并清理某个标签页上待触发的提醒 */
function clearPending(tabId) {
  if (focusTimers[tabId]) {
    clearTimeout(focusTimers[tabId]);
    delete focusTimers[tabId];
  }
  if (focusRt.pending[tabId]) {
    delete focusRt.pending[tabId];
    focusRtSave();
  }
}

/* ---------- Backlog：RL 策略更新（reward ∈ {+1, −1}） ---------- */
async function updateNudgePolicy(host, reward) {
  const cur = focusNudgeDelay[host] || 0;
  const next = clamp(cur + (reward > 0 ? 5000 : -10000), NUDGE_DELAY_MIN, NUDGE_DELAY_MAX);
  if (next === cur) return cur;
  focusNudgeDelay[host] = next;
  const { focusPolicy } = await focusGet({ focusPolicy: null });
  await focusSet({ focusPolicy: { ...(focusPolicy || {}), delays: focusNudgeDelay } });
  return next;
}

/* ---------- Day7：记录该域名的分心时段 ---------- */
async function bumpHostHour(host, hour) {
  const arr = focusHostHours[host] || new Array(24).fill(0);
  arr[hour] = (arr[hour] || 0) + 1;
  focusHostHours[host] = arr;
  await focusSet({ focusHostHours });
}

/* ---------- Day5：分心原因速记 ---------- */
async function handleFocusReason(payload, reply) {
  const t = payload && payload.t;
  const host = payload && payload.host;
  const reason = payload && payload.reason;
  if (!t || !host || !reason) return reply(false, null, '参数不完整');
  const { focusEvents, focusReasonStats } = await focusGet({ focusEvents: [], focusReasonStats: {} });
  const list = focusEvents || [];
  // 定位：同一 host、时间差 2s 内、且是 resist/broke 的最近一条
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e.host === host && (e.kind === 'resist' || e.kind === 'broke') && Math.abs(e.t - t) < 2000) { idx = i; break; }
  }
  if (idx < 0) return reply(false, null, '未找到对应事件');
  list[idx].reason = reason;
  const stats = focusReasonStats || {};
  stats[reason] = (stats[reason] || 0) + 1;
  await focusSet({ focusEvents: list, focusReasonStats: stats });
  reply(true, { ok: true, reason, stats });
}

/* ---------- 开始专注 ---------- */
async function handleFocusStart(payload, reply) {
  const minutes = clamp(Math.round(payload.minutes || 25), 5, 240);
  const blocklist = (payload.blocklist || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const allowlist = (payload.allowlist || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const pomodoro = !!payload.pomodoro;
  // Day3：白名单模式 —— 只有列表内的站点算「专注内」，其余一律按分心评估
  const mode = payload.mode === 'white' ? 'white' : 'black';
  if (mode === 'white' && !allowlist.length) {
    return reply(false, null, '白名单模式需要至少一个允许域名，否则会把所有页面都判为分心');
  }
  const start = Date.now();
  await focusSet({
    focus: { start, until: start + minutes * 60000, minutes, blocklist, allowlist, mode, pomodoro },
    focusEvents: [], // 新会话清空事件
  });
  for (const k of Object.keys(focusRt.nudgeAt)) delete focusRt.nudgeAt[k];
  for (const k of Object.keys(focusRt.nudgeN)) delete focusRt.nudgeN[k];
  for (const k of Object.keys(focusRt.pending)) clearPending(k);
  focusRtSave();
  try {
    chrome.alarms.create('hc-focus-end', { when: start + minutes * 60000 });
    chrome.action.setBadgeText({ text: String(minutes) });
    chrome.action.setBadgeBackgroundColor({ color: '#4c7bf3' });
  } catch (_e) { /* 忽略 */ }
  reply(true, { started: true, until: start + minutes * 60000 });
}

/* ---------- 当前状态（弹窗轮询） ---------- */
async function handleFocusState(reply) {
  const { focus, focusEvents, focusReasonStats } = await focusGet({ focus: null, focusEvents: [], focusReasonStats: {} });
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
    mode: focus.mode || 'black',           // Day3
    reasonStats: focusReasonStats || {},   // Day5
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
  const tempt = {}; // host -> 专注期犯戒加权分（含历史会话）
  // Day5：主动登记过分心原因的事件可信度更高（用户确认了这次是分心），权重 ×1.25
  (focusEvents || []).forEach((e) => {
    if (!e.host) return;
    tempt[e.host] = (tempt[e.host] || 0) + (e.reason ? 1.25 : 1);
  });
  const maxV = Math.max(1, ...Object.values(visits));
  const now = Date.now();
  const nowHour = new Date().getHours();
  const currentRisk = hourRisk(nowHour);           // Day7：此刻的时段风险
  const threats = Object.keys(visits)
    .filter((h) => h && !h.startsWith('chrome') && visits[h] >= 5)
    .map((h) => {
      const v = visits[h] / maxV;                                   // 频次 0-1
      const t = clamp((tempt[h] || 0) / 6, 0, 1);                   // 犯戒史 0-1
      const recency = clamp01(1 - (now - (lastSeen[h] || 0)) / (30 * 864e5)); // 新近度
      /* Day7：时段敏感性 —— 该域名的分心事件集中在什么时段发生 */
      const hist = focusHostHours[h];
      let timeSens = 0.5;  // 无数据取中性
      let peakHour = null;
      let nightShare = 0;
      if (hist) {
        const total = hist.reduce((a, b) => a + b, 0);
        if (total > 0) {
          timeSens = hist.reduce((a, c, i) => a + c * hourRisk(i), 0) / total;
          peakHour = hist.indexOf(Math.max(...hist));
          nightShare = (hist[23] + hist[0] + hist[1] + hist[2] + hist[3] + hist[4]) / total;
        }
      }
      // 一阶：结构分（频次/犯戒/新近/时段），二阶：乘上「此刻」的时段风险
      const base = 0.45 * v + 0.25 * t + 0.15 * recency + 0.15 * timeSens;
      const threat = clamp01(base * (0.85 + 0.30 * currentRisk));
      return {
        host: h, visits: visits[h],
        temptations: Math.round((tempt[h] || 0) * 10) / 10,
        timeSens: Math.round(timeSens * 100) / 100,
        peakHour, nightShare: Math.round(nightShare * 100) / 100,
        threat: Math.round(threat * 100) / 100,
      };
    })
    .filter((x) => x.threat >= 0.35)
    .sort((a, b) => b.threat - a.threat)
    .slice(0, 12)
    .map((x) => ({ ...x, inList: list.includes(x.host) }));
  reply(true, { threats, inFocus: !!focus, currentRisk, nowHour });
}

/* ---------- 标签检查：状态机 + 自适应提醒 ---------- */
async function focusCheckTab(tab) {
  if (!tab || !tab.active || !tab.url || !tab.url.startsWith('http')) return;
  const { focus } = await focusGet({ focus: null });
  if (!focus || focus.until <= Date.now()) return;
  const host = focusHostOf(tab.url);
  if (!host) return;
  // Day3：黑名单模式命中即分心；白名单模式「不在列表内」即分心
  if (!isDistracting(host, focus)) { clearPending(tab.id); return; }

  const now = Date.now();
  // 状态机：标记「评估中」的访问
  if (!focusRt.dwell[tab.id] || focusRt.dwell[tab.id].host !== host) {
    focusRt.dwell[tab.id] = { host, since: now };
    focusRtSave();
  }

  // 该标签页已排程提醒（含 RL 延迟等待中）→ 不再重复排
  if (focusRt.pending[tab.id] && focusRt.pending[tab.id].host === host) return;

  // 自适应提醒间隔：90s × 1.35^n，封顶 5 分钟
  const n = focusRt.nudgeN[host] || 0;
  const interval = Math.min(90000 * Math.pow(1.35, n), 300000);
  if (focusRt.nudgeAt[host] && now - focusRt.nudgeAt[host] < interval) return;

  // Backlog：RL 延迟 —— 先等 delay 毫秒，若用户自己离开则不必打扰
  const delay = focusNudgeDelay[host] || 0;
  clearPending(tab.id);
  const rec = { host, since: now, fireAt: now + delay, fired: false };
  focusRt.pending[tab.id] = rec;
  armNudgeTimer(tab.id, rec, delay);
  focusRtSave();
}

/* 实际发出提醒（RL 延迟结束后调用） */
async function fireNudge(host) {
  const { focus } = await focusGet({ focus: null });
  if (!focus || focus.until <= Date.now()) return;
  const now = Date.now();
  const n = focusRt.nudgeN[host] || 0;
  focusRt.nudgeAt[host] = now;
  focusRt.nudgeN[host] = n + 1;
  focusRtSave();
  const mins = Math.max(1, Math.round((focus.until - now) / 60000));
  const pool = focus.mode === 'white' ? FOCUS_NUDGE_MSGS_WHITE : FOCUS_NUDGE_MSGS;
  const msg = pool[n % pool.length].replace('{host}', host).replace('{min}', String(mins));
  focusNotify(focus.mode === 'white' ? '🎯 白名单专注' : '🎯 专注模式', msg);
  await pushFocusEvent({ t: now, host, kind: 'nudge' });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' || info.url) focusCheckTab(tab);
});
chrome.tabs.onActivated.addListener((ai) => {
  getTabSafe(ai.tabId).then(focusCheckTab);
});

/* 离开分心站点时评估 dwell：忍住 or 破戒（黑名单/白名单两种模式共用）。
 * 标签页被直接关闭也算「离开」（旧版只监听导航，关 Tab 时分心永不结算）。 */
function settleDwell(tabId) {
  const d = focusRt.dwell[tabId];
  if (!d) return;
  delete focusRt.dwell[tabId];
  focusRtSave();
  const dwellMs = Date.now() - d.since;
  // Backlog：RL 结算 —— 离开瞬间看提醒是否还没触发
  const pend = focusRt.pending[tabId];
  const selfRecovered = !!(pend && !pend.fired); // 没等提醒就自己走了
  const wasNudged = !pend || pend.fired;         // 已经提醒过（或本轮无需提醒）
  clearPending(tabId);
  if (dwellMs < 5000) return; // 误判（瞬时跳转）
  (async () => {
    const { focus } = await focusGet({ focus: null });
    if (!focus || focus.until <= Date.now()) return;
    const kind = dwellMs >= FOCUS_DWELL_MS ? 'broke' : 'resist';
    const t = Date.now();
    const hour = new Date(t).getHours();
    await pushFocusEvent({ t, host: d.host, kind, dwellMs, hour });
    await bumpHostHour(d.host, hour); // Day7：时段直方图
    if (kind === 'resist') {
      focusNotify('💪 干得漂亮', '你离开了「' + d.host + '」，已记入「忍住」。');
      if (selfRecovered) await updateNudgePolicy(d.host, +1); // 自我纠正成功 → 下次更晚提醒
    } else if (wasNudged) {
      await updateNudgePolicy(d.host, -1);                    // 提醒过仍破戒 → 下次更早拦截
    }
  })();
}
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  const d = focusRt.dwell[tabId];
  if (!d) return;
  const host = focusHostOf(tab && tab.url);
  if (host && (host === d.host || host.endsWith('.' + d.host))) return; // 还在该站
  settleDwell(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => settleDwell(tabId));

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

  // Day9：会话回放数据（精简后随报告留存，最多 120 个事件）
  const events = ev.slice(-120).map((e) => ({
    t: e.t, kind: e.kind, host: e.host, dwellMs: e.dwellMs, reason: e.reason || null,
  }));
  const report = {
    start: focus.start, end: now, minutes: focus.minutes,
    nudges, resisted, broken, efficiency, completed, auto: !!auto,
    mode: focus.mode || 'black',   // Day3
    events,                        // Day9
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
  for (const k of Object.keys(focusRt.dwell)) delete focusRt.dwell[k];
  for (const k of Object.keys(focusRt.pending)) clearPending(k);
  focusRtSave();

  // 番茄周期：自然到期才排休息
  if (auto && focus.pomodoro && completed) {
    const cycle = (focusStats.cycle || 0) + 1;
    const breakMin = cycle % 4 === 0 ? 15 : 5;
    try { chrome.alarms.create('hc-focus-break', { when: now + breakMin * 60000 }); } catch (_e) { /* 忽略 */ }
    focusNotify('🍅 番茄完成！', '休息 ' + breakMin + ' 分钟，我会提醒你回来开始下一个番茄。');
  } else if (!completed) {
    focusNotify('专注已结束', '本次提前结束：专注效率 ' + Math.round(efficiency * 100) + '%。');
  }

  // Day1 增量：每日专注目标（默认 60 分钟，只计自然完成的会话）
  const gd = await focusGet({ focusGoalMinutes: 60 });
  const goal = gd.focusGoalMinutes || 60;
  const today = new Date().toDateString();
  const todayMin = reports
    .filter((r) => r.completed && new Date(r.end).toDateString() === today)
    .reduce((a, r) => a + r.minutes, 0);
  const beforeMin = todayMin - (completed ? focus.minutes : 0);
  if (todayMin >= goal && beforeMin < goal) {
    focusNotify('🏆 今日目标达成', '已完成 ' + todayMin + ' / ' + goal + ' 分钟专注，超棒。');
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
