#!/usr/bin/env python3
"""生成 data/k2k.json：汉字词 -> 假名读音，用于把任意日语文本转成假名后朗读。

为什么需要：内置的预渲染语音只覆盖 127 条短语，而用户要读的是**任意文本**。
假名音节拼接能读任何假名串，但日语正文里大量是汉字，
所以缺的一环是「汉字 -> 假名」。

数据来源 JMdict（CC BY-SA 4.0），取每个汉字词条的第一个纯假名读音。
再用 KANJIDIC2 补单汉字兜底：词典查不到的生词至少能按单字读出来
（可能不是最合适的读音，但比读不出来强，界面上会标明这是推测读音）。

局限（必须如实告诉用户）：
  这是词典最长匹配，不是形态分析。所以
  - 动词活用形（食べました）查不到原形，会退化成逐字
  - 同形多音词（今日 きょう/こんにち、行った いった/おこなった）只能取一个
  - 没有上下文消歧，没有音高重音
真正准确要靠 MeCab/Open JTalk 那套形态分析词典（22MB）或端上神经 TTS。

用法：python3 tools/gen_k2k.py
"""
import gzip
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, '.data-src')

KANA_ONLY = re.compile(r'^[\u3040-\u309F\u30A0-\u30FFー]+$')
HAS_KANJI = re.compile(r'[\u4E00-\u9FFF\u3005]')
MAX_LEN = 12          # 超长词条（成语、书名）对朗读帮助小，砍掉控体积


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def load_xml(path):
    raw = gzip.open(path, 'rt', encoding='utf-8').read()
    # JMdict/KANJIDIC 用实体引用表示标签，先替换成纯文本再解析
    raw = re.sub(r'<!DOCTYPE.*?\]>', '', raw, flags=re.S)
    raw = re.sub(r'&([a-zA-Z0-9-]+);', r'\1', raw)
    return ET.fromstring(raw)


def build_words():
    log('读取 JMdict…')
    root = load_xml(os.path.join(SRC, 'JMdict_e.gz'))
    words = {}
    for e in root.findall('entry'):
        kebs = [k.findtext('keb') for k in e.findall('k_ele') if k.findtext('keb')]
        rebs = [r.findtext('reb') for r in e.findall('r_ele') if r.findtext('reb')]
        if not kebs or not rebs:
            continue
        reading = next((x for x in rebs if KANA_ONLY.match(x)), None)
        if not reading:
            continue
        for k in kebs:
            if len(k) <= MAX_LEN and HAS_KANJI.search(k) and k not in words:
                words[k] = reading
    log(f'  汉字词条 {len(words)}')
    return words


def build_single():
    """单汉字兜底读音。KANJIDIC2 里 ja_on 是音读、ja_kun 是训读。

    取舍：单字出现在词典查不到的生词里时，音读命中率更高
    （生词多是汉语借词的复合词），所以优先音读，没有音读才用训读。
    音读是片假名，转成平假名以便和音节表对上。
    """
    p = os.path.join(SRC, 'kanjidic2.xml.gz')
    if not os.path.exists(p):
        log('  (没有 kanjidic2，跳过单字兜底)')
        return {}
    log('读取 KANJIDIC2…')
    root = load_xml(p)
    out = {}
    for ch in root.findall('character'):
        lit = ch.findtext('literal')
        if not lit:
            continue
        on, kun = [], []
        for rm in ch.iter('reading'):
            t = rm.get('r_type')
            v = (rm.text or '').strip()
            if not v:
                continue
            if t == 'ja_on':
                on.append(v)
            elif t == 'ja_kun':
                kun.append(v.split('.')[0])   # 去掉 送り仮名 的点号部分
        pick = (on[0] if on else (kun[0] if kun else None))
        if not pick:
            continue
        # 片假名 -> 平假名
        hira = ''.join(chr(ord(c) - 0x60) if '\u30a1' <= c <= '\u30f6' else c for c in pick)
        if KANA_ONLY.match(hira):
            out[lit] = hira
    log(f'  单汉字 {len(out)}')
    return out


def build_priority():
    """用已消歧的 2021 词表覆盖 JMdict 的首条目。

    JMdict 里同一个汉字形可能挂多个条目（本 = ほん 书 / もと 根源），
    我按文件顺序取第一个，结果 本 取到了 もと —— 实测「本をくれた」读成「もとを」。
    而 data/vocab.json 里的读音是用中日词库消歧过的（见 build_vocab.py 的 entry_score），
    所以拿它做优先层，比 JMdict 的任意顺序可靠。
    """
    p = os.path.join(ROOT, 'data', 'vocab.json')
    if not os.path.exists(p):
        return {}
    voc = json.load(open(p, encoding='utf-8'))['vocab']
    out = {}
    for v in voc:
        if HAS_KANJI.search(v['jp']) and KANA_ONLY.match(v['kana']):
            out[v['jp']] = v['kana']
    log(f'优先层（已消歧词表）{len(out)} 条')
    return out


def main():
    words = build_words()
    prio = build_priority()
    words.update(prio)   # 优先层覆盖 JMdict
    single = build_single()
    # 单字表里凡是词表已有的就不重复放
    single = {k: v for k, v in single.items() if k not in words}
    maxlen = max((len(k) for k in words), default=1)
    out = {'version': 1, 'maxLen': maxlen, 'words': words, 'single': single,
           'source': 'JMdict (CC BY-SA 4.0) + KANJIDIC2 (CC BY-SA 4.0), EDRDG'}
    path = os.path.join(ROOT, 'data', 'k2k.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    size = os.path.getsize(path)
    gz = len(gzip.compress(open(path, 'rb').read(), 9))
    log(f'\n-> {path}')
    log(f'   原始 {size/1e6:.2f} MB，APK 内压缩后约 {gz/1e6:.2f} MB')
    log(f'   词条 {len(words)}，单字兜底 {len(single)}，最长词 {maxlen} 字')
    for t in ('日本語', '学校', '電車', '時間', '面白い', '一緒', '写真', '病院'):
        log(f'   {t} -> {words.get(t, "(缺)")}')


if __name__ == '__main__':
    main()
