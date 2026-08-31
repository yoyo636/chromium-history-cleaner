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

## 本地运行

```bash
# 1. 先生成安装包（产物在仓库同级 ../dist-packages）
python3 build_all.py

# 2. 启动官网
python3 website/server.py
# → http://localhost:8765
```

环境变量：

- `PORT` — 监听端口（默认 8765）
- `DIST_DIR` — 安装包目录（默认 `../dist-packages`，即 build_all.py 的输出位置）

## 服务器部署

上传 `website/` 目录与 `dist-packages/` 到服务器（保持两者同级或同级父目录）：

```bash
# systemd 常驻示例 /etc/systemd/system/browser-companion-site.service
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

1. 改代码 → `python3 build_all.py`（重新生成两包）
2. 重启 `server.py`（或无需重启——接口实时读 manifest 与文件）
3. 页面版本号 / 体积 / 日期自动更新，无需改 HTML

## 安全要点

- CSP 禁止一切外部源（无 CDN / 无追踪）
- `X-Frame-Options: DENY` 防嵌套
- 下载接口仅允许 `chromium|firefox` 两个白名单文件，无路径穿越
- 统计文件原子写入（`os.replace`），多线程写入不损坏
