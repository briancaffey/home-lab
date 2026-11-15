# nano-edge-tts: Kokoro-82M text side + the 1.75M-parameter nano decoder, CPU only.
# Everything is baked in (weights, voices, G2P model) so the pod runs with no
# network and no volume. Multi-arch (amd64 + arm64); build from this directory:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t harbor.lan/apps/nano-edge-tts:<tag> --push .
FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 HF_HOME=/opt/hf \
    HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_DISABLE_XET=1

# CPU-only torch (the default amd64 wheel drags in ~2 GB of CUDA libraries).
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu \
      torch==2.15.0 kokoro==0.9.4 safetensors==0.8.0 soundfile==0.14.0 \
      fastapi==0.163.1 "uvicorn[standard]==0.54.0" python-multipart==0.0.33 psutil==7.2.2 \
 && pip install "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"

RUN pip install soxr==1.1.0

WORKDIR /app

# Pinned upstream revisions. The decoder file is checksummed; nano_edge_tts.py
# (199 lines, pure torch) was read before pinning.
ARG NANO_REV=37b4935e4d1a986b149c3a299dbe9306e55cb2e5
ARG NANO_SHA256=28b76f18284e31e170cafccd8ba5856d29ee50b0c13d545cf77adaa8ea313db2
ARG KOKORO_REV=f3ff3571791e39611d31c381e3a41a3af07b4987
RUN python - <<PY
import hashlib, os, shutil
from huggingface_hub import hf_hub_download, snapshot_download
for f in ("nano_edge_tts.py", "config.json", "nano-edge-tts.safetensors", "LICENSE"):
    shutil.copy(hf_hub_download("drmhse/nano-edge-tts", f, revision="${NANO_REV}"), "/app/" + f)
assert hashlib.sha256(open("/app/nano-edge-tts.safetensors", "rb").read()).hexdigest() == "${NANO_SHA256}"
# Kokoro: weights, config, and the voices for the languages the server exposes
# (en-US, en-GB + the espeak-backed es/fr/hi/it/pt that "run but are untested").
p = snapshot_download("hexgrad/Kokoro-82M", revision="${KOKORO_REV}",
                      allow_patterns=["config.json", "kokoro-v1_0.pth", "voices/[abefhip]*.pt"])
refs = os.path.join(os.path.dirname(os.path.dirname(p)), "refs")
os.makedirs(refs, exist_ok=True)
open(os.path.join(refs, "main"), "w").write("${KOKORO_REV}")  # offline lookups resolve "main"
PY
RUN rm -rf /opt/hf/hub/models--drmhse--nano-edge-tts && chmod -R a+rX /opt/hf /app

COPY server.py bench.py /app/

ENV HF_HUB_OFFLINE=1 PORT=8880
USER 65534
EXPOSE 8880
CMD ["python", "server.py"]
