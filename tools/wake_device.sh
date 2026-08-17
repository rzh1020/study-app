#!/usr/bin/env bash
# 把 App 唤到前台并把 WebView DevTools 端口转发好。
#
# 为什么需要这个：HyperOS 会冻结后台应用，被冻结时 devtools 端口不响应
# （表现为 curl /json/version 超时），而灭屏 + 锁屏又会让 App 掉到后台。
# 每次手工敲一遍唤醒序列很费时间，固化成脚本。
#
# 用法：./tools/wake_device.sh [端口]
set -uo pipefail
PORT="${1:-9333}"
PKG=com.rzh.studyhub

for i in 1 2 3 4 5; do
  adb shell svc power stayon true >/dev/null 2>&1
  adb shell input keyevent 224 >/dev/null 2>&1   # KEYCODE_WAKEUP
  sleep 1
  adb shell wm dismiss-keyguard >/dev/null 2>&1
  sleep 1
  adb shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1
  sleep 3

  FOCUS=$(adb shell dumpsys window 2>/dev/null | tr -d '\r' | grep -m1 mCurrentFocus)
  PID=$(adb shell pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')
  if [ -n "$PID" ]; then
    adb forward --remove "tcp:$PORT" >/dev/null 2>&1
    adb forward "tcp:$PORT" "localabstract:webview_devtools_remote_$PID" >/dev/null 2>&1
    if curl -s -m 6 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
      echo "就绪 (第 $i 次)  pid=$PID  port=$PORT"
      echo "$FOCUS"
      exit 0
    fi
  fi
  echo "第 $i 次未就绪: ${FOCUS:-无焦点信息}"
done

echo "!! 无法唤起 App。屏幕可能锁着且需要手动解锁。" >&2
exit 1
