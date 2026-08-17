#!/usr/bin/env bash
# 构建 APK。不用 Gradle：这个工程零第三方依赖，直接调 aapt2/javac/d8/apksigner
# 就够了，省掉 Gradle 拉依赖的网络需求和几分钟启动时间。
#
# 用法：
#   ./android/build.sh              构建
#   ./android/build.sh install      构建并安装到已连接设备
#   ./android/build.sh run          构建、安装、启动

set -euo pipefail

SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
BT_VER="$(ls -1 "$SDK/build-tools" | sort -V | tail -1)"
BT="$SDK/build-tools/$BT_VER"
PLATFORM_VER="$(ls -1 "$SDK/platforms" | sed 's/android-//' | sort -n | tail -1)"
ANDROID_JAR="$SDK/platforms/android-$PLATFORM_VER/android.jar"
JDK="$SDK/java-17-openjdk-amd64/bin"
[ -x "$JDK/javac" ] || JDK="$(dirname "$(readlink -f "$(command -v javac)")")"
# d8 / apksigner / zipalign 里的 d8 与 apksigner 是 shell 包装脚本，
# 内部直接 exec java，所以必须把 JDK 放到 PATH 上，否则报 "exec: java：未找到"。
export JAVA_HOME="$(dirname "$JDK")"
export PATH="$JDK:$PATH"

MIN_SDK=26
TARGET_SDK="$PLATFORM_VER"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="$HERE/build"
PKG="com.rzh.studyhub"
APK="$OUT/study-hub.apk"
KS="$HERE/debug.keystore"

echo "SDK          $SDK"
echo "build-tools  $BT_VER"
echo "platform     android-$PLATFORM_VER (minSdk $MIN_SDK)"
echo

rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/classes" "$OUT/dex" "$OUT/assets"

# ---------- 1. 把 Web 应用打进 assets ----------
echo "[1/7] 收集 Web 资源"
for item in index.html check.html manifest.webmanifest sw.js css js data icons audio; do
  cp -r "$ROOT/$item" "$OUT/assets/"
done
# 只保留 PWA 真正用到的图标，去掉源 SVG 之外的多余文件
rm -f "$OUT/assets/icons/icon-512.png"  # APK 图标走 vector，网页只用到 192
ASSET_COUNT=$(find "$OUT/assets" -type f | wc -l)
ASSET_SIZE=$(du -sh "$OUT/assets" | cut -f1)
echo "      $ASSET_COUNT 个文件, $ASSET_SIZE"

# 自检：assets 里必须有这些，缺了 App 会白屏
for must in index.html js/app.js js/native.js js/jaspeech.js css/app.css \
            data/kana.json data/vocab.json data/plan.json data/phrases.json audio/manifest.json; do
  [ -f "$OUT/assets/$must" ] || { echo "!! assets 缺少 $must"; exit 1; }
done

# ---------- 2. 编译资源 ----------
echo "[2/7] aapt2 compile"
"$BT/aapt2" compile --dir "$HERE/res" -o "$OUT/res/res.zip"

echo "[3/7] aapt2 link"
"$BT/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$HERE/AndroidManifest.xml" \
  --java "$OUT/gen" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code 1 --version-name 1.0 \
  "$OUT/res/res.zip"

# ---------- 3. 编译 Java ----------
echo "[4/7] javac"
mkdir -p "$OUT/gen"
find "$HERE/src" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
# 注意：JDK 17 起 -source/-target 17 不允许再用 -bootclasspath，
# 所以 android.jar 走 -classpath。本工程只用 android.* 和 Android 也有的
# java.* 基础类，不会误用到 JDK 独有 API（d8 那步会兜底报错）。
"$JDK/javac" \
  -source 17 -target 17 \
  -classpath "$ANDROID_JAR" \
  -d "$OUT/classes" \
  -encoding UTF-8 \
  -nowarn -Xlint:-options \
  @"$OUT/sources.txt"

# ---------- 4. dex ----------
echo "[5/7] d8"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$BT/d8" --min-api "$MIN_SDK" --lib "$ANDROID_JAR" --output "$OUT/dex" @"$OUT/classes.txt"

# ---------- 5. 打包 ----------
echo "[6/7] 打包 assets + dex"
cd "$OUT"
cp base.apk unsigned.apk
# assets 与 classes.dex 直接塞进 apk（zip）。-X 去掉多余的额外字段。
(cd dex && zip -q -X ../unsigned.apk classes.dex)
zip -q -X -r unsigned.apk assets
"$BT/zipalign" -f -p 4 unsigned.apk aligned.apk

# ---------- 6. 签名 ----------
echo "[7/7] 签名"
if [ ! -f "$KS" ]; then
  echo "      生成调试签名 keystore（仅自用，有效期 30 年）"
  "$JDK/keytool" -genkeypair -v \
    -keystore "$KS" -storepass android -keypass android \
    -alias studyhub -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=StudyHub, OU=Personal, O=Personal, L=CN, ST=CN, C=CN" >/dev/null 2>&1
fi
"$BT/apksigner" sign \
  --ks "$KS" --ks-pass pass:android --key-pass pass:android --ks-key-alias studyhub \
  --min-sdk-version "$MIN_SDK" \
  --out "$APK" aligned.apk
"$BT/apksigner" verify --print-certs "$APK" | head -3

rm -f base.apk unsigned.apk aligned.apk
echo
echo "APK: $APK  ($(du -h "$APK" | cut -f1))"

case "${1:-}" in
  install|run)
    echo
    echo "安装中…"
    # 用 -r 覆盖安装保留数据；若签名冲突（之前装过别的签名）会失败，此时提示卸载
    if ! adb install -r "$APK"; then
      echo
      echo "!! 覆盖安装失败。若之前装过不同签名的版本，先执行："
      echo "     adb uninstall $PKG"
      exit 1
    fi
    if [ "${1:-}" = "run" ]; then
      adb shell am start -n "$PKG/.MainActivity" >/dev/null
      echo "已启动"
    fi
    ;;
esac
