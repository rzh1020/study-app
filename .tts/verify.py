#!/usr/bin/env python3
"""验证 Kokoro-82M 能不能把日语假名念成自然语音。

为什么要换掉现在的方案：原来的日语朗读是「127 句预渲染 + 104 个音节单独录制后
拼接」。翻译出来的句子几乎不可能命中那 127 句，于是每次都走音节拼接 ——
一个假名一个假名拼出来，必然机械难听。

Kokoro-82M 是端到端的神经 TTS（int8 量化 92MB，5 个日语音色各 0.52MB）。
它吃 IPA 音素，不吃假名，所以需要 G2P。做法：
  汉字 → 假名     用工程里已有的 jaspeech.toKana（词典 + 活用还原，已实测）
  假名 → 音素     用 misaki（Kokoro 官方前端）的 M2P 表，193 条 mora 映射
音调（pitch accent）在 misaki 现版本里是注释掉的 —— 官方日语音素串就是
M2P 直接拼接，所以我们不需要 pyopenjtalk 那套重型依赖。

本脚本只验证「假名 → 音素 → 波形」这一段，汉字转换在 JS 侧已有。
"""
import json
import pathlib
import struct
import sys
import wave

import numpy as np
import onnxruntime as ort

HERE = pathlib.Path(__file__).parent
KO = HERE / "kokoro"

# misaki 的 M2P 用了几个 IPA 扩展字符表示拗音，Kokoro 的 vocab 里没有，
# 但有 ʲ（palatalization），所以按 misaki 自己的 P2R 对应关系换写。
FIX = {'G': 'ɡw', 'K': 'kw', 'ƫ': 'tʲ', 'ᶀ': 'bʲ', 'ᶁ': 'dʲ', 'ᶃ': 'ɡʲ',
       'ᶄ': 'kʲ', 'ᶆ': 'mʲ', 'ᶈ': 'pʲ', 'ᶉ': 'rʲ'}
PUNCT = {'、': ',', '。': '.', '！': '!', '？': '?', '「': '“', '」': '”',
         '：': ':', '；': ';', '（': '(', '）': ')'}

HIRA_TO_KATA = {chr(c): chr(c + 0x60) for c in range(0x3041, 0x3097)}


def load():
    m2p = json.loads((HERE / "m2p.json").read_text(encoding="utf-8"))
    m2p = {k: ''.join(FIX.get(c, c) for c in v) for k, v in m2p.items()}
    tk = json.loads((KO / "tokenizer.json").read_text(encoding="utf-8"))
    vocab = tk.get("model", {}).get("vocab") or tk.get("vocab")
    return m2p, vocab


def to_phonemes(kana, m2p, dict_readings=None):
    """假名 → 音素。先转片假名（M2P 的键是片假名），再按最长匹配切 mora。

    助词读音：は→wa、へ→e、を→o。を 只作助词所以无条件；は/へ 要判断，
    规则是「句首或标点之后读本音，否则按助词读」，并且如果「は + 后续假名」
    能构成词典里某个词的读音就仍读本音（避免把 あさはやく 里的 は 念成 wa）。
    这不是形态分析，但输入主要来自神经翻译的输出（含汉字、助词场景占绝大多数），
    实测足够；真正的音调分析要 pyopenjtalk，那是 C++ 依赖，进不了 WebView。
    """
    s = ''.join(HIRA_TO_KATA.get(c, PUNCT.get(c, c)) for c in kana)
    out, i = [], 0
    unknown = []
    while i < len(s):
        one = s[i]
        # 助词判定
        if one in ('ハ', 'ヘ'):
            at_start = i == 0 or s[i - 1] in '“”,.!?:;() '
            word_internal = False
            if dict_readings and not at_start:
                for L in (4, 3, 2):
                    if s[i:i + L] in dict_readings:
                        word_internal = True
                        break
            if not at_start and not word_internal:
                out.append('wa' if one == 'ハ' else 'e')
                i += 1
                continue
        two = s[i:i + 2]
        if len(two) == 2 and two in m2p:
            out.append(m2p[two]); i += 2; continue
        if one in m2p:
            out.append(m2p[one]); i += 1; continue
        if one in '“”,.!?:;()' or one == ' ':
            out.append(one); i += 1; continue
        unknown.append(one); i += 1
    return ''.join(out), unknown


def dict_readings():
    """词典里所有词的读音（片假名），用来判断 は/へ 是否落在词内部。"""
    p = pathlib.Path(__file__).parent.parent / "data" / "k2k.json"
    if not p.exists():
        return set()
    d = json.loads(p.read_text(encoding="utf-8"))
    words = d.get("words") or d
    vals = words.values() if isinstance(words, dict) else []
    return {v if isinstance(v, str) else '' for v in vals}


def synth(text_kana, voice="jf_alpha", speed=1.0, out_wav=None, readings=None):
    m2p, vocab = load()
    phon, unknown = to_phonemes(text_kana, m2p, readings if readings is not None else dict_readings())
    ids = [0] + [vocab[c] for c in phon if c in vocab] + [0]
    missing = [c for c in phon if c not in vocab]

    style_all = np.fromfile(KO / f"{voice}.bin", dtype=np.float32).reshape(-1, 1, 256)
    # Kokoro 的 voice 文件按「音素长度」索引：第 n 行对应长度 n 的输入
    style = style_all[min(len(ids) - 2, style_all.shape[0] - 1)]

    sess = ort.InferenceSession(str(KO / "model_quantized.onnx"),
                               providers=["CPUExecutionProvider"])
    feed = {"input_ids": np.array([ids], dtype=np.int64),
            "style": style.astype(np.float32),
            "speed": np.array([speed], dtype=np.float32)}
    audio = sess.run(None, feed)[0].reshape(-1)

    info = {"kana": text_kana, "phonemes": phon, "tokens": len(ids),
            "unknown_kana": unknown, "missing_phonemes": missing,
            "samples": int(audio.size), "seconds": round(audio.size / 24000, 2),
            "peak": round(float(np.abs(audio).max()), 4),
            "rms": round(float(np.sqrt((audio ** 2).mean())), 4)}
    if out_wav:
        pcm = np.clip(audio, -1, 1)
        with wave.open(str(out_wav), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
            w.writeframes(b''.join(struct.pack('<h', int(v * 32767)) for v in pcm))
        info["wav"] = str(out_wav)
    return info


if __name__ == "__main__":
    cases = sys.argv[1:] or [
        "これはいくらですか",
        "えきへのいきかたをおしえてください。",
        "しゃしんをとってもらえますか",
        "ちけっとをきゃんせるしたいのですが、てすうりょうはかかりますか",
        "きょうはいいてんきですね",
    ]
    outdir = HERE / "wav"
    outdir.mkdir(exist_ok=True)
    for i, c in enumerate(cases):
        info = synth(c, out_wav=outdir / f"{i:02d}.wav")
        print(json.dumps(info, ensure_ascii=False))
