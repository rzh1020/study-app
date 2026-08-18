#!/usr/bin/env bash
# 把离线翻译需要的两块东西放进工程：
#   1. onnxruntime-web 运行时（从 node_modules 取，只要单线程 SIMD 那一套，
#      不要 jsep 变体 —— 那是 WebGPU 用的，多 10MB 而 WebView 里用不上）
#   2. int8 量化后的 NMT 模型（由 .nmt/export.py 生成）
#
# 这两份都不入 git（一个 12MB 一个 280MB），靠本脚本从源头复制。
# 模型不在时给出明确提示，而不是让 App 到运行时才白屏。
set -euo pipefail
cd "$(dirname "$0")/.."

ORT_SRC="node_modules/onnxruntime-web/dist"
ORT_DST="vendor/ort"
MODEL_SRC=".nmt/out-zh-ja"
MODEL_DST="models/zh-ja"

echo "[1/2] onnxruntime-web 运行时"
[ -d "$ORT_SRC" ] || { echo "!! 缺 $ORT_SRC，先跑 npm i"; exit 1; }
mkdir -p "$ORT_DST"
for f in ort.min.mjs ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm; do
  cp "$ORT_SRC/$f" "$ORT_DST/"
  printf '      %-36s %s\n' "$f" "$(du -h "$ORT_DST/$f" | cut -f1)"
done

echo "[2/2] 翻译模型"
if [ ! -f "$MODEL_SRC/encoder.int8.onnx" ]; then
  echo "!! 缺 $MODEL_SRC/encoder.int8.onnx"
  echo "   生成方式（需要联网拉模型，约 15 分钟）："
  echo "     bash .nmt/setup_env.sh                # 建 venv 装 torch/optimum"
  echo "     bash .nmt/dl.sh                       # 下 opus-mt-tc-big-zh-ja"
  echo "     . .nmt/venv/bin/activate && python .nmt/export.py && python .nmt/export_cache.py"
  exit 1
fi
mkdir -p "$MODEL_DST"
for f in encoder.int8.onnx decoder_step.int8.onnx spm-src.json vocab-tgt.json nmt.json; do
  cp "$MODEL_SRC/$f" "$MODEL_DST/"
  printf '      %-36s %s\n' "$f" "$(du -h "$MODEL_DST/$f" | cut -f1)"
done

echo
echo "合计 $(du -sh "$ORT_DST" "$MODEL_DST" | awk '{s+=$1} END {print}' )"
du -sh "$ORT_DST" "$MODEL_DST"
