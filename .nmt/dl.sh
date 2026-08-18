set -e
cd /home/mi/rzh/claude/study-app/.nmt/opus-mt-tc-big-zh-ja
HF=https://hf-mirror.com/Helsinki-NLP/opus-mt-tc-big-zh-ja/resolve/main
for f in config.json generation_config.json source.spm target.spm special_tokens_map.json tokenizer_config.json vocab.json; do
  curl -sL -m 300 -o "$f" "$HF/$f"
done
curl -sL -m 1800 -o model.safetensors "$HF/model.safetensors"
echo DONE; ls -la
