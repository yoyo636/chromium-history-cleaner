/* -------------------------------------------------------------------------
 * popup.js — 主界面逻辑
 * 职责：浏览器品牌检测、日期范围/快捷选项、历史查询与预览、实时过滤、
 *       多选/全选删除、按范围删除、JSON/CSV 导出备份、二次确认与提示。
 * 所有 history 危险操作通过 chrome.runtime.sendMessage 委托 background.js 执行。
 * ------------------------------------------------------------------------- */

'use strict';

/* ============================ 全局状态 ============================ */
const state = {
  items: [], // 当前时间段查询到的全部记录
  filtered: [], // 经关键词过滤后的记录
  selected: new Set(), // 已勾选的 URL 集合
  range: { start: null, end: null }, // 当前查询的时间戳范围（ms）
};

/* ============================ DOM 引用 ============================ */
const els = {
  incompatible: document.getElementById('incompatible'),
  main: document.getElementById('main'),
  brandPill: document.getElementById('brand-pill'),
  presetGroup: document.getElementById('preset-group'),
  startDate: document.getElementById('start-date'),
  endDate: document.getElementById('end-date'),
  searchBtn: document.getElementById('search-btn'),
  filterInput: document.getElementById('filter-input'),
  selectAll: document.getElementById('select-all'),
  countLabel: document.getElementById('count-label'),
  exportJson: document.getElementById('export-json'),
  exportCsv: document.getElementById('export-csv'),
  loading: document.getElementById('loading'),
  list: document.getElementById('list'),
  deleteSelected: document.getElementById('delete-selected'),
  deleteAll: document.getElementById('delete-all'),
  overlay: document.getElementById('overlay'),
  confirmText: document.getElementById('confirm-text'),
  confirmCancel: document.getElementById('confirm-cancel'),
  confirmOk: document.getElementById('confirm-ok'),
  toast: document.getElementById('toast'),
};

/* ============================ 浏览器检测 ============================ */
/**
 * 通过 User-Agent 推断浏览器品牌（best-effort，仅用于 UI 展示）。
 * @returns {string}
 */
function detectBrowser() {
  const ua = navigator.userAgent;
  if (ua.includes('Brave')) return 'Brave';
  if (ua.includes('Edg/')) return 'Microsoft Edge';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera';
  if (ua.includes('Arc/')) return 'Arc';
  if (ua.includes('CentBrowser')) return 'Cent Browser';
  if (ua.includes('Qihoo') || ua.includes('360')) return '360 极速浏览器';
  if (ua.includes('Tabbit')) return 'Tabbit';
  if (ua.includes('Chrome')) return 'Google Chrome';
  if (ua.includes('Chromium')) return 'Chromium';
  return '未知 Chromium 浏览器';
}

/* ============================ 工具函数 ============================ */
const pad = (n) => String(n).padStart(2, '0');

/** 时间戳格式化为 YYYY-MM-DD HH:mm:ss */
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 日期格式化为 YYYY-MM-DD（本地时区） */
function toYMD(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 解析 YYYY-MM-DD 为本地 Date；非法返回 null */
function parseYMD(val) {
  if (!val) return null;
  const [y, m, d] = val.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** URL 截断显示 */
function truncateUrl(url, max = 64) {
  return url.length > max ? url.slice(0, max) + '…' : url;
}

/** 轻量提示 */
let toastTimer = null;
function toast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2600);
}

/* ============================ 日期范围 ============================ */
/** 读取输入框的日期范围，写入 state 并持久化 */
function readRange() {
  const s = parseYMD(els.startDate.value);
  const e = parseYMD(els.endDate.value);
  if (!s || !e) {
    state.range = { start: null, end: null };
    return;
  }
  // 结束日期包含当日 23:59:59.999
  const end = new Date(e.getFullYear(), e.getMonth(), e.getDate(), 23, 59, 59, 999);
  state.range = { start: s.getTime(), end: end.getTime() };
  chrome.storage.local.set({
    range: { start: els.startDate.value, end: els.endDate.value },
  });
}

/** 应用快捷选项 */
function applyPreset(name) {
  const now = new Date();
  if (name === 'custom') {
    setActivePreset('custom');
    els.startDate.focus();
    return;
  }
  let start;
  if (name === 'today') start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (name === '7d') start = new Date(now.getTime() - 6 * 86400000);
  else if (name === '30d') start = new Date(now.getTime() - 29 * 86400000);

  els.startDate.value = toYMD(start);
  els.endDate.value = toYMD(now);
  setActivePreset(name);
  readRange();
  doSearch();
}

