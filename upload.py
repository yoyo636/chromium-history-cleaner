#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通过 gh api (REST, api.github.com) 将插件文件推送到 GitHub。

git 直推被沙箱代理拦截（github.com CONNECT 502），但 api.github.com 可达，
故改用 contents API（base64）上传，文本与 PNG 二进制均可正确存储。
"""

import base64
import json
import subprocess
import sys
from pathlib import Path

OWNER = "yoyo636"
REPO = "chromium-history-cleaner"
BRANCH = "main"
MSG = "feat: 通用 Chromium 历史记录清理插件 (Manifest V3)"

ROOT = Path(__file__).resolve().parent
SKIP = {".git", ".DS_Store"}


def list_files():
    out = []
    for p in sorted(ROOT.rglob("*")):
        if p.is_dir():
            continue
        rel = p.relative_to(ROOT).as_posix()
        if rel.split("/")[0] in SKIP:
            continue
        if any(part in SKIP for part in rel.split("/")):
            continue
        out.append(rel)
    return out


def gh_api(method, path, fields):
    cmd = ["gh", "api", "--method", method, path]
    for k, v in fields.items():
        cmd += ["-f", f"{k}={v}"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"gh api {method} {path} failed:\n{r.stderr}")
    return r.stdout


def get_sha(path):
    try:
        out = subprocess.run(
            ["gh", "api", f"/repos/{OWNER}/{REPO}/contents/{path}?ref={BRANCH}"],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(out.stdout).get("sha")
    except Exception:
        return None


def main():
    files = list_files()
    print("will upload:", files)
    for rel in files:
        data = (ROOT / rel).read_bytes()
        b64 = base64.b64encode(data).decode("ascii")
        url = f"/repos/{OWNER}/{REPO}/contents/{rel}"
        fields = {"message": MSG, "branch": BRANCH, "content": b64}
        try:
            gh_api("PUT", url, fields)
            print(f"  ✓ {rel} ({len(data)} bytes)")
        except RuntimeError as e:
            # 已存在则需要 SHA
            if "sha" in str(e).lower() or "required" in str(e).lower():
                sha = get_sha(rel)
                if sha:
                    fields["sha"] = sha
                    gh_api("PUT", url, fields)
                    print(f"  ✓ {rel} (updated, {len(data)} bytes)")
                    continue
            print(f"  ✗ {rel}\n{e}", file=sys.stderr)
            raise
    print("DONE")


if __name__ == "__main__":
    main()
