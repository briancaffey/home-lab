#!/bin/bash
# Stage 1+2: text -> speech (Dia) -> ARKit blendshape curves (LAM_Audio2Expression).
# Runs inside pytorch/pytorch:2.1.2-cuda12.1; everything heavy is cached under /work/cache.
set -euo pipefail
W=/work; RUN_DIR=$W/runs/$RUN; CACHE=$W/cache
mkdir -p "$RUN_DIR" "$CACHE"
export HF_HOME=$CACHE/hf PIP_CACHE_DIR=$CACHE/pip PYTHONUNBUFFERED=1

echo "== [1/4] python deps"
pip install -q --root-user-action=ignore librosa==0.11.0 transformers==4.36.2 omegaconf==2.3.0 \
  addict==2.4.0 yapf==0.40.1 termcolor==3.0.1 numpy==1.26.3 scipy huggingface_hub requests

echo "== [2/4] code + weights (cached)"
REPO=$CACHE/LAM_Audio2Expression-$A2E_COMMIT
if [ ! -f "$REPO/inference.py" ]; then
  python - <<PY
import io, os, zipfile, requests
r = requests.get("https://github.com/aigc3d/LAM_Audio2Expression/archive/$A2E_COMMIT.zip", timeout=300); r.raise_for_status()
zipfile.ZipFile(io.BytesIO(r.content)).extractall("$CACHE")
PY
fi
cd "$REPO"
if [ ! -f pretrained_models/lam_audio2exp_streaming.tar ]; then
  python -c "from huggingface_hub import hf_hub_download as d; d('3DAIGC/LAM_audio2exp', 'LAM_audio2exp_streaming.tar', local_dir='.')"
  tar -xzf LAM_audio2exp_streaming.tar && rm -f LAM_audio2exp_streaming.tar
fi

echo "== [3/4] speech from Dia"
python /scripts/tts.py "$RUN_DIR/speech.wav"

echo "== [4/4] audio -> ARKit curves"
python inference.py --config-file configs/lam_audio2exp_config_streaming.py --options \
  save_path="$RUN_DIR/a2e" weight=pretrained_models/lam_audio2exp_streaming.tar \
  audio_input="$RUN_DIR/speech.wav" save_json_path="$RUN_DIR/curves.json" ex_vol=False
python - <<PY
import json
d = json.load(open("$RUN_DIR/curves.json"))
print("curves.json keys:", list(d.keys())[:6], "| frames:", len(d.get("frames", [])))
PY
chmod -R a+rX "$RUN_DIR"
echo "== done: $RUN_DIR"
