set -e
cd /home/mi/rzh/claude/study-app/.nmt/opus-mt-ja-zh
HF=https://hf-mirror.com/shun89/opus-mt-ja-zh/resolve/main
for f in config.json generation_config.json source.spm target.spm special_tokens_map.json tokenizer_config.json vocab.json; do
  curl -sL -m 300 -o "$f" "$HF/$f"
done
curl -sL -m 1800 -o pytorch_model.bin "$HF/pytorch_model.bin"
echo DONE; ls -la
