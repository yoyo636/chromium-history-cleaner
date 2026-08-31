# 商店上架文案与提交指南

> 本文件为「浏览器搭子 · 历史与标签页管家」在各扩展商店上架所需的全套材料：
> 商店描述（中英）、分类、权限理由、隐私政策、提交步骤与素材清单。
> 提交动作需使用**你自己的开发者账号**在对应商店后台完成（涉及注册、协议接受、实名/付费），本文档提供逐步指引。

---

## 0. 提交包（已生成）

| 包 | 适用商店 | 文件 |
| --- | --- | --- |
| Chromium 通用包（v4.10.0） | Chrome Web Store、Microsoft Edge Add-ons、Opera Add-ons、Tabbit、Brave、Arc 等所有 Chromium 内核浏览器 | `dist-packages/browser-companion-chromium.zip` |
| Firefox 包（v4.10.0） | Firefox Add-ons（AMO） | `dist-packages/browser-companion-firefox.zip` |

重新生成：`python3 chromium-history-manager/build_all.py`

---

## 1. 通用商店信息

**扩展名称**
- 中文：浏览器搭子 · 历史与标签页管家
- English：Browser Companion · History & Tab Manager

**图标**：`icons/icon128.png`（128×128）；商店还常要求 16/32/48，已在包内。

**分类建议**：Productivity（效率工具）/ 中文站可选「效率工具」；备选「工具 / Tools」

**语言**：中文（zh-CN）、English（en）——各商店均支持多语言描述，建议同时提交

**隐私政策 URL**（必填，需 https 可访问）：
- 推荐用 GitHub Pages 托管：仓库 Settings → Pages → Deploy from branch `main` → 根目录，发布后访问
  `https://yoyo636.github.io/chromium-history-cleaner/PRIVACY_POLICY_EN.md`（或自建页面）。
- 政策文本已在仓库：`PRIVACY_POLICY.md`（中文）、`PRIVACY_POLICY_EN.md`（英文）。

---

## 2. 商店描述文案

### 2.1 简短描述（Short description，Chrome/Edge 限 132 字符）

**英文（推荐，全球市场）**
> Browser Companion: history cleaner, tab manager, bookmark dedupe, downloads, data cleanup, sessions, stats, eye-care, performance & privacy tools.

**中文**
> 浏览器搭子：历史清理、标签管理、书签去重、下载管理、数据清理、会话存档、统计、护眼、性能与隐私工具。

### 2.2 详细描述（Long description）

**中文版**

浏览器搭子是一款集 12 大实用功能于一体的浏览器伴侣，液态玻璃界面，一套代码兼容 Chrome、Edge、Opera、Tabbit、Firefox 等主流浏览器。

主要功能：
- 📜 历史：按时间（今天/7 天/30 天/全部时间）查询预览，全量获取，实时过滤，多选/单条/按范围删除，导出 JSON/CSV。
- 🗂️ 标签：批量关闭、去重、按域名关闭、复制网址、会话存档。
- 🔖 书签：按网址去重、死链检测、导出 JSON/HTML。
- ⬇️ 下载：查看、打开文件/文件夹、移除记录。
- 🧹 清理：扫描真实占用（下载记录显示真实 GB 与最大文件），一键清理缓存/Cookie/历史等，清理后自动复扫验证。
- 💾 会话：恢复最近关闭的标签/窗口，自定义会话存档。
- 📊 统计：历史访问分析，Top 域名与页面条形图。
- 👁️ 护眼：鼠标/滚动/键盘节奏感知疲劳等级（1-5），30 秒渐进调整阅读排版（行高、对比度、聚焦阅读、暖色微调），当日疲劳曲线与休息提醒。
- ⚡ 性能：标签 CPU 繁忙度/内存/帧率透视，一键冻结或关闭高耗能标签，持续高负载预警。
- 🔊 音频：识别发声标签，频谱分类（人声/音乐/广告），智能静音与域名记忆。
- 🛡️ 隐私：监控 Canvas/WebGL 指纹调用，一键随机化加固，跨站追踪图谱。
- ⚙️ 设置：主题（跟随系统/亮/暗）、默认时间范围、清理确认开关。

