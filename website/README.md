# 官网（动态介绍页）

粒子流动效 + 液态玻璃风格的单页介绍站，自带 Python 后端提供版本接口与安装包直链下载。

## 文件

```
website/
├── server.py        # 后端（仅 Python 标准库，无第三方依赖）
└── site/
    ├── index.html   # 介绍页（单文件自包含，无外部 CDN）
    ├── privacy.html # 隐私政策页
    └── icons/       # 扩展图标
```

## API

| 接口 | 说明 |
|------|------|
| `GET /api/version` | 最新版本号 + 两个安装包的体积 / 更新日期 |
| `GET /api/download?target=chromium` | 直链下载 Chromium 版 zip（计入统计） |
| `GET /api/download?target=firefox` | 直链下载 Firefox 版 zip（计入统计） |
| `GET /api/stats` | 下载计数（存 `site/.stats.json`） |

## Render 部署（推荐，免费档即可）

仓库已含 `render.yaml`，在 Render 控制台 **New → Web Service → 连接 GitHub 仓库** 即可自动识别配置。若手动填写，各项如下：

| 表单项 | 填写值 |
|--------|--------|
| Language（运行环境） | **Python 3**（不是 Node.js！后端无任何 npm 依赖） |
| Branch | `main` |
| Root Directory | 留空（构建命令需访问仓库根） |
| Build Command | `python3 build_all.py --web` |
| Start Command | `python3 website/server.py` |
| Health Check Path | `/api/version` |

原理：`--web` 会把两个安装包 zip 生成到 `website/dist-packages/`（Render 构建时创建，运行时读取），`server.py` 自动优先使用该目录。注意 Render 免费档重新部署后 `site/.stats.json` 下载计数会清零（无持久磁盘）；需要保留计数可挂载磁盘并把 `SITE_DIR` 指向它，或升级付费档。

## 其他云平台

任何支持 Python 的平台（Railway / Fly.io / VPS）同理：

```bash
# 构建命令
python3 build_all.py --web
# 启动命令（平台注入 PORT 环境变量则自动跟随）
python3 website/server.py
```

## 本地运行

```bash
# 1. 先生成安装包（产物在仓库同级 ../dist-packages）
python3 build_all.py

# 2. 启动官网
python3 website/server.py
# → http://localhost:8765
```

环境变量：

- `PORT` — 监听端口（默认 8765；Render 等平台会自动注入）
- `DIST_DIR` — 安装包目录（默认自动探测：`website/dist-packages` → `../dist-packages`）

## 自有服务器部署（systemd / Nginx）

上传仓库到服务器后：

```bash
python3 build_all.py --web   # 生成 website/dist-packages/
```

systemd 常驻示例 `/etc/systemd/system/browser-companion-site.service`：

```ini
[Unit]
Description=Browser Companion website
After=network.target

[Service]
WorkingDirectory=/srv/browser-companion
Environment=PORT=8765
ExecStart=/usr/bin/python3 /srv/browser-companion/website/server.py
Restart=always

[Install]
WantedBy=multi-user.target
```

Nginx 反代（可选，用于挂域名 / TLS）：

```nginx
server {
    listen 443 ssl;
    server_name your.domain.com;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
    }
}
```

## 更新版本流程

1. 改代码 → `python3 build_all.py`（本地）或直接 push（云平台自动重新构建）
2. 页面版本号 / 体积 / 日期自动更新，无需改 HTML

## 安全要点

- CSP 禁止一切外部源（无 CDN / 无追踪）
- `X-Frame-Options: DENY` 防嵌套
- 下载接口仅允许 `chromium|firefox` 两个白名单文件，无路径穿越
- 统计文件原子写入（`os.replace`），多线程写入不损坏
