/* -------------------------------------------------------------------------
 * background.js — Manifest V3 Service Worker
 * 集中代理危险的 history 操作（查询 / 按范围删除 / 按 URL 删除），
 * 由 popup 通过 chrome.runtime.sendMessage 调用，便于统一错误处理与扩展。
 * ------------------------------------------------------------------------- */

'use strict';

/**
 * 处理来自 popup 的消息。
 * 返回 true 表示将异步调用 sendResponse（Promise 形式）。
 * @param {object} msg 消息体，含 type 字段
 * @param {object} _sender 发送者信息（此处未使用）
 * @param {function} sendResponse 回调
 * @returns {boolean} 是否保持消息通道开放
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'SEARCH':
      return handleSearch(msg, sendResponse);
    case 'DELETE_RANGE':
      return handleDeleteRange(msg, sendResponse);
    case 'DELETE_URL':
      return handleDeleteUrl(msg, sendResponse);
    default:
      sendResponse({ ok: false, error: '未知的消息类型: ' + msg.type });
      return false;
  }
});

/**
 * 按时间范围查询历史记录。
 * chrome.history.search 通过 startTime / endTime 过滤访问时间，
 * text 传空串表示匹配全部；maxResults 上限受浏览器限制（通常 ≤ 100）。
 */
function handleSearch(msg, sendResponse) {
  chrome.history
    .search({
      text: msg.text || '',
      startTime: msg.startTime,
      endTime: msg.endTime,
      maxResults: msg.maxResults || 100,
    })
    .then((items) => sendResponse({ ok: true, items: items || [] }))
    .catch((err) => sendResponse({ ok: false, error: errMessage(err) }));
  return true;
}

/**
 * 删除指定时间范围内的【全部】历史记录。
 * deleteRange 不依赖预览完整性，可覆盖整个时间段内的所有访问。
 */
function handleDeleteRange(msg, sendResponse) {
  chrome.history
    .deleteRange({ startTime: msg.startTime, endTime: msg.endTime })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: errMessage(err) }));
  return true;
}

/**
 * 删除指定 URL 的全部历史访问记录。
 */
function handleDeleteUrl(msg, sendResponse) {
  chrome.history
    .deleteUrl({ url: msg.url })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: errMessage(err) }));
  return true;
}

/**
 * 统一提取错误信息文本。
 * @param {*} err
 * @returns {string}
 */
function errMessage(err) {
  if (!err) return '未知错误';
  return err.message || String(err);
}
