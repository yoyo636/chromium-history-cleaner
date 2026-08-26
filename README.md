# 浏览器搭子 · 历史与标签页管家（Manifest V3）

一款实用的 Chromium 浏览器「搭子」：把历史清理、标签管理、书签去重、下载管理、浏览数据清理、会话存档、数据统计、**视觉疲劳自适应护眼**、偏好设置等能力收进一个弹窗，**一套代码兼容所有 Chromium 内核浏览器**，液态玻璃界面、亮/暗色自适应（可手动强制）。

> 替代传统的 `bash + sqlite3` 方案——无需关闭浏览器、不依赖 sqlite3、不关心各浏览器 `History` 文件路径，可视化操作、可逆备份、二次确认。

---

## ✨ 功能特性（实材实料）

| 模块 | 能力 |
| --- | --- |
| 🏠 概览 | 实时统计：打开标签数、书签总数、近 30 天下载、近 7 天历史（精确计数）；一键进入各模块 |
| 📜 历史 | 时间范围（今天 / 7 天 / 30 天 / **全部时间** / 自定义）查询预览；**全量获取**（时间窗二分突破 100 条上限）；实时过滤；分页加载；多选 / 全选 / 单条删除；按范围删除；导出 JSON / CSV |
| 🗂️ 标签 | 列出全部窗口的标签；过滤；关闭选中 / 关闭重复 / 按域名关闭 / 复制网址 / **存档会话** |
| 🔖 书签 | 去重（按网址）；**死链检测**（探测失效书签）；导出 JSON / HTML（Netscape 格式）；删除选中 |
| ⬇️ 下载 | 下载记录；打开文件 / 打开文件夹 / 复制来源 / 从记录中移除 |
| 🧹 清理 | 按时间范围（1 小时 / 24 小时 / 7 天 / 全部）清理；**清理前扫描**：真实展示每项数量与占用（下载记录为真实文件大小 GB，并列出最大文件；历史展示条数 / 跨度 / 域名数）；清理后自动复扫验证 |
| 💾 会话 | 恢复「最近关闭」的标签与窗口；查看 / 恢复 / 删除自己存档的会话 |
| 📊 统计 | 历史访问分析：总记录数 / 总访问次数 / 时间跨度 / 活跃域名数；**Top 10 域名与页面条形图**（支持 7 / 30 / 90 天与全部时间） |
| 👁️ 护眼 | **视觉疲劳自适应**：鼠标 / 滚动 / 键盘 / 连续时长四维信号实时评估疲劳等级 1-5；**30 秒渐进**调整行高、字距、字重、对比度（提升非降低）；**区域级**调整（仅主阅读区，导航/侧边栏不动）；**内容类型感知**（代码 / 长文章 / 表格不同策略）；等级 4+ 开启**聚焦阅读**（高亮当前段落，其余淡化）；等级 5 正文**暖色微调**（图片视频保持原色）；图标角标实时显示等级，弹窗内提供**当日疲劳曲线与休息建议** |
| ⚡ 性能 | **标签页性能透视**：基于 longtask / performance.memory / 帧率实时评估每个标签的 CPU 繁忙度、内存与渲染压力，绿/黄/红指示灯；按消耗排序；**一键冻结**（`tabs.discard` 释放内存）或关闭；**归因分析**（定位高频执行脚本）；持续高负载自动**预警通知** |
| 🔊 音频 | **音频内容识别与静音**：列出全部发声标签，一键静音/恢复/全部静音；**规则判定**（自动播放元素 + 广告容器）；**频谱分类**（Web Audio 分析人声 / 背景音乐 / 高频广告噪声，保留人声）；**跨站学习**（你静音过的域名自动静音记忆） |
| 🛡️ 隐私 | **无痕追踪防护**：MAIN 世界 hook canvas / WebGL 指纹调用，如实报告「哪个站点、哪个指纹 API、是否无痕、调用次数」；**一键加固**（随机化 canvas/WebGL 指纹）；**跨站追踪图谱**（同一域名被多次读取指纹 → 追踪网络候选）；风险分级清单 |
| ⚙️ 设置 | 主题（跟随系统 / 亮 / 暗）、历史默认范围（今天 / 7 天 / 30 天 / 全部时间）、清理二次确认开关（持久化） |

**安全机制**：删除类操作均二次确认 + 不可恢复警示；清理前可先导出备份；所有写操作的权限最小化。

---

## 🧱 技术栈

