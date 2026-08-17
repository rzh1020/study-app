#!/usr/bin/env bash
# 下载构建词库所需的开放数据源到 .data-src/（已 gitignore，不入库）。
#
# 原始数据总计约 35MB，不入库的原因：
#   1. 体积大且可重新获取
#   2. 各自有不同许可，混进本仓库会让许可关系变复杂
#   3. 上游会更新，跑一次脚本就能拿到最新版
# 许可与署名见 NOTICE.md。
#
# 用法：./tools/fetch_sources.sh && python3 tools/build_vocab.py

set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data-src
cd .data-src
UA="Mozilla/5.0 (study-app data pipeline)"

get() {  # get <输出名> <url> <说明>
  local out="$1" url="$2" desc="$3"
  if [ -s "$out" ]; then
    printf '  已有  %-22s %8s  %s\n' "$out" "$(du -h "$out" | cut -f1)" "$desc"
    return
  fi
  printf '  下载  %-22s ' "$out"
  local code
  code=$(curl -sL -m 600 -A "$UA" -o "$out" -w '%{http_code}' "$url")
  if [ "$code" != "200" ] || [ ! -s "$out" ]; then
    rm -f "$out"
    echo "失败 (HTTP $code)"
    echo "     $url"
    return 1
  fi
  printf '%8s  %s\n' "$(du -h "$out" | cut -f1)" "$desc"
}

echo "词形/读音/词性 —— JMdict (EDRDG, CC BY-SA 4.0)"
get JMdict_e.gz        "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz"                                  "日英词典，取结构不取释义"
get kanjidic2.xml.gz   "http://ftp.edrdg.org/pub/Nihongo/kanjidic2.xml.gz"                             "汉字音读/训读（备用）"

echo "中文释义 —— Japanese-Chinese-thesaurus (Unlicense)"
get jc.json            "https://raw.githubusercontent.com/lxl66566/Japanese-Chinese-thesaurus/main/final.json" "12716 条中释"

echo "词频排序 —— tubelex-ja (BSD-3-Clause)"
get tubelex.tsv.xz     "https://raw.githubusercontent.com/adno/tubelex/main/results/tubelex-ja.tsv.xz"  "9.9 万 YouTube 字幕语料"

echo "例句 —— Tatoeba (CC BY 2.0 FR)"
get links.tsv.bz2      "https://downloads.tatoeba.org/exports/per_language/jpn/jpn-cmn_links.tsv.bz2"   "中日句对照关系"
get jpn.tsv.bz2        "https://downloads.tatoeba.org/exports/per_language/jpn/jpn_sentences.tsv.bz2"   "日语句"
get cmn.tsv.bz2        "https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2"   "中文句"

echo
echo "解压…"
[ -f tubelex.tsv ] || { xz -dkf tubelex.tsv.xz 2>/dev/null || unxz -kf tubelex.tsv.xz; }
for f in links jpn cmn; do [ -f "$f.tsv" ] || bunzip2 -kf "$f.tsv.bz2"; done

echo
echo "就绪。下一步：python3 tools/build_vocab.py --limit 2000"
ls -la | awk 'NR>3 {printf "  %-24s %s\n", $9, $5}'
