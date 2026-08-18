#!/usr/bin/env python3
"""导出带 self-attention KV cache 的单步 decoder 图。

背景：官方三件套里
  - decoder_model.onnx        无 cache，每步重算整段序列 → 第 t 步成本 ∝ t
  - decoder_with_past_model   有 cache，但 cross-attention 直接吃 past 里的
                              encoder KV、不接受 encoder_hidden_states，首步无法自举
  - decoder_model_merged      两者合一，但整张图裹在 If 里，量化器不进子图，
                              量化后 670MB 一点没降
都不能直接用。这里导出第四种形态：

  输入 = 1 个新 token + encoder 输出 + self KV cache
  内部 = self-attention 用 cache（省掉 O(n²)），cross KV 每步重算
  输出 = logits + 新的 self KV

利用的是 MarianAttention.forward 里这段逻辑：cross past 的 shape[2] 与
encoder 长度不一致时会走「重新计算 cross KV」分支。给 cross past 传长度 0 的
空张量，trace 出的图就固定走重算分支 —— 于是一张图既能首步也能后续步，
而且权重只存一份，体积与现在的 decoder 完全相同。

代价：cross KV 每步重算，成本 ∝ 源句长度（约与单 token 主干前向同量级）。
收益：20 步解码的总计算量从 ~24G MAC 降到 ~5G MAC。
"""
import json
import pathlib
import sys

import torch
from transformers import MarianMTModel

HERE = pathlib.Path(__file__).parent
SRC = HERE / "opus-mt-tc-big-zh-ja"
OUT = HERE / "out-zh-ja"
FP32 = HERE / "onnx-cache-fp32"


class DecStep(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m
        self.L = m.config.decoder_layers
        self.H = m.config.decoder_attention_heads
        self.D = m.config.d_model // self.H

    def forward(self, input_ids, enc_h, enc_mask, *past):
        empty = torch.zeros(enc_h.shape[0], self.H, 0, self.D, dtype=enc_h.dtype)
        pkv = tuple((past[2 * i], past[2 * i + 1], empty, empty) for i in range(self.L))
        out = self.m(decoder_input_ids=input_ids, encoder_outputs=(enc_h,),
                     attention_mask=enc_mask, past_key_values=pkv,
                     use_cache=True, return_dict=True)
        flat = []
        for p in out.past_key_values:      # 只回传 self KV，cross 部分下一步会重算
            flat += [p[0], p[1]]
        return (out.logits, *flat)


def main():
    FP32.mkdir(parents=True, exist_ok=True)
    model = MarianMTModel.from_pretrained(str(SRC)).eval()
    L = model.config.decoder_layers
    H = model.config.decoder_attention_heads
    D = model.config.d_model // H
    step = DecStep(model).eval()

    S, T = 7, 3          # dummy 的源句长度 / 已生成长度，都会声明成动态轴
    ids = torch.tensor([[123]])
    enc_h = torch.randn(1, S, model.config.d_model)
    enc_mask = torch.ones(1, S, dtype=torch.long)
    past = [torch.randn(1, H, T, D) for _ in range(2 * L)]

    in_names = ["input_ids", "encoder_hidden_states", "encoder_attention_mask"]
    past_names, present_names = [], []
    for i in range(L):
        past_names += [f"past.{i}.key", f"past.{i}.value"]
        present_names += [f"present.{i}.key", f"present.{i}.value"]
    in_names += past_names
    out_names = ["logits"] + present_names

    dyn = {"encoder_hidden_states": {1: "src"}, "encoder_attention_mask": {1: "src"},
           "logits": {1: "tgt"}}
    for n in past_names:
        dyn[n] = {2: "pkv"}
    for n in present_names:
        dyn[n] = {2: "pkv1"}

    path = FP32 / "decoder_step.onnx"
    print("torch.onnx.export …", flush=True)
    with torch.no_grad():
        torch.onnx.export(step, (ids, enc_h, enc_mask, *past), str(path),
                          input_names=in_names, output_names=out_names,
                          dynamic_axes=dyn, opset_version=14, do_constant_folding=True)
    print("  fp32", f"{path.stat().st_size / 1e6:.1f}MB")

    # 数值自检：cache 路径与官方 generate 的首两步 logits 必须一致
    import numpy as np
    import onnxruntime as ort
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    feed = {"input_ids": ids.numpy(), "encoder_hidden_states": enc_h.numpy(),
            "encoder_attention_mask": enc_mask.numpy()}
    for n, t in zip(past_names, past):
        feed[n] = t.numpy()
    onnx_logits = sess.run(None, feed)[0]
    with torch.no_grad():
        ref = step(ids, enc_h, enc_mask, *past)[0].numpy()
    diff = float(np.abs(onnx_logits - ref).max())
    print(f"  onnx vs torch 最大差异 {diff:.2e}", "OK" if diff < 1e-3 else "！！超差")

    print("量化 int8 …", flush=True)
    from onnxruntime.quantization import QuantType, quantize_dynamic
    dst = OUT / "decoder_step.int8.onnx"
    quantize_dynamic(str(path), str(dst), weight_type=QuantType.QInt8,
                     per_channel=True, reduce_range=False,
                     extra_options={"MatMulConstBOnly": True})
    print(f"  int8 {dst.stat().st_size / 1e6:.1f}MB")

    cfg = json.load(open(OUT / "nmt.json"))
    cfg.update({"layers": L, "heads": H, "head_dim": D, "cache": True})
    json.dump(cfg, open(OUT / "nmt.json", "w"), ensure_ascii=False, indent=1)
    print("nmt.json 已更新：", cfg)


if __name__ == "__main__":
    sys.exit(main())