| 维度 | 选型 |
| --- | --- |
| 扩展规范 | **Manifest V3**（Service Worker，非废弃的 MV2） |
| 前端语言 | 原生 **HTML + CSS + JavaScript**（无框架、无构建步骤、轻量） |
| 样式方案 | 纯 CSS + CSS 变量；`backdrop-filter` 液态玻璃；`prefers-color-scheme` 自适应 + 手动主题覆盖 |
| 弹窗尺寸 | 640px 宽，单行不换行（nowrap + 省略号），导航横向滚动 |
| 后台逻辑 | **Service Worker**（`background.js`）：集中代理历史查询 / **全量查询** / 统计 / 删除、书签死链探测、**疲劳上报汇总与角标** |
| 内容脚本 | **`content.js`**：护眼信号采集与排版调整；**`content_perf.js`**：性能指标（longtask/内存/帧率）与音频频谱分析；**`content_privacy.js`**（MAIN 世界）：canvas/WebGL 指纹监控与随机化 |
| 性能 API | `PerformanceObserver(longtask)` + `performance.memory` + 帧率；`chrome.tabs.discard`（冻结）/ `remove` / `muted` |
| 音频 API | `chrome.tabs.query({audible})` / `update({muted})`；`chrome.tabCapture.getMediaStreamId` + Web Audio `AnalyserNode` 频谱分类 |
| 隐私 API | `world: "MAIN"` 内容脚本 hook `canvas` / `webgl`；`chrome.scripting` / `storage` |
| 历史 API | `chrome.history.search`（时间窗二分取全量）/ `deleteRange` / `deleteUrl` |
| 标签 API | `chrome.tabs.query` / `remove` / `reload` / `create` |
| 书签 API | `chrome.bookmarks.getTree` / `remove` |
| 下载 API | `chrome.downloads.search` / `open` / `show` / `erase` / `download` |
| 清理 API | `chrome.browsingData.remove`（清理前用 `downloads.fileSize` 等真实统计） |
| 会话 API | `chrome.sessions.getRecentlyClosed` / `restore`；自定义会话存于 `chrome.storage.local` |
| 偏好存储 | `chrome.storage.local`（`hcPrefs`） |
| 导出下载 | `chrome.downloads.download`（以 `data:` URL 内联，不落临时文件） |
| 权限声明 | `history` `storage` `downloads` `tabs` `bookmarks` `browsingData` `sessions` `tabCapture` `scripting` `notifications` + `host_permissions`（`http/https`）— 最小化原则 |
| 资源打包 | 全部本地化，**不引入任何外部 CDN** |
| 图标生成 | 纯标准库 Python（`zlib` / `struct`）脚本 `generate_icons.py`，无需 Pillow |

---

## 🗂️ 目录结构

```
history-cleaner/
├── manifest.json          # MV3 配置：权限、popup、service worker、content scripts、图标
├── popup.html             # 主界面（顶部导航栏 + 内容区）
├── popup.css              # 液态玻璃样式（640px 宽、亮/暗自适应、统计/清理明细组件）
├── popup.js               # 核心：命名空间、工具、导航、概览、偏好与主题
├── background.js          # Service Worker：历史代理（含全量查询/统计）+ 死链探测 + 疲劳汇总/角标 + 性能/音频/隐私处理
├── content.js             # 护眼内容脚本：信号采集、疲劳评分、渐进排版调整、上报
├── content.css            # 护眼调整规则（等级 1-5 / 主阅读区 / 内容类型 / 聚焦 / 暖色）
├── content_perf.js        # 性能透视：longtask/内存/帧率上报 + 音频频谱分类分析
├── content_privacy.js     # 隐私防护（MAIN 世界）：canvas/WebGL 指纹监控与随机化加固
├── modules/
│   ├── history.js         # 历史查询（全量）/ 预览 / 过滤 / 删除 / 导出
│   ├── tabs.js            # 标签管理
│   ├── bookmarks.js       # 书签去重 / 死链 / 导出
│   ├── downloads.js       # 下载管理
│   ├── cleanup.js         # 浏览数据清理（扫描明细 + 真实占用 + 复扫验证）
│   ├── sessions.js        # 会话存档
│   ├── stats.js           # 数据统计（Top 域名 / 页面）
│   ├── fatigue.js         # 护眼仪表盘（疲劳曲线 / 等级 / 休息建议 / 开关）
│   ├── perf.js            # 标签页性能透视（指示灯 / 冻结 / 关闭 / 归因）
│   ├── audio.js           # 音频管理（发声标签 / 频谱分类 / 域名学习静音）
│   ├── privacy.js         # 隐私报告（指纹事件 / 一键加固 / 追踪图谱）
│   └── settings.js        # 偏好设置（主题 / 默认范围 / 清理确认）
├── icons/                 # 16 / 32 / 48 / 128 PNG
├── generate_icons.py      # 纯标准库图标生成脚本（开发用，可选）
└── README.md
```

