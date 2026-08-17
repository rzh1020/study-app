#!/usr/bin/env bash
# 启动本地服务。
#
# 关键约束（已实测，见 tools/check_deploy.mjs）：
#   getUserMedia 和 Service Worker 都要求「安全上下文」。
#   http://<局域网IP>:8090 不是安全上下文 —— navigator.mediaDevices 这个 API
#   在手机上根本不存在，练声模块和离线缓存会直接废掉。
#   所以手机不能直接访问 PC 的局域网 IP，必须走下面两条路之一。
#
# 用法：
#   ./serve.sh          起服务；若检测到 adb 设备，自动做 adb reverse
#   ./serve.sh 9000     指定端口

set -euo pipefail
PORT="${1:-8090}"
cd "$(dirname "$0")"

echo "=== 本机自测 ==="
echo "  http://localhost:$PORT/"
echo

if command -v adb >/dev/null 2>&1; then
  DEV=$(adb devices | awk 'NR>1 && $2=="device" {print $1}' | head -1 || true)
  if [ -n "$DEV" ]; then
    # adb reverse 让手机上的 localhost:PORT 指向 PC 的同端口。
    # 手机看到的 origin 是 http://localhost，属于安全上下文，麦克风和 SW 都可用。
    if adb -s "$DEV" reverse "tcp:$PORT" "tcp:$PORT" >/dev/null 2>&1; then
      echo "=== 手机（已连 USB: $DEV）==="
      echo "  adb reverse 已建立。手机浏览器打开："
      echo "    http://localhost:$PORT/"
      echo "  然后菜单里「添加到主屏幕」装成 App。"
      echo "  装好并进过一次各页面后，Service Worker 会缓存全部资源，"
      echo "  拔掉 USB 也能离线使用（数据本来就全在手机本地）。"
      echo
    else
      echo "!! adb reverse 失败（可能设备未授权），手机侧请改用 HTTPS 托管方式。"
      echo
    fi
  else
    echo "(未检测到 adb 设备。插上手机并授权后重跑本脚本即可自动建立 adb reverse)"
    echo
  fi
else
  echo "(未安装 adb)"
  echo
fi

echo "=== 长期使用建议 ==="
echo "  adb reverse 需要每次插线重建。长期用建议把这个目录推到任意 HTTPS 静态托管"
echo "  （GitHub Pages / Cloudflare Pages / Vercel 都可以，纯静态无后端），"
echo "  然后手机直接访问那个 https:// 地址并添加到主屏幕，之后完全离线运行。"
echo "  数据只存在手机本地 IndexedDB，不会上传，但记得在「数据」页定期导出备份。"
echo

trap 'if [ -n "${DEV:-}" ]; then adb -s "$DEV" reverse --remove "tcp:$PORT" >/dev/null 2>&1 || true; fi' EXIT

if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT" --bind 0.0.0.0
else
  exec npx --yes serve -l "$PORT" .
fi
