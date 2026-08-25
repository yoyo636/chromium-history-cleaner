# Chromium 历史记录清理插件（Manifest V3）

通用 Chromium 浏览器历史记录管理插件：按时间段 **查询 / 预览 / 搜索 / 安全删除** 浏览器历史，并支持将目标时段记录 **导出为 JSON / CSV 备份**。

> 替代传统的 macOS `bash + sqlite3` 脚本方案——无需关闭浏览器、不依赖 sqlite3、一套代码兼容所有 Chromium 内核浏览器、自带可视化 GUI 与不可逆操作二次确认。

---

## ✨ 功能特性

| 功能 | 说明 |
| --- | --- |
| 📅 日期范围选择 | 起始 / 结束日期（YYYY-MM-DD），并提供「今天 / 最近 7 天 / 最近 30 天 / 自定义」快捷选项 |
| 👀 记录预览 | 删除前先列出该时段历史：访问时间、标题、URL（超长自动截断，悬停显示完整），并显示总数 |
| 🗑️ 删除操作 | 支持「删除选中」（多选复选框）或「删除全部」（整段范围），删除前强制二次确认 |
| 🔍 实时搜索 | 按标题或 URL 关键词在预览列表中即时过滤 |
| 💾 导出备份 | 将当前（过滤后）记录导出为 JSON 或 CSV（带 BOM，Excel 友好） |
| 🛡️ 安全机制 | 明确不可逆警示、二次确认弹窗、删除前可先备份 |
| 🌐 浏览器自适应 | 自动检测浏览器品牌并在 UI 显示（如「Microsoft Edge 历史记录清理」），对非 Chromium 给出友好提示 |
| 🌗 主题自适应 | 跟随系统亮色 / 暗色模式 |

---

## 🧱 技术栈

| 维度 | 选型 |
| --- | --- |
| 扩展规范 | **Manifest V3**（Service Worker 架构，非废弃的 MV2） |
| 前端语言 | 原生 **HTML + CSS + JavaScript**（无框架、无构建步骤、轻量） |
| 样式方案 | 纯 CSS + CSS 变量；`prefers-color-scheme` 实现亮/暗自适应 |
| 后台逻辑 | **Service Worker**（`background.js`）：集中代理历史查询与删除 |
| 历史 API | `chrome.history.search` / `chrome.history.deleteRange` / `chrome.history.deleteUrl` |
| 导出下载 | `chrome.downloads.download`（以 `data:` URL 内联，不落临时文件） |
| 偏好存储 | `chrome.storage.local`（记忆上次使用的日期范围） |
| 权限声明 | `history`（必需）、`storage`（偏好）、`downloads`（导出）— 最小化原则 |
| 资源打包 | 全部本地化，**不引入任何外部 CDN** |
| 图标生成 | 纯标准库 Python（`zlib` / `struct`）脚本 `generate_icons.py`，无需 Pillow |

---

## 🗂️ 目录结构

```
history-cleaner/
├── manifest.json        # MV3 配置：权限、popup、service worker、图标
├── popup.html           # 主界面结构
├── popup.css            # 亮/暗色自适应样式（Chromium 设置页风格）
├── popup.js             # 主逻辑：查询/预览/过滤/删除/导出/品牌检测
├── background.js        # Service Worker：集中代理 history 查询与删除
├── icons/               # 插件图标 16 / 32 / 48 / 128 PNG
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── generate_icons.py    # 纯标准库图标生成脚本（可选，开发用）
└── README.md            # 本文档
```

---

## ⚙️ 核心 API 调用逻辑

```
┌────────────┐   sendMessage    ┌────────────────┐   chrome.history.*   ┌──────────┐
│  popup.js  │ ───────────────► │  background.js  │ ───────────────────► │  History │
│  (UI/交互) │ ◄─────────────── │ (Service Worker)│ ◄─────────────────── │ (DB)     │
└────────────┘   返回结果        └────────────────┘                      └──────────┘
```

- **查询**：`popup.js` → `SEARCH` → `chrome.history.search({ text:'', startTime, endTime, maxResults })`
- **删除选中**：`popup.js` → `DELETE_URL` → `chrome.history.deleteUrl({ url })`
- **删除全部**：`popup.js` → `DELETE_RANGE` → `chrome.history.deleteRange({ startTime, endTime })`
- **导出**：`popup.js` 直接调用 `chrome.downloads.download`（需用户手势，故在 popup 内完成）

> ⚠️ **预览上限说明**：`chrome.history.search` 单次会议返回上限约 **100 条**，因此预览列表最多展示 100 条（已注明）。而「删除全部」走 `deleteRange`，直接覆盖整个时间范围，**不受预览上限影响**，可确保整段历史被清除。

---

## 🚀 各浏览器本地加载测试

通用步骤：打开扩展管理页 → 开启「**开发者模式**」→ 点击「**加载已解压的扩展程序**」→ 选择本插件目录 → 点击工具栏图标打开 popup。

| 浏览器 | 扩展管理地址 |
| --- | --- |
| Google Chrome | `chrome://extensions` |
| Microsoft Edge | `edge://extensions` |
| Brave | `brave://extensions` |
| Opera | `opera://extensions` |
| Arc | `chrome://extensions`（Arc 兼容 Chrome 扩展体系） |
| 360 极速浏览器 | `chrome://extensions` |
| Cent Browser | `chrome://extensions` |

> 部分国产浏览器需先在「扩展管理」开启「开发者模式」才能加载本地解压扩展。

**验证清单**：
1. 顶部品牌胶囊正确显示当前浏览器名称；
2. 点击「最近 7 天」能列出该时段历史并计数；
3. 搜索框输入关键词可实时过滤；
4. 勾选若干条后「删除选中」弹出二次确认，确认后列表刷新；
5. 「删除全部」清空整段范围历史；
6. 「导出 JSON / CSV」生成带时间戳的备份文件；
7. 切换系统亮/暗色，界面随之切换。

---

## 🔁 与原 bash + sqlite3 方案的核心差异

| 维度 | bash + sqlite3 方案 | 本插件（Manifest V3） |
| --- | --- | --- |
| 是否需要关闭浏览器 | 是（否则数据库被锁定，写入失败） | 否（标准 API 操作，浏览器可正常运行） |
| 依赖 | 需安装 `sqlite3`、依赖系统路径 | 零外部依赖，全部打包在插件内 |
| 多浏览器适配 | 每款浏览器 `History` 路径不同，需分别维护 | 一套代码兼容所有 Chromium 内核 |
| 交互方式 | 命令行、无 GUI | 可视化弹窗，所见即所得 |
| 安全性 | 易误删、无确认、无备份 | 二次确认 + 导出备份 + 明确警示 |
| 权限边界 | 直接读写用户文件系统数据库 | 仅申请 `history/storage/downloads` 最小权限 |

---

## 📦 构建图标（可选）

如需重新生成图标（无需 Pillow）：

```bash
python3 generate_icons.py
```

---

## 📄 许可证

MIT —— 可自由用于学习与二次开发。
