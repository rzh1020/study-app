set -e
cd /home/mi/rzh/claude/study-app
. .nmt/venv/bin/activate
export NMT_SRC=opus-mt-ja-zh NMT_OUT=out-ja-zh NMT_FP32=onnx-fp32-ja NMT_CACHE_FP32=onnx-cache-fp32-ja
python .nmt/export.py export quantize spm
python .nmt/export_cache.py
echo ALLDONE
