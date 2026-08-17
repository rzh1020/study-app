#!/usr/bin/env python3
"""从开放数据源构建日语词库。替代原来手写的 187 词。

为什么改用开放数据：词形、读音、词性、词频、例句都有成熟的免费权威数据，
手写是把最不该手工做的部分手工做了。手写应该只保留数据集里没有的东西 ——
为中文母语者定制的记忆钩子（音读规律、词族、字源），那才是原创价值，
所以钩子仍然以 overlay 的方式叠加在生成结果上。

数据源与许可（见仓库 NOTICE 文件）：
  JMdict            EDRDG, CC BY-SA 4.0
                    用途：词形、假名读音、词性、动词分类
  tubelex-ja        adno/tubelex, BSD-3-Clause
                    用途：**词频排序**。这是 9.9 万个 YouTube 视频字幕的语料，
                    属口语域，比新闻语料贴近「听懂动漫/日常对话」的目标。
                    用 videos 列（文档频率）而不是 count（总次数）：
                    一个词出现在多少个视频里，比它被某一个视频重复多少次更能
                    反映通用性。
  Tatoeba           CC BY 2.0 FR
                    用途：真实中日对照例句
  Japanese-Chinese-thesaurus  Unlicense（公有领域）
                    用途：中文释义 + 声调。JMdict 官方没有中文义项。

注意：另有 x4ku/animefreq（直接来自 18960 个动漫字幕，SudachiPy 分析，
更贴合目标），但该仓库**没有 LICENSE 文件**，不能用于要公开的项目，故未采用。

用法：python3 tools/build_vocab.py [--limit 2000]
"""
import argparse
import csv
import gzip
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, '.data-src')

POS_CN = {
    'n': '名词', 'n-adv': '名词', 'n-t': '名词', 'n-pref': '名词', 'n-suf': '名词',
    'pn': '代词', 'adj-i': '形容词', 'adj-ix': '形容词', 'adj-na': '形容动词',
    'adj-no': '形容词', 'adj-pn': '连体词', 'adj-t': '形容动词', 'adj-f': '形容词',
    'adv': '副词', 'adv-to': '副词', 'conj': '连词', 'int': '感叹词',
    'ctr': '量词', 'exp': '表达', 'pref': '前缀', 'suf': '后缀', 'num': '数词',
    'v1': '动词', 'v1-s': '动词', 'v5': '动词', 'v5aru': '动词', 'v5b': '动词',
    'v5g': '动词', 'v5k': '动词', 'v5k-s': '动词', 'v5m': '动词', 'v5n': '动词',
    'v5r': '动词', 'v5r-i': '动词', 'v5s': '动词', 'v5t': '动词', 'v5u': '动词',
    'v5u-s': '动词', 'vk': '动词', 'vs': '动词', 'vs-c': '动词', 'vs-i': '动词',
    'vs-s': '动词', 'vz': '动词',
}
# 助词/助动词不进词汇牌组：它们靠语法牌组的句型讲解才学得会，
# 做成「词→义」的卡片没有意义（「は」的意思无法用一个中文词概括）。
POS_SKIP = {'prt', 'aux', 'aux-v', 'aux-adj', 'cop', 'cop-da', 'unc'}

VERB_CLASS = [
    ('v5', '五段(一类)'), ('v1', '一段(二类)'),
    ('vk', '不规则 来る'), ('vs', '不规则 する'), ('vz', '不规则 ずる'),
]

KANA_RE = re.compile(r'^[\u3040-\u309F\u30A0-\u30FF\u30FCー]+$')
BARE_POS = ['形容动词', '形容词', '感叹词', '接续词', '连体词', '惯用语', '专有词',
            '助动词', '补助动词', '自动词', '他动词', '名词', '动词', '副词',
            '连词', '助词', '代词', '量词', '数词', '前缀', '后缀', '接头词',
            '接尾词', '词组', '短语', '语法',
            # 中日词库里还有单字词性标记（「名 方，方面」），也要剥掉。
            # 放在列表末尾，保证先匹配更长的「名词」再匹配「名」。
            '名', '动', '形', '副', '代', '助', '数', '量', '接', '连']
PITCH_CHARS = '⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫'