function setActivePreset(name) {
  els.presetGroup.querySelectorAll('.preset-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.preset === name);
  });
}

/* ============================ 查询与预览 ============================ */
/** 调用 background 查询历史 */
async function doSearch() {
  const { start, end } = state.range;
  if (start == null || end == null) {
    toast('请先选择日期范围');
    return;
  }
  showLoading(true);
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'SEARCH',
      text: '',
      startTime: start,
      endTime: end,
      maxResults: 100,
    });
    if (!resp.ok) throw new Error(resp.error);
    state.items = resp.items || [];
    state.selected.clear();
    applyFilter();
    toast(`查询完成，共 ${state.items.length} 条`);
  } catch (err) {
    toast('查询失败：' + err.message, true);
  } finally {
    showLoading(false);
  }
}

function showLoading(on) {
  els.loading.classList.toggle('hidden', !on);
}

/* ============================ 过滤 ============================ */
/** 按关键词实时过滤当前列表 */
function applyFilter() {
  const kw = (els.filterInput.value || '').trim().toLowerCase();
  state.filtered = kw
    ? state.items.filter(
        (it) =>
          (it.title || '').toLowerCase().includes(kw) ||
          (it.url || '').toLowerCase().includes(kw)
      )
    : state.items.slice();
  renderList();
  updateSelectionUI();
}

/* ============================ 渲染列表 ============================ */
function renderList() {
  const list = els.list;
  list.innerHTML = '';

  if (!state.filtered.length) {
    const tip = document.createElement('div');
    tip.className = 'empty-tip';
    tip.textContent = state.items.length
      ? '没有匹配过滤条件的记录'
      : '该时间段内没有历史记录';
    list.appendChild(tip);
    return;
  }

  for (const it of state.filtered) {
    const item = document.createElement('div');
    item.className = 'list-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(it.url);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(it.url);
      else state.selected.delete(it.url);
      updateSelectionUI();
    });

    const body = document.createElement('div');
    body.className = 'item-body';

    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = it.title || '(无标题)';

    const url = document.createElement('span');
    url.className = 'item-url';
    url.textContent = truncateUrl(it.url || '');
    url.title = it.url || '';

    body.append(title, url);

    const time = document.createElement('div');
    time.className = 'item-time';
    time.textContent = fmtTime(it.lastVisitTime);

    item.append(cb, body, time);
    list.appendChild(item);
  }
}

/* ============================ 选择状态 ============================ */
/** 更新全选框、删除选中按钮、计数文本 */
function updateSelectionUI() {
  const total = state.filtered.length;
  const selectedInView = state.filtered.filter((it) =>
    state.selected.has(it.url)
  ).length;

  els.selectAll.checked = total > 0 && selectedInView === total;
  els.selectAll.indeterminate = selectedInView > 0 && selectedInView < total;

  els.countLabel.textContent = `共 ${state.items.length} 条${
    state.selected.size ? `（已选 ${state.selected.size}）` : ''
  }`;

  els.deleteSelected.disabled = state.selected.size === 0;
  els.deleteSelected.textContent =
    state.selected.size > 0 ? `删除选中 (${state.selected.size})` : '删除选中';
}

/** 全选 / 取消全选当前过滤结果 */
function toggleSelectAll() {
  const on = els.selectAll.checked;
  for (const it of state.filtered) {
    if (on) state.selected.add(it.url);
    else state.selected.delete(it.url);
  }
  renderList();
  updateSelectionUI();
}

/* ============================ 导出备份 ============================ */
/** 将当前（过滤后）记录导出为 JSON 或 CSV，并触发下载 */
function exportBackup(format) {
  const data = state.filtered.length ? state.filtered : state.items;
  if (!data.length) {
    toast('没有可导出的记录');
    return;
  }
  let content;
  let mime;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  if (format === 'csv') {
    const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const header = ['访问时间', '标题', 'URL', '访问次数'];
    const rows = data.map((it) =>
      [fmtTime(it.lastVisitTime), it.title || '', it.url || '', it.visitCount || 0]
        .map(esc)
        .join(',')
    );
    // 前置 BOM，保证 Excel 正确识别 UTF-8
    content = '﻿' + [header.join(','), ...rows].join('\r\n');
    mime = 'text/csv;charset=utf-8';
  } else {
    content = JSON.stringify(
      data.map((it) => ({
        time: fmtTime(it.lastVisitTime),
        title: it.title || '',
        url: it.url || '',
        visitCount: it.visitCount || 0,
      })),
      null,
      2
    );
    mime = 'application/json;charset=utf-8';
  }

  const filename = `history_backup_${stamp}.${format}`;
  const dataUrl = 'data:' + mime + ',' + encodeURIComponent(content);
  chrome.downloads
    .download({ url: dataUrl, filename, saveAs: true })
    .catch((err) => toast('导出失败：' + err.message, true));
}

