#!/usr/bin/env python3
"""build_firefox.py — 生成 Firefox 版（AMO 可提交）扩展包

用法：
  python3 build_firefox.py [输出目录]

说明：
  - 以 manifest.firefox.json 作为 Firefox 版 manifest（background.scripts 事件页
    + gecko 配置），覆盖为 manifest.json 后打包 zip。
  - 其余源码与 Chromium 版完全一致（代码内已做能力降级：tabs.discard 检测、
    performance.memory 缺失降级、browsingData.serviceWorkers 过滤等）。
  - 默认输出到 dist-firefox/ 目录。
"""

import json
import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
MANIFEST_FIREFOX = os.path.join(ROOT, 'manifest.firefox.json')
EXCLUDE = {
    '.git', 'node_modules', '__pycache__', 'dist-firefox', 'dist-chromium',
    'manifest.firefox.json', 'build_firefox.py', 'build_all.py',
    'upload.py', 'upload_cws.py', 'sync_github.py',
    'generate_icons.py', 'listing-preview.html',
}

# Firefox 版不含 BrowserPilot：gecko manifest 未注册 content-bridge，
# 确认窗/协议文档/弹窗模块在 Firefox 均为死代码，打包时一并剔除。
FIREFOX_EXCLUDE = (
    'content-bridge.js', 'browserpilot-protocol.md',
    'bp-confirm.html', 'bp-confirm.js',
    os.path.join('modules', 'browserpilot.js'),
)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist-firefox')
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)

    # 校验 Firefox manifest
    with open(MANIFEST_FIREFOX, 'r', encoding='utf-8') as f:
        mf = json.load(f)
    assert mf['manifest_version'] == 3
    assert 'scripts' in mf.get('background', {}), 'Firefox 需使用 background.scripts（事件页）'

    # 复制文件
    copied = []
    for name in os.listdir(ROOT):
        if name in EXCLUDE or name.startswith('.'):
            continue
        src = os.path.join(ROOT, name)
        dst = os.path.join(out_dir, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns('.git', '__pycache__'))
            copied.append(name + '/')
        else:
            shutil.copy2(src, dst)
            copied.append(name)

    # 用 Firefox manifest 覆盖
    shutil.copy2(MANIFEST_FIREFOX, os.path.join(out_dir, 'manifest.json'))

    # 剔除 BrowserPilot 相关文件（Firefox 版不提供该功能）
    for rel in FIREFOX_EXCLUDE:
        p = os.path.join(out_dir, rel)
        if os.path.exists(p):
            os.remove(p)

    # 打包 zip
    zip_path = os.path.join(out_dir, 'browser-companion-firefox.zip')
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for root_dir, _dirs, files in os.walk(out_dir):
            for fn in files:
                if fn.endswith('.zip'):
                    continue
                full = os.path.join(root_dir, fn)
                rel = os.path.relpath(full, out_dir)
                z.write(full, rel)

    print('✓ Firefox 包已生成：', zip_path)
    print('  文件数：', len(copied))
    print('  已用 Firefox manifest：background.scripts =', mf['background']['scripts'])


if __name__ == '__main__':
    main()