# tubelex.tsv 里有超长字段（某些词条的分类计数行很长），
# csv 模块默认单字段上限 128KB，会直接抛 _csv.Error。
csv.field_size_limit(1 << 24)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def build_romanizer(kana_json):
    """从 data/kana.json 建假名->罗马音映射并返回转写函数。

    转写规则和原来的 JS 版一致：促音加倍下一个辅音、片假名长音符重复元音、
    撥音在元音/y 前写 n'。从同一张假名表推导而不是手打，消掉整类录入错误。
    """
    with open(kana_json, encoding='utf-8') as f:
        data = json.load(f)
    m = {}
    for c in data['cards']:
        m[c['hira']] = c['romaji']
        m[c['kata']] = c['romaji']
    vowels = set('aiueo')

    def romanize(kana):
        out, i = [], 0
        while i < len(kana):
            ch = kana[i]
            if ch in ('っ', 'ッ'):
                nxt = m.get(kana[i + 1:i + 3]) or m.get(kana[i + 1:i + 2]) or ''
                if nxt and nxt[0] not in vowels:
                    out.append(nxt[0])
                i += 1
                continue
            if ch == 'ー':
                prev = out[-1] if out else ''
                lv = next((c for c in reversed(prev) if c in vowels), '')
                if lv:
                    out.append(lv)
                i += 1
                continue
            two = kana[i:i + 2]
            if len(two) == 2 and two in m:
                out.append(m[two])
                i += 2
                continue
            if ch in m:
                r = m[ch]
                if r == 'n':
                    nx = m.get(kana[i + 1:i + 3]) or m.get(kana[i + 1:i + 2]) or ''
                    if nx and (nx[0] in vowels or nx[0] == 'y'):
                        r = "n'"
                out.append(r)
                i += 1
                continue
            out.append(ch)
            i += 1
        return ''.join(out)

    return romanize


def parse_jmdict(path):
    log('读取 JMdict…')
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        raw = f.read()
    # 关掉实体解析：JMdict 用 &n; &v5k; 之类的实体表示词性，
    # ElementTree 遇到未声明实体会直接报错，所以先把实体引用替换成纯文本。
    raw = re.sub(r'<!DOCTYPE.*?\]>', '', raw, flags=re.S)
    raw = re.sub(r'&([a-zA-Z0-9-]+);', r'\1', raw)
    root = ET.fromstring(raw)
    out = []
    for ent in root.findall('entry'):
        forms = [k.findtext('keb') for k in ent.findall('k_ele')]
        forms = [f for f in forms if f]
        kana = [r.findtext('reb') for r in ent.findall('r_ele')]
        kana = [k for k in kana if k]
        pos, misc = [], []
        nf = 99
        for s in ent.findall('sense'):
            pos += [p.text for p in s.findall('pos') if p.text]
            misc += [m.text for m in s.findall('misc') if m.text]
        for tag in ent.iter():
            if tag.tag in ('ke_pri', 're_pri') and tag.text and re.fullmatch(r'nf\d+', tag.text):
                nf = min(nf, int(tag.text[2:]))
        out.append({'forms': forms, 'kana': kana, 'pos': pos, 'misc': misc, 'nf': nf})
    log(f'  词条 {len(out)}')
    return out


def parse_jc(path):
    log('读取中日词库…')
    with open(path, encoding='utf-8') as f:
        raw = json.load(f)
    out = {}
    for word, desc in raw.items():
        if not isinstance(desc, str):
            continue
        s = desc.strip().replace('（', '(').replace('）', ')').replace('【', '[').replace('】', ']')
        kana = pitch = pos = ''
        m = re.match(r'^\(([^)]*)\)\s*', s)
        if m:
            inner = m.group(1).strip()
            s = s[m.end():]
            mm = re.match(r'^([\u3040-\u30FFー]+)\s*(\d*)$', inner)
            if mm:
                kana, pitch = mm.group(1), mm.group(2)
            elif KANA_RE.match(inner):
                kana = inner
        while s and s[0] in PITCH_CHARS:
            pitch = str(PITCH_CHARS.index(s[0]))
            s = s[1:].strip()
        m = re.match(r'^\[([^\]]*)\]\s*', s)
        if m:
            pos = m.group(1).strip()
            s = s[m.end():]
        m = re.match(r'^(' + '|'.join(BARE_POS) + r')\s+', s)
        if m:
            pos = pos or m.group(1)
            s = s[m.end():]
        # 中日词库的释义里常夹着日语例句片段，对中文使用者是噪声：
        #   「好(咖啡)［コーヒーが～］」 -> 「好」
        # ［］ 里一定是日语示例；() 里若含假名/～ 也是示例，纯中文的括号保留。
        s = re.sub(r'［[^］]*］', '', s)
        s = re.sub(r'\[[^\]]*[\u3040-\u30FF～][^\]]*\]', '', s)
        s = re.sub(r'[(（][^)）]*[\u3040-\u30FF～][^)）]*[)）]', '', s)
        s = re.sub(r'\s{2,}', ' ', s)
        gloss = s.strip(' 　,，;；')
        if gloss:
            out[word] = {'kana': kana, 'pitch': pitch, 'posCn': pos, 'cn': gloss}
    log(f'  可用中释 {len(out)}')
    return out


