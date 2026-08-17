#!/usr/bin/env python3
"""预渲染日语语音，打包进 APK。

为什么这么做，而不是在 App 里内置语音模型：
  实测这台设备（小米 15 Ultra / HyperOS）的系统 TTS 只有小米引擎且**不支持日语**，
  所以日语朗读必须自带。但内置 Kokoro 模型要 147MB、sherpa-onnx 的 .so 还要 23MB，
  APK 会涨到 200MB+。
  而旅游/学习场景里需要朗读的日语文本其实是**有限且已知**的：
  127 条短语 + 2000 词表。在电脑上用大模型离线渲染好，只把音频打进 APK，
  几 MB 就够，而且音质比端上小模型更好、启动零延迟、零 CPU 占用。
  模型留在 .data-src/（不入库），只有渲染产物入库。

覆盖不到的任意文本（用户自己输入的句子）走假名音节拼接兜底：
  日语是拍（mora）为单位的语言，104 个假名音节能拼出任何假名文本。
  拼接音质机械但完全可辨，这也是早期日语 TTS 的做法。

用法：
  python3 tools/render_speech.py --what phrases   # 127 条短语
  python3 tools/render_speech.py --what mora      # 104 个假名音节
  python3 tools/render_speech.py --what all
"""
import argparse
import json
import os
import subprocess
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, 'audio')

# 引擎选择：Open JTalk（pyopenjtalk）。
#
# 先试过 sherpa-onnx + Kokoro multi-lang v1.1，不行 —— 那个构建只带
# en/zh 词典（lexicon-gb-en / lexicon-us-en / lexicon-zh，没有日语），
# 日语文本被错误音素化：一句「これはいくらですか」念了 6.83 秒，
# 而且刷 "Skip unknown phonemes"。
# Open JTalk 是日语 TTS 的标准工具链，自带形态分析词典，同一句 1.65 秒，
# 假名读音 コレワイクラデスカ 完全正确（助词 は→ワ 也处理对了）。
# 音色机械但发音准确、完全可辨，对短语手册足够；而且它只在电脑上跑，
# 端上只放渲染好的音频。
SPEED = 1.0


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def make_tts():
    import pyopenjtalk
    log('使用 Open JTalk（pyopenjtalk）')

    class T:
        @staticmethod
        def generate(text, **kw):
            x, sr = pyopenjtalk.tts(text)
            # pyopenjtalk 返回 float64，量级约 ±32768，归一化到 ±1
            peak = max(1e-9, float(max(abs(x.max()), abs(x.min()))))
            class A:
                samples = (x / peak * 0.92).tolist()
                sample_rate = sr
            return A()

        @staticmethod
        def kana(text):
            return pyopenjtalk.g2p(text, kana=True)

    return T()


def to_opus(wav_path, out_path, bitrate='24k'):
    """转成 opus/webm。音频要打进 APK，体积敏感；语音在 24kbps opus 下听感几乎无损。"""
    for cmd in (
        ['ffmpeg', '-y', '-loglevel', 'error', '-i', wav_path,
         '-c:a', 'libopus', '-b:a', bitrate, '-ac', '1', '-application', 'voip', out_path],
        ['opusenc', '--quiet', '--bitrate', bitrate.rstrip('k'), wav_path, out_path],
    ):
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            return True
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
    return False


def write_wav(path, samples, rate):
    import struct
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = b''.join(struct.pack('<h', int(max(-1.0, min(1.0, s)) * 32767)) for s in samples)
        w.writeframes(frames)


def render_items(tts, items, subdir, trim_db=-40):
    """items: [(key, text)]，输出 audio/<subdir>/<key>.(opus|wav)"""
    out = os.path.join(OUT_DIR, subdir)
    os.makedirs(out, exist_ok=True)
    manifest, total = {}, 0
    use_opus = None
    for i, (key, text) in enumerate(items):
        audio = tts.generate(text)
        samples = list(audio.samples)
        # 掐掉首尾静音，127 条累积起来能省不少体积，播放也更利索
        thr = 10 ** (trim_db / 20)
        lo, hi = 0, len(samples)
        while lo < hi and abs(samples[lo]) < thr:
            lo += 1
        while hi > lo and abs(samples[hi - 1]) < thr:
            hi -= 1
        samples = samples[max(0, lo - 240):hi + 240] or samples
        wav = os.path.join(out, key + '.wav')
        write_wav(wav, samples, audio.sample_rate)
        if use_opus is None:
            use_opus = to_opus(wav, os.path.join(out, key + '.opus'))
            if not use_opus:
                log('!! 没有 ffmpeg/opusenc，退回 wav（体积会大很多）')
        elif use_opus:
            to_opus(wav, os.path.join(out, key + '.opus'))
        ext = '.opus' if use_opus else '.wav'
        if use_opus:
            os.remove(wav)
        size = os.path.getsize(os.path.join(out, key + ext))
        manifest[key] = {'f': key + ext, 'ms': int(len(samples) / audio.sample_rate * 1000)}
        total += size
        if (i + 1) % 20 == 0 or i + 1 == len(items):
            log(f'  {i+1}/{len(items)}  累计 {total/1e6:.2f} MB')
    return manifest, total, ('.opus' if use_opus else '.wav')


def phrase_items():
    d = json.load(open(os.path.join(ROOT, 'data', 'phrases.json'), encoding='utf-8'))
    return [(f'p{i:03d}', p['jp']) for i, p in enumerate(d['phrases'])], d


def mora_items():
    """104 个假名音节。用于拼接朗读任意假名文本（兜底路径）。"""
    d = json.load(open(os.path.join(ROOT, 'data', 'kana.json'), encoding='utf-8'))
    seen, items = set(), []
    for c in d['cards']:
        h = c['hira']
        if h in seen:
            continue
        seen.add(h)
        items.append((f'm_{c["id"]}', h))
    return items, d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--what', choices=['phrases', 'mora', 'all'], default='all')
    args = ap.parse_args()

    tts = make_tts()
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = {'version': 1, 'engine': 'open-jtalk'}

    if args.what in ('phrases', 'all'):
        items, pd = phrase_items()
        log(f'渲染 {len(items)} 条短语…')
        m, total, ext = render_items(tts, items, 'phrases')
        # 用短语的 jp 文本做键，App 侧按文本查
        manifest['phrases'] = {pd['phrases'][i]['jp']: v for i, (k, v) in enumerate(m.items())}
        manifest['phraseDir'] = 'phrases'
        log(f'短语音频 {total/1e6:.2f} MB ({ext})')

    if args.what in ('mora', 'all'):
        items, _ = mora_items()
        log(f'渲染 {len(items)} 个假名音节…')
        m, total, ext = render_items(tts, items, 'mora')
        kd = json.load(open(os.path.join(ROOT, 'data', 'kana.json'), encoding='utf-8'))
        by_id = {c['id']: c for c in kd['cards']}
        manifest['mora'] = {by_id[k[2:]]['hira']: v for k, v in m.items() if k[2:] in by_id}
        manifest['moraDir'] = 'mora'
        log(f'音节音频 {total/1e6:.2f} MB ({ext})')

    path = os.path.join(OUT_DIR, 'manifest.json')
    old = {}
    if os.path.exists(path):
        old = json.load(open(path, encoding='utf-8'))
    old.update(manifest)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(old, f, ensure_ascii=False, separators=(',', ':'))

    tot = sum(os.path.getsize(os.path.join(dp, fn))
              for dp, _, fns in os.walk(OUT_DIR) for fn in fns)
    log(f'\n-> {OUT_DIR}  合计 {tot/1e6:.2f} MB')


if __name__ == '__main__':
    main()
