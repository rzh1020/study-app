set -e
cd /home/mi/rzh/claude/study-app/.tts/kokoro
HF=https://hf-mirror.com/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main
for f in config.json tokenizer.json tokenizer_config.json; do curl -sL -m 120 -o "$f" "$HF/$f"; done
curl -sL -m 300 -o jf_alpha.bin "$HF/voices/jf_alpha.bin"
curl -sL -m 300 -o jm_kumo.bin "$HF/voices/jm_kumo.bin"
curl -sL -m 1800 -o model_quantized.onnx "$HF/onnx/model_quantized.onnx"
echo DONE; ls -la