def parse_tubelex(path):
    """word -> (videos, count)。videos = 出现在多少个视频里（文档频率）。"""
    log('读取 tubelex 词频（YouTube 字幕语料）…')
    freq = {}
    with open(path, encoding='utf-8') as f:
        rd = csv.DictReader(f, delimiter='\t')
        for row in rd:
            w = row['word']
            try:
                freq[w] = (int(row['videos']), int(row['count']))
            except (ValueError, KeyError):
                continue
    log(f'  词频条目 {len(freq)}')
    return freq


def load_pairs(links_path, jpn_path, cmn_path):
    log('读取 Tatoeba 中日例句…')

    def read_tsv(p):
        d = {}
        with open(p, encoding='utf-8') as f:
            for line in f:
                parts = line.rstrip('\n').split('\t')
                if len(parts) >= 3:
                    d[parts[0]] = parts[2]
        return d

    jpn, cmn = read_tsv(jpn_path), read_tsv(cmn_path)
    pairs = defaultdict(list)
    with open(links_path, encoding='utf-8') as f:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 2:
                continue
            ja, zh = jpn.get(parts[0]), cmn.get(parts[1])
            if ja and zh:
                pairs[ja].append(zh)
    out = {ja: min(zs, key=len) for ja, zs in pairs.items()}
    log(f'  可用对照 {len(out)}')
    return out


def load_hooks():
    """读取手写的记忆钩子（tools/vocab_hooks.mjs 里的 TSV 块）。"""
    p = os.path.join(HERE, 'vocab_hooks.mjs')
    if not os.path.exists(p):
        return {}
    txt = open(p, encoding='utf-8').read()
    m = re.search(r'`\n(.*?)\n`\.trim\(\);', txt, re.S)
    if not m:
        return {}
    out = {}
    for line in m.group(1).split('\n'):
        line = line.strip()
        if not line:
            continue
        parts = line.split('|')
        if len(parts) >= 3:
            out[parts[0].strip()] = {'read': parts[1].strip(), 'hook': '|'.join(parts[2:]).strip()}
    log(f'手写记忆钩子 {len(out)} 条')
    return out


# 实词优先：一个词条常同时标了名词和后缀（人＝名词/后缀），
# 学习者需要的是「名词」而不是「后缀」。
POS_PRIORITY = ['名词', '动词', '形容词', '形容动词', '副词', '代词', '数词',
                '量词', '连词', '感叹词', '连体词', '表达', '前缀', '后缀']


def pick_pos(pos_list, fallback=''):
    got = [POS_CN[p] for p in pos_list if p in POS_CN]
    for want in POS_PRIORITY:
        if want in got:
            return want
    return got[0] if got else fallback


def verb_class(pos_list):
    for p in pos_list:
        for pre, name in VERB_CLASS:
            if p.startswith(pre):
                return name
    return ''


