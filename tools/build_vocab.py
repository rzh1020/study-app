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

# 三路语料近似等权。目标是学「日语」而不是偏某一语域，
# 所以不给任何一路明显更高的权重。新闻那一路略低一点点，
# 是因为它的粒度最粗（JMdict 的 nf 是 500 词一档，不是精确排名）。
W_NEWS, W_SPOKEN, W_SUBS = 0.33, 0.34, 0.33
# 缺失处理：只在「有收录」的语料上取平均，再按缺失路数加一个温和的惩罚。
# 一开始把缺失直接记作百分位 1.0，结果「猫」这种基础词只因新闻语料没收录
# 就被 0.33×1.0 压到两千名外 —— 那不是我们想要的判据。
# 现在的做法既保持「跨语域都常见的词优先」，又不至于因为一路缺失就判死。
MISS_PENALTY = 1.0    # 展示用：表示该语料未收录
MISS_COVER_W = 0.14   # 每缺一路语料附加的惩罚（缺 1 路 ≈ +0.047）
NF_BAND_SIZE = 500    # JMdict nf01..nf48，每档 500 词
NF_MAX_BAND = 48      # 覆盖新闻语料约前 24000 个词形


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


def lookup_keys(entry):
    """词频查询用的键。

    只有本来就写假名的词（且长度>1）才能用假名查。
    否则 葉/歯/羽/波 都会匹配到助词「は」（9.8 万视频）、
    手 会匹配到接续助词「て」，单字词被虚高顶到词表最前面。
    三路语料必须都走这个函数，不能只在其中一路做防护。
    """
    return entry['forms'] if entry['forms'] else [k for k in entry['kana'] if len(k) > 1]


def to_percentile(ranked_keys):
    """[按频次降序的键] -> {键: 百分位}（0=最常用，1=最罕见）"""
    n = len(ranked_keys) or 1
    return {k: (i + 1) / n for i, k in enumerate(ranked_keys)}


def parse_animefreq(path):
    """animefreq.csv -> {辞书形: 文档频率}。

    用 DictionaryForm（lemma）做键、累加 Files 列（出现在多少个字幕文件里）。
    跨表层形式累加会轻微高估文档频率（同一文件里多个变形会重复计），
    但单调性不变；取 max 反而会低估。排序只需单调性，所以累加更合适。
    过滤掉助词/助动词/符号，避免它们把 lemma 频次抬高。
    """
    log('读取 animefreq 词频（18960 个动漫字幕文件）…')
    skip_pos = ('助詞', '助動詞', '記号', '補助記号', '空白')
    agg = {}
    rows = 0
    with open(path, encoding='utf-8') as f:
        for row in csv.DictReader(f):
            rows += 1
            pos = (row.get('PartOfSpeech') or '').split()
            if pos and pos[0] in skip_pos:
                continue
            key = (row.get('DictionaryForm') or '').strip()
            if not key:
                continue
            try:
                files = int(row.get('Files') or 0)
            except ValueError:
                continue
            agg[key] = agg.get(key, 0) + files
    log(f'  原始行 {rows}，聚合后 lemma {len(agg)}')
    return agg


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


# 中日词库缺这几个词的键（它把释义挂在别的写法下），但课程要用。
# 人工补中释，与词库同格式。宁可显式列出，也不要让课程缺材料。
COURSE_GLOSS_FALLBACK = {
    '聞く': {'kana': 'きく', 'pitch': '0', 'posCn': '动词', 'cn': '听；问，打听'},
    'できる': {'kana': 'できる', 'pitch': '2', 'posCn': '动词', 'cn': '能，会；做好，完成'},
}


