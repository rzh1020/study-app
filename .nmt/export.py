#!/usr/bin/env python3
"""opus-mt-tc-big-zh-ja → 能在 WebView 里跑的 int8 ONNX + 纯 JS 可用的分词数据。

为什么不走 transformers.js 的标准布局：
  1. transformers.js 要 decoder_model_merged.onnx，而那张图整体被包在一个 If 节点里，
     onnxruntime 的 quantize_dynamic 不递归进子图 —— 量化后体积一点没降（670MB）。
  2. Marian 没有 fast tokenizer（transformers 4.44 的 SLOW_TO_FAST_CONVERTERS 里没有
     marian 条目），生成不出 tokenizer.json。
所以改成：只用 decoder_with_past_model.onnx 一张图（无 If，可正常量化，权重只存一份），
首步喂长度 0 的空 KV cache —— 这与 merged 图的 else 分支等价。
分词侧把 sentencepiece 模型导成 {pieces, scores} JSON，JS 里跑 unigram viterbi。

产出：
  out-zh-ja/encoder.int8.onnx
  out-zh-ja/decoder.int8.onnx
  out-zh-ja/spm-src.json     源语言（中文）分词表
  out-zh-ja/vocab-tgt.json   目标语言（日语）id→piece
  out-zh-ja/nmt.json         解码所需的形状/特殊 token 配置
"""
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
SRC = HERE / "opus-mt-tc-big-zh-ja"
FP32 = HERE / "onnx-fp32"
OUT = HERE / "out-zh-ja"
CASES = ["这个多少钱", "请问车站怎么走", "我想要一份不要辣的", "可以用手机支付吗",
         "我明天早上八点要退房", "这附近有没有便宜又好吃的拉面店",
         "我对花生过敏，这个里面有花生吗", "不好意思，能帮我拍张照吗"]


def mb(p):
    return f"{p.stat().st_size / 1e6:.1f}MB"


def step_quantize():
    from onnxruntime.quantization import QuantType, quantize_dynamic

    OUT.mkdir(parents=True, exist_ok=True)
    # 为什么用 decoder_model.onnx（无 KV cache）而不是 decoder_with_past：
    # with_past 的 cross-attention 直接吃 past 里的 encoder KV，不接受
    # encoder_hidden_states，首步没法自举（喂空 KV 会在 Reshape 处崩）。
    # 官方的解法是 decoder_model_merged，但那张图整体裹在 If 里，量化器不进子图，
    # 量化后体积一点不降。所以这里退一步：不用 cache，每步把已生成的整段序列
    # 重新喂进去。句子只有二三十个 token，O(n²) 的代价换掉一张 156MB 的图。
    for src, dst in [("encoder_model.onnx", "encoder.int8.onnx"),
                     ("decoder_model.onnx", "decoder.int8.onnx")]:
        s, d = FP32 / src, OUT / dst
        if d.exists():
            print(f"{dst} 已存在 {mb(d)}，跳过")
            continue
        print(f"量化 {src} {mb(s)} …", flush=True)
        quantize_dynamic(str(s), str(d), weight_type=QuantType.QInt8,
                         per_channel=True, reduce_range=False,
                         extra_options={"MatMulConstBOnly": True})
        print(f"  → {mb(d)}", flush=True)


def step_spm():
    """导出 JS 侧需要的分词数据。

    重要坑：这个 HF 仓库的 vocab.json 只是目标端（日语）词表 —— 它与 target.spm
    逐条对齐（31999/32000 同 id），而与 source.spm 几乎完全不匹配（只有 7 条同 id）。
    结果是 MarianTokenizer 拿日语词表去切中文，整句变成 <unk>，模型输出垃圾。
    实测证明：源端直接用 source.spm 的 piece id 喂 encoder，翻译完全正确。
    所以这里源端只导 source.spm（id = spm 内部 id），目标端只导 target.spm，
    彻底不用 vocab.json。
    """
    import sentencepiece as spm

    OUT.mkdir(parents=True, exist_ok=True)
    sps = spm.SentencePieceProcessor(model_file=str(SRC / "source.spm"))
    pieces = [sps.id_to_piece(i) for i in range(sps.get_piece_size())]
    scores = [round(sps.get_score(i), 4) for i in range(sps.get_piece_size())]
    json.dump({"pieces": pieces, "scores": scores, "unk": sps.unk_id()},
              open(OUT / "spm-src.json", "w"), ensure_ascii=False, separators=(",", ":"))

    spt = spm.SentencePieceProcessor(model_file=str(SRC / "target.spm"))
    json.dump([spt.id_to_piece(i) for i in range(spt.get_piece_size())],
              open(OUT / "vocab-tgt.json", "w"), ensure_ascii=False, separators=(",", ":"))

    cfg = json.load(open(SRC / "config.json"))
    json.dump({"eos": cfg["eos_token_id"], "pad": cfg["pad_token_id"],
               "decoder_start": cfg["decoder_start_token_id"],
               "vocab_size": cfg["vocab_size"], "max_new_tokens": 96},
              open(OUT / "nmt.json", "w"), ensure_ascii=False, indent=1)
    for f in ("spm-src.json", "vocab-tgt.json", "nmt.json"):
        print(" ", f, mb(OUT / f))


