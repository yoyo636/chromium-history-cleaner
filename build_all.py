#!/usr/bin/env python3
"""build_all.py — 生成各商店可提交的扩展安装包

产物（默认输出到 ../dist-packages/，不进 Git 仓库）：
  browser-companion-chromium.zip  适用于 Chrome / Edge / Opera / Tabbit / Brave / Arc 等
  browser-companion-firefox.zip   适用于 Firefox（AMO）

用法：
  python3 build_all.py           # 输出到 ../dist-packages/（本地/商店上传）
  python3 build_all.py --web     # 输出到 website/dist-packages/（云部署官网用，
                                 # server.py 启动前由云平台构建命令自动运行）
"""

import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_OUT_DIR = os.path.join(ROOT, 'website', 'dist-packages')
OUT_DIR = WEB_OUT_DIR if '--web' in sys.argv else os.path.join(os.path.dirname(ROOT), 'dist-packages')
EXCLUDE = {
    '.git', 'node_modules', '__pycache__', 'dist-firefox', 'dist-chromium',
    'dist-packages', 'manifest.firefox.json', 'build_firefox.py', 'build_all.py',
    'upload.py', 'upload_cws.py', 'sync_github.py',
    'generate_icons.py', 'listing-preview.html',
    'website',
    # win-installer/ 是 Windows 安装包的构建目录（内含 extension/ 完整副本），
    # 绝不能打进扩展 zip，否则会嵌套一份自己、体积翻倍。
    'win-installer',
}

# Firefox 版不含 BrowserPilot：gecko manifest 未注册 content-bridge，
# 确认窗/协议文档/弹窗模块在 Firefox 均为死代码，打包时一并剔除。
FIREFOX_EXCLUDE = {
    'content-bridge.js', 'browserpilot-protocol.md',
    'bp-confirm.html', 'bp-confirm.js',
    os.path.join('modules', 'browserpilot.js'),
}

# ----------------------- Windows 安装包（NSIS）-----------------------
WIN_NSIS = os.path.join(ROOT, 'win-installer', 'BrowserCompanion-Setup.nsi')
WIN_EXT = os.path.join(ROOT, 'win-installer', 'extension')
# 同步到 win-installer/extension 时额外排除（避免把仓库子目录/工具脚本带进安装包，
# 尤其不能把源里的 win-installer/ 自己再嵌套进去）
WIN_EXTRA_EXCLUDE = {'win-installer', 'render.yaml', 'build_chromium.py'}


def sync_windows_extension():
    """把当前扩展源码（排除构建产物）原样同步进 win-installer/extension/。"""
    if os.path.isdir(WIN_EXT):
        shutil.rmtree(WIN_EXT)
    os.makedirs(WIN_EXT)
    for f in collect():
        rel = os.path.relpath(f, ROOT)
        top = rel.split(os.sep)[0]
        if top in WIN_EXTRA_EXCLUDE or os.path.basename(f) in WIN_EXTRA_EXCLUDE:
            continue
        dst = os.path.join(WIN_EXT, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(f, dst)
    # manifest.firefox.json 也是扩展一部分，装包时一并带上（不影响 Chrome 加载）
    ff = os.path.join(ROOT, 'manifest.firefox.json')
    if os.path.exists(ff):
        shutil.copy2(ff, os.path.join(WIN_EXT, 'manifest.firefox.json'))


def stamp_nsis_version(ver):
    """让 NSIS 脚本里的 VERSION / VIProductVersion 跟随 manifest 版本。"""
    if not os.path.exists(WIN_NSIS):
        return
    s = open(WIN_NSIS, encoding='utf-8').read()
    s2 = re.sub(r'(!define VERSION\s+)"[\d.]+"', r'\1"%s"' % ver, s)
    s2 = re.sub(r'(VIProductVersion\s+)"[\d.]+"', r'\1"%s.0"' % ver, s2)
    if s2 != s:
        open(WIN_NSIS, 'w', encoding='utf-8').write(s2)


def build_windows():
    """同步扩展 + 对齐版本 + 调用 makensis 生成安装包（best-effort）。"""
    try:
        ver = json.load(open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8'))['version']
    except Exception:
        ver = None
    if ver:
        stamp_nsis_version(ver)
    sync_windows_extension()
    # nsi 的 OutFile 是 ..\dist-packages\...（相对 nsi 所在目录），即 ROOT/dist-packages。
    # 先建好该暂存目录，构建完再把 exe 挪到与 zip 相同的 OUT_DIR，保持产物集中。
    nsi_dir = os.path.dirname(WIN_NSIS)
    local_dist = os.path.join(ROOT, 'dist-packages')
    os.makedirs(local_dist, exist_ok=True)
    try:
        subprocess.run(['makensis', WIN_NSIS], cwd=nsi_dir,
                       capture_output=True, text=True, check=True)
    except FileNotFoundError:
        print('⚠ 未找到 makensis，跳过 Windows 安装包'
              '（可手动 cd win-installer && makensis BrowserCompanion-Setup.nsi）')
        _cleanup_local_dist(local_dist)
        return
    except subprocess.CalledProcessError as e:
        print('✗ Windows 安装包构建失败：')
        print((e.stderr or e.stdout)[-800:])
        sys.exit(1)
    moved = []
    for f in sorted(os.listdir(local_dist)):
        if f.lower().endswith('.exe'):
            src = os.path.join(local_dist, f)
            dst = os.path.join(OUT_DIR, f)
            if os.path.abspath(src) != os.path.abspath(dst):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.move(src, dst)
            moved.append(dst)
    _cleanup_local_dist(local_dist)
    if moved:
        for m in moved:
            print('✓ Windows 安装包: ' + m)
    else:
        print('⚠ makensis 执行成功，但未找到 exe 产物')


def _cleanup_local_dist(local_dist):
    """构建用的暂存目录用完即删，避免留在仓库里。"""
    try:
        if os.path.isdir(local_dist) and not os.listdir(local_dist):
            os.rmdir(local_dist)
    except OSError:
        pass



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
    build_windows()


if __name__ == '__main__':
    main()
