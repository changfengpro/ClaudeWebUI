#!/usr/bin/env bash
# 预下载 Open WebUI 的 RAG 嵌入模型(all-MiniLM-L6-v2)到本地 HF 缓存。
# 只取核心文件(safetensors+配置+tokenizer，约 90MB)，跳过 onnx/openvino/tf 变体。
# 默认走 hf-mirror 镜像加速(国内)，失败回退官方。装好后 run-openwebui.sh 用 HF_HUB_OFFLINE 秒起。
set -e
cd "$(dirname "$0")"
TRY_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}" .owui-venv/bin/python - <<'PY'
import os, sys, time
from huggingface_hub import snapshot_download
repo = "sentence-transformers/all-MiniLM-L6-v2"
allow  = ["*.json", "*.txt", "*.safetensors", "1_Pooling/*", "README.md"]
ignore = ["onnx/*", "openvino/*", "*.onnx", "tf_model.h5", "rust_model.ot", "*.bin"]
for ep in (os.environ.get("TRY_ENDPOINT"), "https://huggingface.co"):
    if not ep:
        continue
    os.environ["HF_ENDPOINT"] = ep
    try:
        t = time.time()
        p = snapshot_download(repo, allow_patterns=allow, ignore_patterns=ignore)
        print(f"OK via {ep} in {time.time()-t:.1f}s -> {p}")
        sys.exit(0)
    except Exception as e:
        print(f"FAIL via {ep}: {type(e).__name__}: {str(e)[:120]}")
sys.exit(1)
PY
echo "嵌入模型已就绪。"
