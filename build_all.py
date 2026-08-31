#!/usr/bin/env python3
"""build_all.py — 生成各商店可提交的扩展安装包

产物（输出到 ../dist-packages/，不进 Git 仓库）：
  browser-companion-chromium.zip  适用于 Chrome / Edge / Opera / Tabbit / Brave / Arc 等
  browser-companion-firefox.zip   适用于 Firefox（AMO）

用法：
  python3 build_all.py
"""

import json
import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(ROOT), 'dist-packages')
EXCLUDE = {
    '.git', 'node_modules', '__pycache__', 'dist-firefox', 'dist-chromium',
    'dist-packages', 'manifest.firefox.json', 'build_firefox.py', 'build_all.py',
    'upload.py', 'upload_cws.py', 'sync_github.py',
    'generate_icons.py', 'listing-preview.html',
}

# Firefox 版不含 BrowserPilot：gecko manifest 未注册 content-bridge，
# 确认窗/协议文档/弹窗模块在 Firefox 均为死代码，打包时一并剔除。
FIREFOX_EXCLUDE = {
    'content-bridge.js', 'browserpilot-protocol.md',
    'bp-confirm.html', 'bp-confirm.js',
    os.path.join('modules', 'browserpilot.js'),
}


def collect(extra_exclude=None):
    files = []
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in EXCLUDE and not d.startswith('.')]
        for f in fn:
            if f in EXCLUDE or f.startswith('.'):
                continue
            full = os.path.join(dp, f)
            if extra_exclude and os.path.relpath(full, ROOT) in extra_exclude:
                continue
            files.append(full)
    return sorted(files)


def make_zip(out_zip, manifest_src, extra_exclude=None):
    tmp = os.path.join(OUT_DIR, '.tmp')
    if os.path.exists(tmp):
        shutil.rmtree(tmp)
    os.makedirs(tmp)
    for f in collect(extra_exclude):
        rel = os.path.relpath(f, ROOT)
        dst = os.path.join(tmp, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(f, dst)
    # 覆盖目标 manifest
    shutil.copy2(os.path.join(ROOT, manifest_src), os.path.join(tmp, 'manifest.json'))
    # 校验
    with open(os.path.join(tmp, 'manifest.json'), encoding='utf-8') as fh:
        mf = json.load(fh)
    with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED) as z:
        for dp, _dn, fn in os.walk(tmp):
            for f in fn:
                full = os.path.join(dp, f)
                z.write(full, os.path.relpath(full, tmp))
    shutil.rmtree(tmp)
    return mf, len(collect(extra_exclude))


def main():
    if os.path.exists(OUT_DIR):
        shutil.rmtree(OUT_DIR)
    os.makedirs(OUT_DIR)

    z1 = os.path.join(OUT_DIR, 'browser-companion-chromium.zip')
    mf1, n1 = make_zip(z1, 'manifest.json')
    print(f'✓ Chromium 包: {z1}')
    print(f'    version={mf1["version"]} 文件数={n1}  background={mf1["background"].get("service_worker","n/a")}')

    z2 = os.path.join(OUT_DIR, 'browser-companion-firefox.zip')
    mf2, n2 = make_zip(z2, 'manifest.firefox.json', FIREFOX_EXCLUDE)
    print(f'✓ Firefox 包:  {z2}')
    print(f'    version={mf2["version"]} 文件数={n2}  background={mf2["background"].get("scripts","n/a")}')
    print('产物目录:', OUT_DIR)


if __name__ == '__main__':
    main()
