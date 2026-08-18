#!/usr/bin/env bash
# 建导出 ONNX 用的 python 环境。只在生成模型时需要，App 运行不依赖它。
#
# 两个踩过的坑，别改回去：
#   1. 不要用 conda：本机 conda 配置里指向了清华的 anaconda/pkgs/free 频道，
#      该频道已下线（HTTP 404），conda create 直接失败。用 venv 干净。
#   2. torch 必须显式装 CPU 轮子。pip 从默认源解析 torch 会拉 CUDA 版
#      （797MB，还会连带 nvidia-cudnn 等几百 MB），导出模型根本用不到 GPU。
#      所以下面直接给 aliyun 的 +cpu wheel URL，并且用 --no-deps 装 optimum，
#      免得依赖解析又把 GPU 版 torch 拽回来。
set -e
cd "$(dirname "$0")/.."

python3 -m venv .nmt/venv
. .nmt/venv/bin/activate
export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

pip install -q -U pip
pip install -q "https://mirrors.aliyun.com/pytorch-wheels/cpu/torch-2.4.1%2Bcpu-cp39-cp39-linux_x86_64.whl"
pip install -q "numpy==1.26.4" "transformers==4.44.2" "onnx==1.16.2" "onnxruntime==1.19.2" \
    sentencepiece sacremoses protobuf coloredlogs
pip install -q --no-deps "optimum==1.22.0"

python -c "import torch,transformers,onnx,onnxruntime as o,numpy; \
print('OK torch',torch.__version__,'tf',transformers.__version__,'ort',o.__version__)"