隐私与安全：
- 所有数据在本地浏览器内处理，不上传、不共享、不出售。
- 删除类操作均二次确认 + 不可恢复警示。
- 权限最小化，仅申请功能所需的必要权限。
- 隐私政策：见商店页面提供的 URL。

**English version**

Browser Companion bundles 12 practical tools into a single lightweight popup with a liquid-glass UI. One codebase, built on Manifest V3, works across Chrome, Edge, Opera, Tabbit, Firefox and other Chromium-based browsers.

What it does:

- 📜 **History** — Query by time range (Today / 7 / 30 days / All time) with full-data fetching beyond the 100-item API limit, live keyword filtering, single / multi / range delete, and JSON / CSV export.
- 🗂️ **Tabs** — Batch close, dedupe, close by domain, copy URLs, and save sessions.
- 🔖 **Bookmarks** — Dedupe by URL, dead-link detection, export to JSON / HTML.
- ⬇️ **Downloads** — View records, open files / reveal in folder, erase history entries.
- 🧹 **Cleanup** — Scan real disk usage first (real GB for downloads plus the largest files), then one-click clear cache, cookies, history and more — with an automatic re-scan to verify results.
- 💾 **Sessions** — Restore recently closed tabs / windows and manage custom saved sessions.
- 📊 **Stats** — History analytics with Top-domain and Top-page bar charts (7 / 30 / 90 days or all time).
- 👁️ **Eye care** — Continuously gauges a fatigue level (1–5) from your mouse, scrolling and typing rhythm, then smoothly adjusts reading comfort over 30 seconds (line height, contrast, focus mode, warm text tint). Includes a daily fatigue curve and rest reminders.
- ⚡ **Performance** — Per-tab CPU busyness, heap memory and frame-rate at a glance; freeze (discard) or close heavy tabs with one click; alerts when a tab stays under sustained high load.
- 🔊 **Audio** — Lists every audible tab, classifies audio via spectrum analysis (voice / music / ad), and lets you mute selectively with domain-level memory.
- 🛡️ **Privacy** — Monitors Canvas / WebGL fingerprint calls, offers one-click fingerprint randomization, and surfaces a cross-site tracking map.
- ⚙️ **Settings** — Theme (system / light / dark), default history range, and a cleanup-confirmation toggle.

Privacy & security:

- All data stays on your device: nothing is uploaded, shared or sold.
- Destructive actions always require confirmation, with clear unrecoverable warnings.
- Permissions are kept to the strict minimum needed for the listed features.
- Full privacy policy: see the link in the store listing.

---

## 3. 权限理由模板（粘贴到各商店「权限用途」栏）

| 权限 | 用途（一句话） |
| --- | --- |
| history | 历史模块的查询、删除与导出 |
| tabs / sessions | 标签管理与会话存档/恢复 |
| bookmarks | 书签去重、死链检测与导出 |
| downloads | 下载记录管理与文件导出 |
| browsingData | 经确认后清除浏览数据（缓存/Cookie 等） |
| tabCapture | 用户点击「分析」后识别当前标签音频内容 |
| scripting + host_permissions | 隐私指纹监控/加固、护眼/性能内容脚本、AI 操控在指定目标页执行操作 |
| activeTab | AI 操控功能操作您当前交互的标签页时获取临时访问权 |
| cookies | 清理模块统计各站点 Cookie 数量（仅计数，不读取内容） |
| alarms | 定时触发护眼休息提醒与高负载预警 |
| notifications | 高负载与自动静音提醒 |
| storage | 本地保存偏好、会话与统计数据 |

（英文版权限表见 `PRIVACY_POLICY_EN.md` 第六节，可直接引用。）

---

## 4. 各商店提交步骤

