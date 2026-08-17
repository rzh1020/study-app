#!/usr/bin/env python3
"""生成 data/phrases.json（离线翻译的第 1 层：短语库）。

罗马音不手打，从 data/kana.json 的假名表推导后与人工填写的做交叉校验 ——
促音加倍、长音、撥音 n' 这几处最容易写错。
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 中文 | 日语（汉字假名混写的自然写法） | 假名读音 | 分类
TSV = """
你好|こんにちは|こんにちは|greet
早上好|おはようございます|おはよう/ございます|greet
晚上好|こんばんは|こんばんは|greet
晚安|おやすみなさい|おやすみなさい|greet
再见|さようなら|さようなら|greet
那我先走了|お先に失礼します|おさき/に/しつれい/します|greet
谢谢|ありがとうございます|ありがとう/ございます|greet
不好意思／打扰一下|すみません|すみません|greet
对不起|ごめんなさい|ごめんなさい|greet
没关系／不要紧|大丈夫です|だいじょうぶ/です|greet
初次见面，请多关照|はじめまして、よろしくお願いします|はじめまして、/よろしく/おねがい/します|greet
好久不见|お久しぶりです|おひさしぶり/です|greet
请多保重|気をつけてください|き/を/つけて/ください|greet
我从中国来|中国から来ました|ちゅうごく/から/きました|greet
是的|はい、そうです|はい、/そう/です|greet
不是|いいえ、違います|いいえ、/ちがいます|greet
请给我菜单|メニューをお願いします|メニュー/を/おねがい/します|dining
我要这个|これをください|これ/を/ください|dining
有中文菜单吗|中国語のメニューはありますか|ちゅうごくご/の/メニュー/は/あります/か|dining
推荐什么|おすすめは何ですか|おすすめ/は/なん/です/か|dining
两位|二人です|ふたり/です|dining
请不要放香菜|パクチーは抜いてください|パクチー/は/ぬいて/ください|dining
我不能吃生的|生ものは食べられません|なまもの/は/たべられません|dining
请不要做辣|辛くしないでください|からく/しないで/ください|dining
我有食物过敏|食べ物のアレルギーがあります|たべもの/の/アレルギー/が/あります|dining
结账|お会計をお願いします|おかいけい/を/おねがい/します|dining
可以用信用卡吗|カードは使えますか|カード/は/つかえます/か|dining
打包带走|持ち帰りでお願いします|もちかえり/で/おねがい/します|dining
在这里吃|ここで食べます|ここ/で/たべます|dining
再来一杯|もう一杯お願いします|もう/いっぱい/おねがい/します|dining
很好吃|とてもおいしいです|とても/おいしい/です|dining
请给我水|お水をください|おみず/を/ください|dining
这个多少钱|これはいくらですか|これ/は/いくら/です/か|shopping
太贵了|高すぎます|たかすぎます|shopping
能便宜点吗|少し安くなりますか|すこし/やすく/なります/か|shopping
可以试穿吗|試着してもいいですか|しちゃく/しても/いい/です/か|shopping
有大一号的吗|大きいサイズはありますか|おおきい/サイズ/は/あります/か|shopping
有别的颜色吗|別の色はありますか|べつ/の/いろ/は/あります/か|shopping
我只是看看|見ているだけです|みて/いる/だけ/です|shopping
我要这个，麻烦了|これをお願いします|これ/を/おねがい/します|shopping
可以免税吗|免税できますか|めんぜい/できます/か|shopping
请给我收据|レシートをください|レシート/を/ください|shopping
请分开装袋|袋を分けてください|ふくろ/を/わけて/ください|shopping
不用袋子|袋はいりません|ふくろ/は/いりません|shopping
这个可以退货吗|返品できますか|へんぴん/できます/か|shopping
收银台在哪里|レジはどこですか|レジ/は/どこ/です/か|shopping
请包装成礼物|プレゼント用に包んでください|プレゼント/よう/に/つつんで/ください|shopping
车站在哪里|駅はどこですか|えき/は/どこ/です/か|transport
洗手间在哪里|トイレはどこですか|トイレ/は/どこ/です/か|transport
请问怎么去这里|ここへはどう行きますか|ここ/へ/は/どう/いきます/か|transport
到东京站多少钱|東京駅までいくらですか|とうきょうえき/まで/いくら/です/か|transport
请到这个地址|この住所までお願いします|この/じゅうしょ/まで/おねがい/します|transport
下一班几点|次は何時ですか|つぎ/は/なんじ/です/か|transport
这是去机场的车吗|これは空港行きですか|これ/は/くうこうゆき/です/か|transport
我坐错车了|電車を乗り間違えました|でんしゃ/を/のりまちがえました|transport
在哪里换乘|どこで乗り換えますか|どこ/で/のりかえます/か|transport
请给我一张地铁票|地下鉄の切符を一枚ください|ちかてつ/の/きっぷ/を/いちまい/ください|transport
走过去要几分钟|歩いて何分かかりますか|あるいて/なんぷん/かかります/か|transport
出租车站在哪里|タクシー乗り場はどこですか|タクシーのりば/は/どこ/です/か|transport
请在这里停车|ここで止めてください|ここ/で/とめて/ください|transport
有电梯吗|エレベーターはありますか|エレベーター/は/あります/か|transport
这附近有便利店吗|この近くにコンビニはありますか|この/ちかく/に/コンビニ/は/あります/か|transport
我迷路了|道に迷いました|みち/に/まよいました|transport
我要办入住|チェックインをお願いします|チェックイン/を/おねがい/します|hotel
我预约了|予約しています|よやく/して/います|hotel
退房是几点|チェックアウトは何時ですか|チェックアウト/は/なんじ/です/か|hotel
可以寄存行李吗|荷物を預かってもらえますか|にもつ/を/あずかって/もらえます/か|hotel
有无线网吗|ワイファイはありますか|ワイファイ/は/あります/か|hotel
密码是什么|パスワードは何ですか|パスワード/は/なん/です/か|hotel
请给我房间钥匙|部屋の鍵をお願いします|へや/の/かぎ/を/おねがい/します|hotel
空调坏了|エアコンが壊れています|エアコン/が/こわれて/います|hotel
没有热水|お湯が出ません|おゆ/が/でません|hotel
请再给我一条毛巾|タオルをもう一枚ください|タオル/を/もう/いちまい/ください|hotel
可以多住一晚吗|もう一泊できますか|もう/いっぱく/できます/か|hotel
早餐几点开始|朝食は何時からですか|ちょうしょく/は/なんじ/から/です/か|hotel
请打扫房间|部屋の掃除をお願いします|へや/の/そうじ/を/おねがい/します|hotel
隔壁很吵|隣がうるさいです|となり/が/うるさい/です|hotel
可以换房间吗|部屋を変えられますか|へや/を/かえられます/か|hotel
附近有温泉吗|近くに温泉はありますか|ちかく/に/おんせん/は/あります/か|hotel
救命|助けて|たすけて|emergency
请叫救护车|救急車を呼んでください|きゅうきゅうしゃ/を/よんで/ください|emergency
请叫警察|警察を呼んでください|けいさつ/を/よんで/ください|emergency
我不舒服|気分が悪いです|きぶん/が/わるい/です|emergency
肚子疼|お腹が痛いです|おなか/が/いたい/です|emergency
头疼|頭が痛いです|あたま/が/いたい/です|emergency
我发烧了|熱があります|ねつ/が/あります|emergency
医院在哪里|病院はどこですか|びょういん/は/どこ/です/か|emergency
药店在哪里|薬局はどこですか|やっきょく/は/どこ/です/か|emergency
我的钱包丢了|財布をなくしました|さいふ/を/なくしました|emergency
护照丢了|パスポートをなくしました|パスポート/を/なくしました|emergency
请帮帮我|手伝ってください|てつだって/ください|emergency
有会说中文的人吗|中国語が話せる人はいますか|ちゅうごくご/が/はなせる/ひと/は/います/か|emergency
我听不懂日语|日本語がわかりません|にほんご/が/わかりません|emergency
请说慢一点|ゆっくり話してください|ゆっくり/はなして/ください|emergency
请再说一遍|もう一度お願いします|もう/いちど/おねがい/します|emergency
一个|一つ|ひとつ|numtime
两个|二つ|ふたつ|numtime
三个|三つ|みっつ|numtime
一百日元|百円|ひゃくえん|numtime
一千日元|千円|せんえん|numtime
一万日元|一万円|いちまんえん|numtime
现在几点|今何時ですか|いま/なんじ/です/か|numtime
三点半|三時半|さんじはん|numtime
今天|今日|きょう|numtime
明天|明日|あした|numtime
昨天|昨日|きのう|numtime
上午|午前|ごぜん|numtime
下午|午後|ごご|numtime
星期几|何曜日ですか|なんようび/です/か|numtime
十分钟后|十分後|じゅっぷんご|numtime
要多久|どのくらいかかりますか|どのくらい/かかります/か|numtime
你叫什么名字|お名前は何ですか|おなまえ/は/なん/です/か|smalltalk
我是学生|学生です|がくせい/です|smalltalk
我在学日语|日本語を勉強しています|にほんご/を/べんきょう/して/います|smalltalk
我第一次来日本|日本は初めてです|にほん/は/はじめて/です|smalltalk
天气真好|いい天気ですね|いい/てんき/です/ね|smalltalk
今天很热|今日は暑いですね|きょう/は/あつい/です/ね|smalltalk
好可爱|かわいいですね|かわいい/です/ね|smalltalk
太好了|よかったです|よかった/です|smalltalk
我喜欢日本料理|日本料理が好きです|にほんりょうり/が/すき/です|smalltalk
可以拍照吗|写真を撮ってもいいですか|しゃしん/を/とっても/いい/です/か|smalltalk
可以帮我拍张照吗|写真を撮ってもらえますか|しゃしん/を/とって/もらえます/か|smalltalk
要不要交换联系方式|連絡先を交換しませんか|れんらくさき/を/こうかん/しません/か|smalltalk
我很开心|楽しかったです|たのしかった/です|smalltalk
下次再见|また会いましょう|また/あいましょう|smalltalk
加油|頑張ってください|がんばって/ください|smalltalk
要一起去吗|一緒に行きませんか|いっしょに/いきません/か|smalltalk
"""

CATS = [
    ('greet', '问候寒暄'), ('dining', '点餐'), ('shopping', '购物'),
    ('transport', '交通问路'), ('hotel', '住宿'), ('emergency', '应急求助'),
    ('numtime', '数字时间'), ('smalltalk', '社交闲聊'),
]

VOWELS = set('aiueo')

# 片假名小字母组合。外来语用它们拼日语原本没有的音（チェ/ファ/ウィ…），
# 这些组合不在 104 假名表里，不补上会输出 chiェkkuauto 这种垃圾。
KATA_SMALL = {
    'チェ': 'che', 'チャ': 'cha', 'チュ': 'chu', 'チョ': 'cho',
    'シェ': 'she', 'ジェ': 'je', 'ティ': 'ti', 'ディ': 'di',
    'トゥ': 'tu', 'ドゥ': 'du', 'ツァ': 'tsa', 'ツェ': 'tse', 'ツォ': 'tso',
    'ファ': 'fa', 'フィ': 'fi', 'フェ': 'fe', 'フォ': 'fo', 'フュ': 'fyu',
    'ウィ': 'wi', 'ウェ': 'we', 'ウォ': 'wo',
    'ヴァ': 'va', 'ヴィ': 'vi', 'ヴ': 'vu', 'ヴェ': 've', 'ヴォ': 'vo',
    'クァ': 'kwa', 'グァ': 'gwa', 'イェ': 'ye',
}

# 词间边界标记。写在 TSV 的读音列里，用来
#   1. 给罗马音加空格（korehaikuradesuka 没法读）
#   2. 判定 は/へ/を 是助词还是词的一部分 —— 单独成一段的就是助词，
#      助词读 wa/e/o 而不是 ha/he/wo。这是机械转写唯一解决不了的地方，
#      靠人工标一次边界比逐条手写罗马音更省事且可校验。
BOUNDARY = '/'
PARTICLE_READING = {'は': 'wa', 'へ': 'e', 'を': 'o'}
# 整词读音例外：这两个词末尾的 は 历史上就是助词，读 wa 而不是 ha
WORD_FIX = {'こんにちは': 'konnichiwa', 'こんばんは': 'konbanwa'}


def build_romanizer():
    data = json.load(open(os.path.join(ROOT, 'data', 'kana.json'), encoding='utf-8'))
    m = {}
    for c in data['cards']:
        m[c['hira']] = c['romaji']
        m[c['kata']] = c['romaji']

    def rom_seg(kana):
        out, i = [], 0
        while i < len(kana):
            ch = kana[i]
            three = kana[i:i + 3]
            two2 = kana[i:i + 2]
            if three in KATA_SMALL:
                out.append(KATA_SMALL[three]); i += 3; continue
            if two2 in KATA_SMALL:
                out.append(KATA_SMALL[two2]); i += 2; continue
            if i == 0 and kana in WORD_FIX:
                return WORD_FIX[kana]
            if ch in ('っ', 'ッ'):
                nxt = m.get(kana[i + 1:i + 3]) or m.get(kana[i + 1:i + 2]) or ''
                if nxt and nxt[0] not in VOWELS:
                    out.append(nxt[0])
                i += 1
                continue
            if ch == 'ー':
                prev = out[-1] if out else ''
                lv = next((c for c in reversed(prev) if c in VOWELS), '')
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
                    if nx and (nx[0] in VOWELS or nx[0] == 'y'):
                        r = "n'"
                out.append(r)
                i += 1
                continue
            if ch in '、。！？「」・':
                out.append(' ')
                i += 1
                continue
            out.append(ch)
            i += 1
        return ''.join(out)

    def rom(kana):
        # 按人工标的边界切段：单独成段的 は/へ/を 是助词，走助词读音
        segs = [x for x in kana.split(BOUNDARY) if x != '']
        parts = [PARTICLE_READING.get(sg) or rom_seg(sg) for sg in segs]
        return re.sub(r'\s+', ' ', ' '.join(parts)).strip()

    return rom


def main():
    rom = build_romanizer()
    # 转写器自检
    for k, want in [('がっこう', 'gakkou'), ('きって', 'kitte'), ('ちょっと', 'chotto'),
                    ('せんえん', "sen'en"), ('いっしょに', 'isshoni'), ('じゅっぷんご', 'juppungo'),
                    ('チェックアウト', 'chekkuauto'), ('ワイファイ', 'waifai'),
                    ('これ/は/いくらですか', 'kore wa ikuradesuka'),
                    ('これ/を/ください', 'kore o kudasai'),
                    ('ここ/へ/いきます', 'koko e ikimasu'),
                    ('こんにちは', 'konnichiwa'), ('こんばんは', 'konbanwa')]:
        got = rom(k)
        if got != want:
            sys.exit(f'转写器错误: {k} -> {got}（期望 {want}）')
    print('罗马音转写器自检通过')

    cat_ids = {c[0] for c in CATS}
    phrases, errs, seen = [], [], set()
    for i, line in enumerate(l.strip() for l in TSV.strip().split('\n')):
        if not line:
            continue
        parts = line.split('|')
        if len(parts) != 4:
            errs.append(f'第{i+1}行字段数={len(parts)}: {line[:40]}')
            continue
        cn, jp, kana, cat = (x.strip() for x in parts)
        if cat not in cat_ids:
            errs.append(f'未知分类 {cat}: {cn}')
        if cn in seen:
            errs.append(f'中文重复: {cn}')
        seen.add(cn)
        # 读音必须只含假名与标点，否则说明漏了汉字没转成假名
        if not re.fullmatch(r'[\u3040-\u309F\u30A0-\u30FFー、。！？「」・/]+', kana):
            errs.append(f'读音含非假名字符: {cn} -> {kana}')
        phrases.append({'cn': cn, 'jp': jp, 'kana': kana.replace(BOUNDARY, ''),
                        'romaji': rom(kana), 'cat': cat})

    if errs:
        sys.exit('数据错误:\n' + '\n'.join(errs))

    out = {
        'version': 1,
        'categories': [{'id': i, 'cn': n} for i, n in CATS],
        'phrases': phrases,
    }
    path = os.path.join(ROOT, 'data', 'phrases.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

    from collections import Counter
    c = Counter(p['cat'] for p in phrases)
    print(f'短语 {len(phrases)} 条，{len(CATS)} 类')
    for i, n in CATS:
        print(f'  {n:6s} {c[i]}')
    print('抽样:')
    for p in phrases[:3] + phrases[-2:]:
        print(f"  {p['cn']:14s} {p['jp']:24s} {p['romaji']}")
    print(f'-> {path}  {os.path.getsize(path)/1024:.0f} KB')


if __name__ == '__main__':
    main()
