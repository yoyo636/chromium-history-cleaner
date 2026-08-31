#!/usr/bin/env python3
"""server.py — 「浏览器搭子」官网后端

功能：
  - 静态托管 site/ 目录（介绍页）
  - /api/version   最新版本与两包元信息（大小 / 更新时间）
  - /api/download?target=chromium|firefox  直接下载 zip（带正确文件名）
  - /api/stats     简单下载计数（存 site/.stats.json，首次自动创建）

用法：
  python3 server.py            # 默认 http://localhost:8765
  PORT=9000 python3 server.py  # 自定义端口

生产部署（Nginx 反代示例）：
  location / { proxy_pass http://127.0.0.1:8765; }
"""

import json
import os
import re
import time
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(ROOT)
SITE_DIR = os.path.join(ROOT, "site")
# build_all.py 输出到仓库同级目录 ../dist-packages（不进 Git 仓库）
DIST_DIR = os.environ.get("DIST_DIR") or os.path.join(os.path.dirname(REPO_DIR), "dist-packages")
STATS_PATH = os.path.join(SITE_DIR, ".stats.json")

PACKAGES = {
    "chromium": {
        "path": os.path.join(DIST_DIR, "browser-companion-chromium.zip"),
        "display": "浏览器搭子 · Chromium 版",
        "browsers": "Chrome / Edge / Opera / Brave / Arc / Tabbit",
        "file": "browser-companion-chromium.zip",
    },
    "firefox": {
        "path": os.path.join(DIST_DIR, "browser-companion-firefox.zip"),
        "display": "浏览器搭子 · Firefox 版",
        "browsers": "Firefox 126+（AMO 包）",
        "file": "browser-companion-firefox.zip",
    },
}

VERSION_RE = re.compile(r'"version"\s*:\s*"([^"]+)"')


def read_manifest_version():
    mf = os.path.join(REPO_DIR, "manifest.json")
    try:
        with open(mf, encoding="utf-8") as f:
            m = VERSION_RE.search(f.read())
            return m.group(1) if m else "unknown"
    except OSError:
        return "unknown"


def load_stats():
    try:
        with open(STATS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"chromium": 0, "firefox": 0, "total": 0}


def save_stats(stats):
    tmp = STATS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(stats, f)
    os.replace(tmp, STATS_PATH)


def package_info(key):
    p = PACKAGES[key]
    if not os.path.exists(p["path"]):
        return None
    return {
        "target": key,
        "display": p["display"],
        "browsers": p["browsers"],
        "size_kb": round(os.path.getsize(p["path"]) / 1024),
        "mtime": int(os.path.getmtime(p["path"])),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE_DIR, **kwargs)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---------- API ----------

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def api_version(self):
        packs = {k: package_info(k) for k in PACKAGES}
        self.send_json({"version": read_manifest_version(), "packages": packs})

    def api_stats(self):
        self.send_json(load_stats())

    def api_download(self):
        from urllib.parse import urlparse, parse_qs

        q = parse_qs(urlparse(self.path).query)
        target = (q.get("target", ["chromium"])[0] or "").lower()
        if target not in PACKAGES:
            return self.send_json({"error": "target 必须是 chromium 或 firefox"}, 400)
        p = PACKAGES[target]
        if not os.path.exists(p["path"]):
            return self.send_json({"error": "安装包尚未生成，请先运行 build_all.py"}, 503)

        stats = load_stats()
        stats[target] = stats.get(target, 0) + 1
        stats["total"] = stats.get("total", 0) + 1
        save_stats(stats)

        size = os.path.getsize(p["path"])
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(size))
        self.send_header(
            "Content-Disposition",
            "attachment; filename=\"%s\"" % p["file"],
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with open(p["path"], "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)

    # ---------- 路由 ----------

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/version":
            return self.api_version()
        if path == "/api/stats":
            return self.api_stats()
        if path == "/api/download":
            return self.api_download()
        return super().do_GET()

    def end_headers(self):
        # CSP：允许内联样式/脚本（单文件自包含页），禁止任何外部源
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self' 'unsafe-inline'; "
            "script-src 'self' 'unsafe-inline'; img-src 'self' data:; "
            "connect-src 'self'; frame-ancestors 'none'",
        )
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()


def main():
    port = int(os.environ.get("PORT", "8765"))
    if not os.path.isdir(SITE_DIR):
        raise SystemExit("缺少 site/ 目录")
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("✓ 官网服务已启动: http://localhost:%d" % port)
    print("  静态目录: %s" % SITE_DIR)
    print("  安装包目录: %s" % DIST_DIR)
    srv.serve_forever()


if __name__ == "__main__":
    main()
