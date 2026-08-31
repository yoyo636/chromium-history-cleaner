#!/usr/bin/env python3
"""upload_cws.py — Chrome Web Store 一键上传 / 更新脚本（Web Store API）

用法：
  1) 一次性授权（需 5 分钟准备，见下）：
       python3 upload_cws.py --authorize
     浏览器会打开 Google 授权页 → 登录你的账号并同意 → 自动回调，凭据存入配置。
  2) 上传 / 更新（生成草稿，发布仍需在开发者后台点「提交」）：
       python3 upload_cws.py --zip ../dist-packages/browser-companion-chromium.zip

首次使用前的准备工作（必须由你本人完成，涉及账号与支付）：
  1. 在 https://chrome.google.com/webstore/devconsole 注册开发者（一次性 $5）。
  2. 打开 Google Cloud Console → 新建/选择项目 → 启用「Chrome Web Store API」。
  3. 「API 和服务 → OAuth 同意屏幕」：External，填应用名称，添加测试用户（你的 Google 账号）。
  4. 「凭据 → 创建凭据 → OAuth 客户端 ID」：类型选「桌面应用」，创建后复制 Client ID / Client Secret。
  5. 执行：python3 upload_cws.py --authorize，按提示粘贴 Client ID / Client Secret 并完成授权。

配置存于 ../cws-config.json（workspace 根目录，不会进入 Git 仓库）。

说明：本脚本仅「上传」新版本为草稿，最终发布状态需在
https://chrome.google.com/webstore/devconsole 手动「提交审核」（审核有人工环节，无法自动化）。
"""

import http.server
import json
import os
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

SCOPE = "https://www.googleapis.com/auth/chromewebstore"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/chromewebstore/v1.1/items"

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(os.path.dirname(ROOT), "cws-config.json")
DEFAULT_ZIP = os.path.join(
    os.path.dirname(ROOT), "dist-packages", "browser-companion-chromium.zip"
)

# 本地回环授权回调端口
PORT = 48231
REDIRECT_URI = f"http://localhost:{PORT}"


def load_config():
    if not os.path.exists(CONFIG_PATH):
        return {}
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.chmod(CONFIG_PATH, 0o600)  # 仅本人可读


def post_form(url, data):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


def refresh_access(cfg):
    data = post_form(TOKEN_URL, {
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "refresh_token": cfg["refresh_token"],
        "grant_type": "refresh_token",
    })
    return data["access_token"]


def authorize():
    cfg = load_config()
    if "client_id" not in cfg:
        print("请粘贴 Google Cloud 的 OAuth Client ID：")
        cfg["client_id"] = input("Client ID: ").strip()
        print("请粘贴 OAuth Client Secret：")
        cfg["client_secret"] = input("Client Secret: ").strip()
        save_config(cfg)

    received = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            received["code"] = q.get("code", [None])[0]
            received["error"] = q.get("error", [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            ok = received.get("code") is not None
            msg = ("授权成功，可关闭此页面并回到终端。" if ok
                   else "授权失败：" + str(received.get("error")))
            self.wfile.write(
                f"<html><body style='font-family:sans-serif;padding:40px'><h2>{msg}</h2>"
                f"<p>请回到命令行窗口继续。</p></body></html>".encode("utf-8")
            )

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    params = {
        "client_id": cfg["client_id"],
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
    }
    print("正在打开浏览器授权…若未自动打开，请访问：")
    print(AUTH_URL + "?" + urllib.parse.urlencode(params))
    webbrowser.open(AUTH_URL + "?" + urllib.parse.urlencode(params))

    # 等待回调（最多 120 秒）
    for _ in range(120):
        if "code" in received:
            break
        import time
        time.sleep(1)
    server.shutdown()

    code = received.get("code")
    if not code:
        print("✗ 授权超时或失败。")
        sys.exit(1)

    data = post_form(TOKEN_URL, {
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    })
    if "refresh_token" not in data:
        print("✗ 未获得 refresh_token（请确认 OAuth 同意屏幕中已把账号加入测试用户，且 prompt=consent）。")
        sys.exit(1)
    cfg["refresh_token"] = data["refresh_token"]
    save_config(cfg)
    print("✓ 授权成功，凭据已保存：", CONFIG_PATH)


def upload(zip_path):
    cfg = load_config()
    for k in ("client_id", "client_secret", "refresh_token"):
        if k not in cfg:
            print(f"✗ 缺少配置 {k}，请先运行：python3 upload_cws.py --authorize")
            sys.exit(1)
    token = refresh_access(cfg)

    with open(zip_path, "rb") as f:
        payload = f.read()
    print(f"上传 {zip_path}（{len(payload) / 1024:.0f} KB）…")

    url = UPLOAD_URL
    if cfg.get("item_id"):
        url += "/" + cfg["item_id"]
    url += "?uploadType=media"

    req = urllib.request.Request(url, data=payload, method="POST")
    # access_token 走 Authorization 头，不要放 URL query——query 会进代理/服务器访问日志
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/zip")
    req.add_header("x-goog-api-version", "2")

    try:
        with urllib.request.urlopen(req) as r:
            res = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print("✗ 上传失败：", e.code, e.read().decode()[:500])
        sys.exit(1)

    item_id = res.get("id") or cfg.get("item_id")
    if item_id and not cfg.get("item_id"):
        cfg["item_id"] = item_id
        save_config(cfg)

    print("✓ 已上传。Item ID:", item_id)
    print("  管理地址: https://chrome.google.com/webstore/devconsole")
    print("  状态:", res.get("itemError") or res.get("uploadState") or "OK")
    if res.get("itemError"):
        print("  ⚠️ 请到开发者后台处理上述 itemError 后提交审核。")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)
    cmd = sys.argv[1]
    if cmd == "--authorize":
        authorize()
    elif cmd == "--upload":
        zip_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_ZIP
        if not os.path.exists(zip_path):
            print("✗ 找不到 zip：", zip_path)
            print("  请先运行 python3 chromium-history-manager/build_all.py 生成提交包。")
            sys.exit(1)
        upload(zip_path)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