/* ============================ 删除 ============================ */
/** 删除选中（逐条 deleteUrl） */
async function deleteSelected() {
  const urls = [...state.selected];
  if (!urls.length) {
    toast('请先勾选要删除的记录');
    return;
  }
  const ok = await confirmDialog(
    `确定要删除选中的 ${urls.length} 条历史记录吗？\n此操作不可逆！`
  );
  if (!ok) return;

  let failed = 0;
  for (const url of urls) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'DELETE_URL', url });
      if (!resp.ok) failed++;
    } catch (e) {
      failed++;
    }
  }
  toast(
    failed
      ? `删除完成：${urls.length - failed} 条成功，${failed} 条失败`
      : `已删除 ${urls.length} 条记录`
  );
  await doSearch();
}

/** 删除全部（按范围 deleteRange，覆盖整段，不受预览上限影响） */
async function deleteAll() {
  const { start, end } = state.range;
  if (start == null || end == null) {
    toast('请先选择日期范围');
    return;
  }
  const ok = await confirmDialog(
    `确定要删除该时间段内的【全部】历史记录吗？\n此操作不可逆！`
  );
  if (!ok) return;

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'DELETE_RANGE',
      startTime: start,
      endTime: end,
    });
    if (!resp.ok) throw new Error(resp.error);
    toast('已删除该时间段内的全部历史记录');
    await doSearch();
  } catch (err) {
    toast('删除失败：' + err.message, true);
  }
}

/* ============================ 确认弹窗 ============================ */
/** 返回一个 Promise<boolean> 的确认对话框 */
function confirmDialog(text) {
  els.confirmText.textContent = text;
  els.overlay.classList.remove('hidden');
  return new Promise((resolve) => {
    const done = (result) => {
      els.overlay.classList.add('hidden');
      els.confirmOk.removeEventListener('click', onOk);
      els.confirmCancel.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    els.confirmOk.addEventListener('click', onOk);
    els.confirmCancel.addEventListener('click', onCancel);
  });
}

/* ============================ 初始化 ============================ */
function bindEvents() {
  els.presetGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset-btn');
    if (btn) applyPreset(btn.dataset.preset);
  });
  els.searchBtn.addEventListener('click', () => {
    setActivePreset('custom');
    readRange();
    doSearch();
  });
  els.startDate.addEventListener('change', () => {
    setActivePreset('custom');
    readRange();
  });
  els.endDate.addEventListener('change', () => {
    setActivePreset('custom');
    readRange();
  });
  els.filterInput.addEventListener('input', applyFilter);
  els.selectAll.addEventListener('change', toggleSelectAll);
  els.exportJson.addEventListener('click', () => exportBackup('json'));
  els.exportCsv.addEventListener('click', () => exportBackup('csv'));
  els.deleteSelected.addEventListener('click', deleteSelected);
  els.deleteAll.addEventListener('click', deleteAll);
}

async function init() {
  // 兼容性检查：非 Chromium 或缺少 history API 时给出友好提示
  if (typeof chrome === 'undefined' || !chrome.history) {
    els.incompatible.classList.remove('hidden');
    return;
  }

  els.main.classList.remove('hidden');
  els.brandPill.textContent = detectBrowser();
  bindEvents();

  // 恢复上次使用的日期范围，默认展示「最近 7 天」
  const saved = await chrome.storage.local.get('range');
  const now = new Date();
  if (saved.range && saved.range.start && saved.range.end) {
    els.startDate.value = saved.range.start;
    els.endDate.value = saved.range.end;
  } else {
    els.startDate.value = toYMD(new Date(now.getTime() - 6 * 86400000));
    els.endDate.value = toYMD(now);
  }
  readRange();
  setActivePreset('7d');
  await doSearch();
}

document.addEventListener('DOMContentLoaded', init);
