# 浏览器搭子 · 历史与标签页管家（Manifest V3）

一款实用的 Chromium 浏览器「搭子」：把历史清理、标签管理、书签去重、下载管理、浏览数据清理、会话存档六大常用能力收进一个弹窗，**一套代码兼容所有 Chromium 内核浏览器**，液态玻璃界面、跟随系统的亮/暗色自适应。

> 替代传统的 `bash + sqlite3` 方案——无需关闭浏览器、不依赖 sqlite3、不关心各浏览器 `History` 文件路径，可视化操作、可逆备份、二次确认。

---

## ✨ 功能特性（实材实料）

| 模块 | 能力 |
| --- | --- |
| 🏠 概览 | 实时统计：打开标签数、书签总数、近 30 天下载、近 7 天历史；一键进入各模块 |
| 📜 历史 | 按时间段（今天 / 7 天 / 30 天 / 自定义）查询预览；实时过滤；多选 / 全选删除；按范围删除；导出 JSON / CSV |
| 🗂️ 标签 | 列出全部窗口的标签；过滤；关闭选中 / 关闭重复 / 按域名关闭 / 复制网址 / **存档会话** |
| 🔖 书签 | 去重（按网址）；**死链检测**（探测失效书签）；导出 JSON / HTML（Netscape 格式）；删除选中 |
| ⬇️ 下载 | 近期下载记录；打开文件 / 打开文件夹 / 复制来源 / 从记录中移除 |
| 🧹 清理 | 按时间范围（1 小时 / 24 小时 / 7 天 / 全部）清理缓存、Cookie、历史、表单、密码等 |
| 💾 会话 | 恢复「最近关闭」的标签与窗口；查看 / 恢复 / 删除自己存档的会话 |

**安全机制**：删除类操作均二次确认 + 不可恢复警示；清理前可先导出备份；所有写操作的权限最小化。

---

## 🧱 技术栈

| 维度 | 选型 |
| --- | --- |
| 扩展规范 | **Manifest V3**（Service Worker，非废弃的 MV2） |
| 前端语言 | 原生 **HTML + CSS + JavaScript**（无框架、无构建步骤、轻量） |
| 样式方案 | 纯 CSS + CSS 变量；`backdrop-filter` 实现液态玻璃；`prefers-color-scheme` 亮/暗自适应 |
| 后台逻辑 | **Service Worker**（`background.js`）：集中代理历史查询/删除、书签死链探测 |
| 历史 API | `chrome.history.search` / `deleteRange` / `deleteUrl` |
| 标签 API | `chrome.tabs.query` / `remove` / `reload` / `create` |
| 书签 API | `chrome.bookmarks.getTree` / `remove` |
| 下载 API | `chrome.downloads.search` / `open` / `show` / `erase` / `download` |
| 清理 API | `chrome.browsingData.remove` |
| 会话 API | `chrome.sessions.getRecentlyClosed` / `restore`；自定义会话存于 `chrome.storage.local` |
| 导出下载 | `chrome.downloads.download`（以 `data:` URL 内联，不落临时文件） |
| 权限声明 | `history` `storage` `downloads` `tabs` `bookmarks` `browsingData` `sessions` — 最小化原则 |
| 资源打包 | 全部本地化，**不引入任何外部 CDN** |
| 图标生成 | 纯标准库 Python（`zlib` / `struct`）脚本 `generate_icons.py`，无需 Pillow |

---

## 🗂️ 目录结构

```
history-cleaner/
├── manifest.json          # MV3 配置：权限、popup、service worker、图标
├── popup.html             # 主界面（顶部导航栏 + 内容区）
├── popup.css              # 液态玻璃样式（亮/暗自适应）
├── popup.js               # 核心：命名空间、工具、导航、概览仪表盘
├── background.js          # Service Worker：历史代理 + 死链探测
├── modules/
│   ├── history.js         # 历史查询 / 预览 / 过滤 / 删除 / 导出
│   ├── tabs.js            # 标签管理
│   ├── bookmarks.js       # 书签去重 / 死链 / 导出
│   ├── downloads.js       # 下载管理
│   ├── cleanup.js         # 浏览数据清理
│   └── sessions.js        # 会话存档
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
   危险/耗时操作（历史删除、死链探测）统一收口在 background.js。
```

> ⚠️ **预览上限**：`chrome.history.search` 单次返回上限约 **100 条**，预览列表最多展示 100 条（已注明）。但「删除全部」走 `deleteRange`，直接覆盖整段范围，**不受预览上限影响**。

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
2. 概览统计可正常加载；
3. 历史按「最近 7 天」列出并可计数、过滤、删除、导出；
4. 标签可批量关闭重复 / 按域名关闭 / 存档会话；
5. 书签「仅重复」可列出重复项，「检测死链」标出失效书签；
6. 下载可打开 / 打开文件夹 / 移除记录；
7. 清理按范围选择项目并执行（二次确认）；
8. 会话可恢复最近关闭、恢复 / 删除已存档会话；
9. 切换系统亮/暗色，界面随之切换。

---

## 🔁 与原 bash + sqlite3 方案的核心差异

| 维度 | bash + sqlite3 | 本插件（MV3） |
| --- | --- | --- |
| 是否需关闭浏览器 | 是（否则数据库锁定） | 否 |
| 依赖 | 需 `sqlite3`、依赖系统路径 | 零外部依赖 |
| 多浏览器适配 | 各浏览器路径不同，需分别维护 | 一套代码兼容所有 Chromium 内核 |
| 交互 | 命令行、无 GUI | 可视化弹窗 |
| 安全性 | 易误删、无确认、无备份 | 二次确认 + 导出备份 + 明确警示 |
| 权限边界 | 直接读写用户文件系统数据库 | 仅申请必要权限，走标准 API |

---

## 📦 重新生成图标（可选）

```bash
python3 generate_icons.py
```

## 📄 许可证

MIT —— 可自由用于学习与二次开发。
