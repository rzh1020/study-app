set -e
cd /home/mi/rzh/claude/study-app/.asr
HF=https://hf-mirror.com/onnx-community/whisper-base/resolve/main
mkdir -p whisper-base/onnx
for f in config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json; do
  curl -sL -m 200 -o "whisper-base/$f" "$HF/$f"
done
for f in encoder_model_quantized.onnx decoder_model_merged_quantized.onnx; do
  curl -sL -m 1800 -o "whisper-base/onnx/$f" "$HF/onnx/$f"
done
echo DONE; du -sh whisper-base; ls -la whisper-base/onnx
