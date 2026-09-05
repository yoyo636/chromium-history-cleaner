#!/usr/bin/env bash
# deploy_static.sh — 把官网部署到「只支持静态文件」的托管平台
# （如 Spookhost / cPanel / GitHub Pages / Vercel 静态导出等）
#
# 用法：
#   ./deploy_static.sh [目标目录]          # 默认 ./dist
#   ./deploy_static.sh /var/www/html/site  # 指定目标
#
# 前置：python3 build_all.py --web  （生成 website/dist-packages/*.zip）
# 产出：目标目录下包含
#   index.html  privacy.html  icons/  downloads/*.zip
#   下载按钮在 API 不可用时自动指向 /downloads/browser-companion-<target>.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/website"
OUT="${1:-$WEB/dist}"

echo "==> 生成安装包（--web 模式输出到 website/dist-packages/）"
python3 "$WEB/../build_all.py" --web > /dev/null

echo "==> 准备发布目录: $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/downloads"

# 复制静态页面与图标
cp "$WEB/site/index.html" "$WEB/site/privacy.html" "$OUT/"
cp -r "$WEB/site/icons" "$OUT/"

# 复制安装包到 downloads/（直链路径）
cp "$WEB/dist-packages/browser-companion-chromium.zip" "$OUT/downloads/"
cp "$WEB/dist-packages/browser-companion-firefox.zip" "$OUT/downloads/"

echo "==> 产出："
find "$OUT" -type f | sort | sed "s|$OUT/||" | while read f; do
  printf "    %s  (%s)\n" "$f" "$(du -h "$OUT/$f" | cut -f1)"
done

echo
echo "✓ 部署包就绪，上传 $OUT/* 到托管平台根目录即可"
echo "  下载直链: /downloads/browser-companion-chromium.zip"
echo "           /downloads/browser-companion-firefox.zip"