def stage_of(rank):
    """按词频档位分阶段，让 12 周计划仍然能按 s1..s5 引入。"""
    if rank <= 150:
        return 's1'
    if rank <= 400:
        return 's2'
    if rank <= 800:
        return 's3'
    if rank <= 1300:
        return 's4'
    return 's5'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=2000)
    ap.add_argument('--out', default=os.path.join(ROOT, 'data', 'vocab.json'))
    args = ap.parse_args()

    entries = parse_jmdict(os.path.join(SRC, 'JMdict_e.gz'))
    jc = parse_jc(os.path.join(SRC, 'jc.json'))
    freq = parse_tubelex(os.path.join(SRC, 'tubelex.tsv'))
    pairs = load_pairs(os.path.join(SRC, 'links.tsv'),
                       os.path.join(SRC, 'jpn.tsv'),
                       os.path.join(SRC, 'cmn.tsv'))
    hooks = load_hooks()
    romanize = build_romanizer(os.path.join(ROOT, 'data', 'kana.json'))
    # 转写器自检：这几个是最容易出错的形态，错了就别往下走
    for k, want in [('がっこう', 'gakkou'), ('きって', 'kitte'), ('ちょっと', 'chotto'),
                    ('コーヒー', 'koohii'), ('きんいろ', "kin'iro"), ('いっしょに', 'isshoni')]:
        got = romanize(k)
        if got != want:
            raise SystemExit(f'罗马音转写器错误: {k} -> {got}（期望 {want}）')
    log('罗马音转写器自检通过')

    # 例句按长度升序：短句更适合初学，取第一条命中的即最短
    sent_idx = sorted(((ja, zh) for ja, zh in pairs.items() if len(ja) <= 32),
                      key=lambda x: len(x[0]))

    # 为每个 JMdict 词条打词频分。词形和假名都试一遍，取最高的文档频率。
    cands = []
    for e in entries:
        if not e['forms'] and not e['kana']:
            continue
        if any(p in POS_SKIP for p in e['pos']) and not any(p in POS_CN for p in e['pos']):
            continue
        if {'arch', 'obs', 'obsc', 'rare'} & set(e['misc']):
            continue
        # 词频只能按汉字词形查。
        # 如果拿假名去查，葉/歯/羽/波 都会匹配到助词「は」（9.8 万视频），
        # 手 会匹配到接续助词「て」—— 单字词会被虚高顶到词表最前面。
        # 只有本来就写假名的词（ありがとう、こんにちは）才用假名查，
        # 且排除单字假名（那一定是助词或活用词尾，不是独立词汇）。
        keys = e['forms'] if e['forms'] else [k for k in e['kana'] if len(k) > 1]
        best = 0
        for k in keys:
            v = freq.get(k)
            if v and v[0] > best:
                best = v[0]
        if best == 0:
            continue
        e['videos'] = best
        cands.append(e)
    cands.sort(key=lambda e: (-e['videos'], e['nf']))
    log(f'有词频的候选词条 {len(cands)}')

    # 同一个词形在 JMdict 里常有多个条目（人＝ひと名词 / にん后缀；
    # これ＝代词 / 感叹词）。词频查的是词形，所以这些条目分数相同，
    # 排序时的先后是任意的，会选错读音和词性。
    # 用中日词库给出的读音来消歧：它标的是最常用的那个读音。
    by_form = {}
    for e in cands:
        form = e['forms'][0] if e['forms'] else e['kana'][0]
        by_form.setdefault(form, []).append(e)

    def entry_score(e, want_kana):
        kana_hit = 1 if (want_kana and want_kana in e['kana']) else 0
        pos_rank = len(POS_PRIORITY)
        for p in e['pos']:
            name = POS_CN.get(p)
            if name and name in POS_PRIORITY:
                pos_rank = min(pos_rank, POS_PRIORITY.index(name))
        return (-kana_hit, pos_rank, e['nf'])

    picked = []
    for form, group in by_form.items():
        info = jc.get(form)
        want = info['kana'] if info else ''
        group.sort(key=lambda e: entry_score(e, want))
        picked.append(group[0])
    picked.sort(key=lambda e: (-e['videos'], e['nf']))
    cands = picked
    log(f'按词形去重并消歧后 {len(cands)}')

    vocab, seen, no_cn = [], set(), 0
    for e in cands:
        if len(vocab) >= args.limit:
            break
        form = e['forms'][0] if e['forms'] else e['kana'][0]
        kana = e['kana'][0] if e['kana'] else form
        if form in seen:
            continue
        info = jc.get(form) or jc.get(kana)
        if not info:
            no_cn += 1
            continue
        if info['posCn'] == '专有词':
            continue
        seen.add(form)

        # 例句优先包含汉字词形；找不到再退回假名形
        # （很多日常句子里这个词是写成假名的）
        ex_jp = ex_cn = ''
        for needle in (form, info['kana'] or kana):
            if not needle:
                continue
            for ja, zh in sent_idx:
                if needle in ja:
                    ex_jp, ex_cn = ja, zh
                    break
            if ex_jp:
                break

        rank = len(vocab) + 1
        h = hooks.get(form, {})
        vocab.append({
            'id': f'v-{rank:04d}',
            'jp': form,
            'kana': info['kana'] or kana,
            'romaji': romanize(info['kana'] or kana),
            'cn': info['cn'],
            'pos': pick_pos(e['pos'], info['posCn']),
            'vclass': verb_class(e['pos']),
            'pitch': info['pitch'],
            'videos': e['videos'],
            'rank': rank,
            'stage': stage_of(rank),
            'exJp': ex_jp, 'exCn': ex_cn,
            'read': h.get('read', ''), 'hook': h.get('hook', ''),
        })

    with_ex = sum(1 for v in vocab if v['exJp'])
    with_hook = sum(1 for v in vocab if v['hook'])
    log(f'\n输出 {len(vocab)} 条（{no_cn} 条缺中释被跳过）')
    log(f'带例句 {with_ex} ({with_ex*100//max(len(vocab),1)}%)')
    log(f'带手写记忆钩子 {with_hook}')
    log(f'手写钩子未命中的（不在前 {args.limit} 高频词内）: '
        f'{len([k for k in hooks if k not in seen])} 条')

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump({'version': 3, 'vocab': vocab}, f, ensure_ascii=False, separators=(',', ':'))
    log(f'-> {args.out}  {os.path.getsize(args.out)/1e6:.2f} MB')

    log('\n前 12 名：')
    for v in vocab[:12]:
        log(f"  #{v['rank']:4d} {v['jp']:8s} {v['kana']:10s} vids={v['videos']:6d} {v['pos']:5s} {v['cn'][:18]}")


if __name__ == '__main__':
    main()