### 4.1 Google Chrome Web Store
1. 注册开发者：https://chrome.google.com/webstore/devconsole （Google 账号 + 一次性 $5 注册费 + 开发者协议）。
2. 「New item」→ 上传 `browser-companion-chromium.zip`。
3. 填写：名称、简短/详细描述（见上）、类别（Productivity）、语言（zh-CN + en）、图标（自动从包读取）。
4. 隐私实践：勾选需权限，粘贴「权限理由」；上传隐私政策 URL；填写单用途说明
   （Single purpose：This extension provides browser productivity tools including history management, tab/session management, data cleanup, and optional eye-care/performance/privacy assistance. The Chromium build additionally offers an opt-in "AI control" (BrowserPilot) feature that lets a user-chosen web AI operate the current tab under explicit confirmation. All processing is local.）。
5. 提交审核（通常 1-7 天）。

### 4.2 Microsoft Edge Add-ons
1. 注册 Partner Center：https://partner.microsoft.com/dashboard/microsoftedge （微软账号，免费，个人可用）。
2. 「Create new extension」→ 上传同一 Chromium 包。
3. 填写描述（短/长描述同上）、类别、隐私政策 URL；权限理由同模板。
4. 提交审核（通常 1-5 天）。Edge 接受 Chrome 扩展，无需改动。

### 4.3 Mozilla Firefox Add-ons（AMO）
1. 注册：https://addons.mozilla.org/developers/ （Mozilla 账号，免费）。
2. 提交 `browser-companion-firefox.zip`。
3. 填写名称/描述（同上）、分类；**自动读取 `browser_specific_settings.gecko.id`**。
4. AMO 会自动做源码审查（推荐提供「源码链接」加速审核）：填 https://github.com/yoyo636/chromium-history-cleaner 。
5. 提交审核（建议先自测：`about:debugging#/runtime/this-firefox` 临时加载）。

### 4.4 Opera Add-ons
1. 注册：https://addons.opera.com/developer/ （免费）。
2. 提交 Chromium 包（Opera 与 Chrome 兼容）。
3. 填写描述与截图，提交审核。

### 4.5 Tabbit 及其他 Chromium 浏览器
- Tabbit 基于 Chromium，支持 `chrome://extensions` 开发者模式直接加载 `dist-packages` 解压目录；
- 若 Tabbit 后续提供官方扩展商店，使用同一 Chromium 包按其流程提交即可。
- Brave / Arc / Vivaldi / 360 / Cent 等同理：本地加载或各自商店（多数直接复用 Chrome 包）。

### 4.6 Safari（可选，需 macOS + Xcode）
1. 用 Apple「Safari Web Extension Converter」（Xcode 13+ 自带）把 Chromium 包转换为 Xcode 工程。
2. 签名、在 App Store Connect 提交（需 Apple Developer 账号 $99/年）。
3. 注意：`browsingData` / `tabCapture` 在 Safari 支持较弱，部分功能会受限。

---

## 5. 素材清单（截图建议）

- 概览页（仪表盘）
- 历史页（全部时间列表 + 删除/导出按钮）
- 清理页（扫描详情：历史条数/跨度、下载真实 GB）
- 统计页（Top 域名/页面条形图）
- 护眼页（疲劳曲线 + 休息建议）
- 标签页（批量操作工具栏）
- 建议 1280×800 或 1920×1080，3-6 张，PNG/JPG，各商店尺寸要求略有差异（Chrome 需要 1280×800 或 640×400）。

---

## 6. 提交前自检清单

- [ ] 两个 zip 均已生成且 `testzip()` 无损坏（已在本工程验证）
- [ ] 隐私政策已托管到可访问的 https URL（GitHub Pages）
- [ ] 图标 128×128 就绪（包内已有）
- [ ] 权限理由文案就绪（本文件第三节）
- [ ] 截图 3-6 张
- [ ] Firefox 自测：`about:debugging` 临时加载，确认品牌识别为 Firefox、清理页无 Service Worker 项、性能页无「冻结」按钮、包内无 AI 操控文件
- [ ] Chromium 自测：`chrome://extensions` 加载，核心功能正常；开启 AI 操控后确认敏感操作会弹独立确认窗

---

*版本 v4.10.0 · 2026-08-31*