---

## ⚙️ 核心 API 调用架构

```
┌─────────┐  sendMessage   ┌──────────────┐  chrome.history.*  ┌────────┐
│ popup / │ ─────────────► │ background.js │ ─────────────────► │ History│
│ modules │ ◄───────────── │ (SW)          │ ◄───────────────── │        │
└─────────┘   返回结果      └──────────────┘                    └────────┘
   多数模块直接调用 chrome.* API（popup 已声明相应权限）；
   危险/耗时操作（历史删除、全量查询、统计、死链探测）统一收口在 background.js。
```

> ✅ **全量展示**：`chrome.history.search` 单次最多返回约 100 条，本插件在后台采用「时间窗二分 + 去重」策略，可获取任意时间跨度（含从最早到现在）的**全部**历史；「全部时间」即无限期展示全部数据。「删除全部」走 `deleteRange`，直接覆盖整段范围。

> ⚠️ **清理大小的诚实说明**：浏览器未开放「缓存 / Cookie / 本地存储」等项的精确占用查询接口，界面如实显示「—」；仅「下载记录」可读取真实文件大小（GB）。历史 / 下载在清理后可复扫验证已归零。

---

## 🚀 各浏览器本地加载测试

通用步骤：扩展管理页 → 开启「**开发者模式**」→「**加载已解压的扩展程序**」→ 选择 `history-cleaner` 目录 → 点击工具栏图标打开弹窗。

| 浏览器 | 扩展管理地址 |
| --- | --- |
| Google Chrome | `chrome://extensions` |
| Microsoft Edge | `edge://extensions` |
| Brave | `brave://extensions` |
| Opera | `opera://extensions` |
| Arc | `chrome://extensions` |
| 360 极速浏览器 / Cent Browser | `chrome://extensions`（需先开开发者模式） |

**验证清单**：
1. 顶部品牌胶囊显示当前浏览器名称；
2. 导航单行显示 7 项（概览/历史/标签/书签/下载/清理/更多），「更多」面板一屏展开全部次要功能，无需滚动；
3. 概览统计可正常加载；
4. 历史选「全部时间」可查询全部记录、计数正确、过滤、删除、导出；
5. 历史列表超 500 条时出现「加载更多」，滚动浏览不卡顿；
6. 标签可批量关闭重复 / 按域名关闭（自定义输入弹窗）/ 存档会话；
7. 书签「仅重复」可列出重复项，「检测死链」标出失效书签；
8. 下载可打开 / 打开文件夹 / 移除记录；
9. 清理页自动扫描：历史显示条数/跨度/域名，下载显示真实 GB 与最大文件；执行后复扫验证归零；
10. 统计 / 护眼 / 性能 / 音频 / 隐私页功能正常（均从「更多」进入）；
11. 设置页切换主题即时生效，历史默认范围下次打开生效；
12. 切换系统亮/暗色，界面随之切换。

---

## 🔁 与原 bash + sqlite3 方案的核心差异

| 维度 | bash + sqlite3 | 本插件（MV3） |
| --- | --- | --- |
| 是否需关闭浏览器 | 是（否则数据库锁定） | 否 |
| 依赖 | 需 `sqlite3`、依赖系统路径 | 零外部依赖 |
| 多浏览器适配 | 各浏览器路径不同，需分别维护 | 一套代码兼容所有 Chromium 内核 |
| 交互 | 命令行、无 GUI | 可视化弹窗（640px 大界面） |
| 数据范围 | 需手写 SQL 时间条件 | 全部时间 / 任意范围全量获取 |
| 清理透明度 | 不可见清了什么 | 扫描明细 + 真实占用 + 复扫验证 |
| 安全性 | 易误删、无确认、无备份 | 二次确认 + 导出备份 + 明确警示 |
| 权限边界 | 直接读写用户文件系统数据库 | 仅申请必要权限，走标准 API |

---

## 📦 重新生成图标（可选）

```bash
python3 generate_icons.py
```

## 📄 许可证

MIT —— 可自由用于学习与二次开发。
