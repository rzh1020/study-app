set -e
cd /home/mi/rzh/claude/study-app/.asr/sensevoice
HF=https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main
curl -sL -m 120 -o tokens.txt "$HF/tokens.txt"
curl -sL -m 120 -o export-onnx.py "$HF/export-onnx.py"
curl -sL -m 120 -o README.md "$HF/README.md"
for w in zh.wav ja.wav en.wav; do curl -sL -m 120 -o "test_$w" "$HF/test_wavs/$w" || true; done
curl -sL -m 2400 -o model.int8.onnx "$HF/model.int8.onnx"
echo DONE; ls -la