def _onnx_translate(texts):
    """int8 图 + 无 cache 贪心解码。这段逻辑之后要 1:1 移植到 JS，所以只用最基础的
    张量操作，不依赖任何 python 便利设施。"""
    import time

    import numpy as np
    import onnxruntime as ort
    import sentencepiece as spm

    sps = spm.SentencePieceProcessor(model_file=str(SRC / "source.spm"))
    tgt = json.load(open(OUT / "vocab-tgt.json"))
    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    enc = ort.InferenceSession(str(OUT / "encoder.int8.onnx"), so, providers=["CPUExecutionProvider"])
    dec = ort.InferenceSession(str(OUT / "decoder.int8.onnx"), so, providers=["CPUExecutionProvider"])
    cfg = json.load(open(OUT / "nmt.json"))
    res, times = [], []
    for t in texts:
        t0 = time.time()
        ids = sps.encode(t) + [cfg["eos"]]
        arr = np.array([ids], np.int64)
        am = np.ones_like(arr)
        h = enc.run(None, {"input_ids": arr, "attention_mask": am})[0]
        seq = [cfg["decoder_start"]]
        for _ in range(cfg["max_new_tokens"]):
            logits = dec.run(None, {"encoder_attention_mask": am,
                                    "input_ids": np.array([seq], np.int64),
                                    "encoder_hidden_states": h})[0]
            nxt = int(logits[0, -1].argmax())
            if nxt == cfg["eos"]:
                break
            seq.append(nxt)
        # target piece 拼接：▁ 是词首标记，日语不写空格，直接去掉
        res.append("".join(tgt[i] for i in seq[1:] if i < len(tgt))
                   .replace("\u2581", " ").strip())
        times.append(time.time() - t0)
    return res, times


def step_verify():
    import sentencepiece as spm
    import torch
    from transformers import MarianMTModel

    # fp32 基线也必须用 source.spm 的 id 喂，否则 MarianTokenizer 会把中文切成 <unk>
    sps = spm.SentencePieceProcessor(model_file=str(SRC / "source.spm"))
    tgt = json.load(open(OUT / "vocab-tgt.json"))
    cfg = json.load(open(OUT / "nmt.json"))
    model = MarianMTModel.from_pretrained(str(SRC)).eval()
    ref = []
    for c in CASES:
        inp = torch.tensor([sps.encode(c) + [cfg["eos"]]])
        o = model.generate(input_ids=inp, attention_mask=torch.ones_like(inp),
                           num_beams=4, max_new_tokens=96)
        ids = [int(i) for i in o[0] if int(i) not in (cfg["pad"], cfg["eos"], cfg["decoder_start"])]
        ref.append("".join(tgt[i] for i in ids if i < len(tgt)).replace("\u2581", " ").strip())
    got, times = _onnx_translate(CASES)
    print("\n=== 质量对比 ===")
    same = 0
    for c, r, g, t in zip(CASES, ref, got, times):
        mark = "＝" if r == g else "≠"
        same += r == g
        print(f"  {c}\n    fp32 beam4: {r}\n    int8 greedy: {g}   {mark}  {t*1000:.0f}ms")
    print(f"\n  逐字相同 {same}/{len(CASES)}（不同不等于错，greedy 与 beam 本就会分叉）")
    print(f"  平均耗时 {sum(times)/len(times)*1000:.0f}ms/句（桌面 4 线程）")
    json.dump({"cases": CASES, "fp32_beam4": ref, "int8_greedy": got,
               "ms": [round(t*1000) for t in times]},
              open(HERE / "quality.json", "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    for s in (sys.argv[1:] or ["quantize", "spm", "verify"]):
        print(f"\n########## {s} ##########", flush=True)
        globals()[f"step_{s}"]()
    if OUT.exists():
        tot = sum(p.stat().st_size for p in OUT.glob("*") if p.is_file())
        print(f"\n进 APK 的总体积 {tot/1e6:.1f}MB")
        for p in sorted(OUT.glob("*")):
            print(f"   {p.name:26s} {mb(p)}")