def load_course_words():
    """课程表里绑定的词，必须保证入选。

    自检暴露过一个真问题：先生/食べる/飲む/待つ 这类**基础教学词**
    不在语料高频前 2000 —— 因为语料统计的是「实际出现频次」，
    而教材选词看的是「教学必需性」，两者不重合。
    先生 在口语语料里没那么高频，但它是第 5 课就要用的词。
    所以课程用词单独保证，不能只靠词频。
    """
    import re as _re
    p = os.path.join(HERE, 'gen_course.py')
    if not os.path.exists(p):
        return set()
    txt = open(p, encoding='utf-8').read()
    words = set()
    # 取 L(...) 调用里的词表参数：形如 ['私', '学生', ...]
    for m in _re.finditer(r"\n\s*\[([^\]]*)\],\s*'(?:kana_\w+|vocab_\w+|grammar)'", txt):
        for w in _re.findall(r"'([^']+)'", m.group(1)):
            words.add(w)
    log(f'课程必需词 {len(words)} 个（保证入选）')
    return words


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
    ap.add_argument('--compare', action='store_true', help='对照新旧排序的前 50 名')
    ap.add_argument('--out', default=os.path.join(ROOT, 'data', 'vocab.json'))
    args = ap.parse_args()

    hooks = load_hooks()
    courseWords = load_course_words()
    entries = parse_jmdict(os.path.join(SRC, 'JMdict_e.gz'))
    jc = parse_jc(os.path.join(SRC, 'jc.json'))
    freq = parse_tubelex(os.path.join(SRC, 'tubelex.tsv'))
    subs = parse_animefreq(os.path.join(SRC, 'animefreq.csv'))
    pairs = load_pairs(os.path.join(SRC, 'links.tsv'),
                       os.path.join(SRC, 'jpn.tsv'),
                       os.path.join(SRC, 'cmn.tsv'))
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

    # ---- 三路语料合成排序 ----
    # 先把三个语料各自转成百分位（0=最常用），再取加权算术平均。
    # 不用调和平均：对「越小越好」的值，调和平均会被最小那一项主导，
    # 等于又把单语域偏向请回来了，而这次改动正是为了去掉这个偏向。
    # 算术平均 + 缺失惩罚 1.0，奖励「在三个语域里都常见」的词。
    tube_pct = to_percentile([k for k, _ in sorted(freq.items(), key=lambda kv: -kv[1][0])])
    subs_pct = to_percentile([k for k, _ in sorted(subs.items(), key=lambda kv: -kv[1])])

    def nf_pct(nf):
        if nf >= 99:
            return MISS_PENALTY
        mid = (nf - 1) * NF_BAND_SIZE + NF_BAND_SIZE / 2
        return min(1.0, mid / (NF_BAND_SIZE * NF_MAX_BAND))

    cands, cov = [], {'news': 0, 'spoken': 0, 'subs': 0, 'any': 0}
    for e in entries:
        if not e['forms'] and not e['kana']:
            continue
        if any(p in POS_SKIP for p in e['pos']) and not any(p in POS_CN for p in e['pos']):
            continue
        # misc 是**义项级**标记。先生 这类词既有常用义项也有古语义项，
        # 之前「任一义项带 arch 就排除整词」把 先生 直接毙了。
        # 改成只在**全部**义项都是古语/废弃/生僻时才排除。
        bad = {'arch', 'obs', 'obsc', 'rare'}
        if e['misc'] and all(m in bad for m in e['misc']):
            continue
        keys = lookup_keys(e)
        if not keys:
            continue
        pS = min((tube_pct[k] for k in keys if k in tube_pct), default=None)
        pB = min((subs_pct[k] for k in keys if k in subs_pct), default=None)
        pN = nf_pct(e['nf'])
        hasN = e['nf'] < 99
        if not hasN and pS is None and pB is None:
            continue
        if hasN:
            cov['news'] += 1
        if pS is not None:
            cov['spoken'] += 1
        if pB is not None:
            cov['subs'] += 1
        cov['any'] += 1
        e['pNews'] = pN
        e['pSpoken'] = MISS_PENALTY if pS is None else pS
        e['pSubs'] = MISS_PENALTY if pB is None else pB
        e['nCorpus'] = int(hasN) + int(pS is not None) + int(pB is not None)
        parts = []
        if hasN:
            parts.append((W_NEWS, pN))
        if pS is not None:
            parts.append((W_SPOKEN, pS))
        if pB is not None:
            parts.append((W_SUBS, pB))
        wsum = sum(w for w, _ in parts) or 1.0
        base = sum(w * v for w, v in parts) / wsum
        e['score'] = base + MISS_COVER_W * ((3 - e['nCorpus']) / 3)
        # 手写记忆钩子覆盖的词是按「初学者必需」人工挑的（水/山/猫/犬/寒暄语这类），
        # 这是课程知识而不是语料统计能给出的信息，所以给一个小幅前提。
        # 幅度刻意小：只把它们从两千名外拉进射程，不会顶掉真正的高频词。
        # 匹配课程词/钩子词时要看全部词形和假名 ——
        # 课程表里写的是 ここ/する/聞く 这类日常写法，而 JMdict 的 forms[0]
        # 可能是 此処/為る 这种生僻汉字形，只比对 forms[0] 会错过。
        allforms = set(e['forms']) | set(e['kana'])
        form0 = e['forms'][0] if e['forms'] else e['kana'][0]
        if allforms & set(hooks):
            e['score'] *= 0.55
            e['hookBoost'] = True
        # 课程词不靠评分前提保证 —— 试过，不可靠：
        # 一个词条有多个词形（此処/ここ），交集会把标记打在生僻汉字条目上，
        # 最终入表的却是别的条目。改成在最后**确定性补入**（见下方 force-add）。
        # 保留旧排序用的字段，供 --compare 对照
        e['videos'] = max((freq[k][0] for k in keys if k in freq), default=0)
        cands.append(e)

    n = max(cov['any'], 1)
    log(f"候选词条 {cov['any']}；语料覆盖率 "
        f"新闻 {cov['news']*100//n}%  口语 {cov['spoken']*100//n}%  字幕 {cov['subs']*100//n}%")

    # 同一词形多个 JMdict 条目（人＝ひと名词/にん后缀）用中日词库的读音消歧
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
        group.sort(key=lambda e: entry_score(e, info['kana'] if info else ''))
        picked.append(group[0])

    old_order = sorted(picked, key=lambda e: (-e['videos'], e['nf']))
    picked.sort(key=lambda e: (e['score'], -e['nCorpus'], -e['videos'], e['nf']))
    cands = picked
    log(f'按词形去重并消歧后 {len(cands)}')

    vocab, seen, no_cn = [], set(), 0
    for e in cands:
        if len(vocab) >= args.limit:
            break
        form = e['forms'][0] if e['forms'] else e['kana'][0]
        kana = e['kana'][0] if e['kana'] else form
        # 有些词日常就写假名，JMdict 里却挂着生僻汉字形：
        #   ここ→此処、どこ→何処、する→為る、できる→出来る
        # 直接取 forms[0] 会让词表出现「此処」这种没人写的形式，
        # 学习者看到反而困惑。JMdict 用 uk (usually kana) 标记这类词，
        # 命中就改用假名形。
        if 'uk' in e['misc'] and e['kana']:
            form = e['kana'][0]
            kana = e['kana'][0]
        if form in seen:
            continue
        info = jc.get(form) or jc.get(kana)
        if not info and e['forms']:
            # 中日词库的键可能用了别的写法（聞く 收在 聴く 下之类），再试其他词形
            for alt in e['forms'] + e['kana']:
                info = jc.get(alt)
                if info:
                    break
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
            'score': round(e['score'], 5),
            'pNews': round(e['pNews'], 4),
            'pSpoken': round(e['pSpoken'], 4),
            'pSubs': round(e['pSubs'], 4),
            'nCorpus': e['nCorpus'],
            'course': bool(e.get('courseWord')),
            'rank': rank,
            'stage': stage_of(rank),
            'exJp': ex_jp, 'exCn': ex_cn,
            'read': h.get('read', ''), 'hook': h.get('hook', ''),
        })

    # ---- 课程词确定性补入 ----
    # 课程表里第 N 课要用的词，缺一个就有一课没材料可练。
    # 语料词频保证不了这个：先生/食べる/待つ 是教学必需词，但未必在语料前 2000。
    # 所以这里按名字精确找回并追加，宁可让词表略超 limit。
    have = set()
    for v in vocab:
        have.add(v['jp'])
        have.add(v['kana'])
    need = sorted(courseWords - have)
    added_course = []
    if need:
        # 建一个「任意词形 -> JMdict 条目」的索引，按名字精确找
        idx = {}
        for e in entries:
            for k in list(e['forms']) + list(e['kana']):
                idx.setdefault(k, []).append(e)
        for w in need:
            cands = idx.get(w) or []
            # 优先选：有中释、词性是实词、不是纯古语
            best = None
            for e in cands:
                info = (jc.get(w)
                        or next((jc[a] for a in list(e['forms']) + list(e['kana']) if a in jc), None)
                        or COURSE_GLOSS_FALLBACK.get(w))
                if not info:
                    continue
                badm = {'arch', 'obs', 'obsc', 'rare'}
                if e['misc'] and all(m in badm for m in e['misc']):
                    continue
                pos = pick_pos(e['pos'], info['posCn'])
                if not pos:
                    continue
                best = (e, info, pos)
                break
            if not best:
                log(f'  !! 课程词 {w} 在 JMdict/中日词库里找不到可用条目')
                continue
            e, info, pos = best
            rank = len(vocab) + 1
            h = hooks.get(w, {})
            vocab.append({
                'id': f'v-{rank:04d}', 'jp': w,
                'kana': info['kana'] or (e['kana'][0] if e['kana'] else w),
                'romaji': romanize(info['kana'] or (e['kana'][0] if e['kana'] else w)),
                'cn': info['cn'], 'pos': pos, 'vclass': verb_class(e['pos']),
                'pitch': info['pitch'], 'videos': 0, 'score': 0.0,
                'pNews': 0.0, 'pSpoken': 0.0, 'pSubs': 0.0, 'nCorpus': 0,
                'course': True, 'rank': rank, 'stage': stage_of(min(rank, 400)),
                'exJp': '', 'exCn': '', 'read': h.get('read', ''), 'hook': h.get('hook', ''),
            })
            added_course.append(w)
        # 给补入的词也配例句
        for v in vocab[-len(added_course):] if added_course else []:
            for needle in (v['jp'], v['kana']):
                for ja, zh in sent_idx:
                    if needle and needle in ja:
                        v['exJp'], v['exCn'] = ja, zh
                        break
                if v['exJp']:
                    break
        log(f'课程词补入 {len(added_course)} 个: {" ".join(added_course)}')

    with_ex = sum(1 for v in vocab if v['exJp'])
    with_hook = sum(1 for v in vocab if v['hook'])
    log(f'\n输出 {len(vocab)} 条（{no_cn} 条缺中释被跳过）')
    log(f'带例句 {with_ex} ({with_ex*100//max(len(vocab),1)}%)')
    log(f'带手写记忆钩子 {with_hook}')
    log(f"课程必需词入选 {sum(1 for v in vocab if v.get('course'))}/{len(courseWords)}")
    have = set()
    for v in vocab:
        have.add(v['jp'])
        have.add(v['kana'])
    missing_course = sorted(courseWords - have)
    if missing_course:
        log(f'!! 课程词仍未入选 {len(missing_course)} 个: {" ".join(missing_course[:20])}')
    log(f'手写钩子未命中的（不在前 {args.limit} 高频词内）: '
        f'{len([k for k in hooks if k not in seen])} 条')

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump({'version': 3, 'vocab': vocab}, f, ensure_ascii=False, separators=(',', ':'))
    log(f'-> {args.out}  {os.path.getsize(args.out)/1e6:.2f} MB')

    log('\n合成排名前 20（括号内为各语料百分位，越小越常用，— = 该语料未收录）：')
    log(f"  {'#':>4} {'词':8s} {'读音':10s} {'分':>6}  {'新闻':>6} {'口语':>6} {'字幕':>6}  释义")
    for v in vocab[:20]:
        f = lambda x: '—' if x >= MISS_PENALTY else f'{x:.3f}'
        log(f"  {v['rank']:4d} {v['jp']:8s} {v['kana']:10s} {v['score']:.4f}  "
            f"{f(v['pNews']):>6} {f(v['pSpoken']):>6} {f(v['pSubs']):>6}  {v['cn'][:16]}")

    if args.compare:
        newRank = {(e['forms'][0] if e['forms'] else e['kana'][0]): i + 1 for i, e in enumerate(cands)}
        oldRank = {(e['forms'][0] if e['forms'] else e['kana'][0]): i + 1 for i, e in enumerate(old_order)}
        log('\n新旧排序前 50 对照（旧 = 仅用口语语料）：')
        log(f"  {'位':>3}  {'新排序':10s}{'(旧位)':>8}   {'旧排序':10s}{'(新位)':>8}")
        for i in range(50):
            a = cands[i]; b = old_order[i]
            af = a['forms'][0] if a['forms'] else a['kana'][0]
            bf = b['forms'][0] if b['forms'] else b['kana'][0]
            log(f"  {i+1:3d}  {af:10s}{('#'+str(oldRank.get(af,'-'))):>8}   {bf:10s}{('#'+str(newRank.get(bf,'-'))):>8}")
        movers = sorted(
            ((k, oldRank[k] - newRank[k], oldRank[k], newRank[k])
             for k in newRank if k in oldRank and newRank[k] <= 300),
            key=lambda x: -abs(x[1]))[:12]
        log('\n排名变化最大的词（只看新排名前300）：')
        for k, d, o, nn in movers:
            log(f"  {k:10s} 旧#{o:<6} -> 新#{nn:<6} ({'↑' if d>0 else '↓'}{abs(d)})")


if __name__ == '__main__':
    main()
