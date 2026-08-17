# 第三方数据署名

本项目的日语学习内容由多个开放数据集构建而成。构建脚本见 `tools/build_vocab.py`，
原始数据不入库（`.data-src/` 已 gitignore），运行 `tools/fetch_sources.sh` 可重新下载。

---

## JMdict / KANJIDIC2

- 来源：Electronic Dictionary Research and Development Group (EDRDG)
- 网址：https://www.edrdg.org/jmdict/j_jmdict.html
- 许可：Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)
- 用途：日语词形、假名读音、词性、动词分类、词条筛选

> This project uses the JMdict/EDICT and KANJIDIC dictionary files.
> These files are the property of the Electronic Dictionary Research and Development
> Group, and are used in conformance with the Group's licence.

按 CC BY-SA 4.0 的传染性要求，由该数据派生的部分（`data/vocab.json` 中来自 JMdict
的字段）同样以 CC BY-SA 4.0 提供。

## tubelex-ja（词频排序）

- 来源：adno/tubelex
- 网址：https://github.com/adno/tubelex
- 许可：BSD 3-Clause License
- 用途：**词频排序**。这是约 9.9 万个 YouTube 视频字幕构成的语料，属口语域。
  选它而不是新闻语料，是因为本项目的目标是听懂动漫与日常对话，
  两者词汇分布差异很大（新闻里「委員会」高频，日常对话里几乎不出现）。
  取 `videos` 列（文档频率）而非 `count`（总次数）：一个词出现在多少个视频里，
  比它在某一个视频里被重复多少次更能反映通用性。

## Tatoeba（例句）

- 来源：Tatoeba Project
- 网址：https://tatoeba.org
- 许可：Creative Commons Attribution 2.0 France (CC BY 2.0 FR)
- 用途：真实中日对照例句（`jpn-cmn` 句对）

## Japanese-Chinese-thesaurus（中文释义）

- 来源：lxl66566/Japanese-Chinese-thesaurus
- 网址：https://github.com/lxl66566/Japanese-Chinese-thesaurus
- 许可：The Unlicense（公有领域）
- 用途：中文释义与声调。JMdict 官方义项只有英/荷/法/德/匈/俄/斯/西/瑞语，
  没有中文，这是必须补的一环。

---

## 未采用的数据源及原因

**x4ku/animefreq** — 直接来自 18,960 个动漫字幕文件、用 SudachiPy 做过形态分析，
是最贴合本项目目标的词频源。但该仓库**没有 LICENSE 文件**，
在没有明确授权的情况下不适合用于公开项目，故改用 BSD-3 授权的 tubelex。

**chriskempson/japanese-subtitles-word-kanji-frequency-lists** — 日剧/动漫/电影字幕词频，
仓库已删除，无法获取。

---

## 本项目原创部分

以下内容为本项目自行编写，不来自任何数据集，采用与本仓库相同的许可：

- `tools/kana_hooks.mjs` — 假名字源钩子（平假名←汉字草书、片假名←楷书部件）
  与**汉语声母对应**说明，以及 7 条音读规律。为中文母语者定制，
  现有日语数据集里没有这一层。
- `tools/vocab_hooks.mjs` — 187 条词汇记忆钩子（词族、同源、真实词源）。
  只在有**真实**线索时才给钩子；硬凑谐音会增加记忆负担，所以没有线索的
  明确写「无汉语线索」，让人别浪费时间。
- `data/theory.json` — 45 张声乐/乐理/记忆原理科普卡。
- `data/plan.json` — 12 周学习计划与过关判据。
- `js/fsrs.js` — FSRS-5 调度器实现。
- `js/pitch.js` — MPM 音高检测实现。
- `js/ear-levels.js` — 练耳课程阶梯设计。
