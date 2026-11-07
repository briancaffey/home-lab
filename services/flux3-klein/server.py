"""FLUX 3 Image Klein HTTP server — a thin FastAPI wrapper around Black Forest
Labs' reference package (`flux3`, github.com/black-forest-labs/flux-3-image-klein):
text-to-image, reference-image editing (up to 10 refs) and bounding-box layout,
with the model's prompt upsampler (a 9B Qwen3.5 VLM on vLLM) in front.

Endpoints
  GET  /health                 -> {"status": "ok", "model": ..., "quant": ..., "pup": ...}
  POST /v1/generate            -> native: JSON in, JSON out (b64 PNG + saved path + record)
  POST /v1/upsample            -> prompt (+ refs, + boxes) -> the DiT caption (PUP_MODE=local only)
  POST /v1/images/generations  -> OpenAI-shaped (prompt, size, n, response_format, + seed/steps/upsample/boxes)
  POST /v1/images/edits        -> OpenAI-shaped multipart (image / image[], prompt, ...)
  GET  /files/{name}           -> a PNG saved under OUT_DIR

One generation at a time (asyncio lock); the upsampler has its own lock so a
remote caller (the 4090 variant) can upsample while a local image renders.

Placement (env):
  DIT_QUANT  ""    – bf16 DiT from the repo root (11 GB)
             fp8   – rowwise FP8 from variants/fp8r (6.3 GB; Ada/Hopper/Blackwell)
             nvfp4 – NVFP4 from variants/nvfp4 (5.3 GB; Blackwell + FlashInfer)
  PUP_MODE   local  – upsampler in-process on vLLM, PUP_MEMORY share of the GPU
             remote – POST PUP_URL/v1/upsample (the spark pod); falls back to
                      the prompt as typed if it is unreachable
             off    – prompts go to the DiT as typed (BFL: only for prompts
                      that already are upsampler-style captions)
"""
import asyncio
import base64
import io
import json
import os
import re
import threading
import time
import uuid
from types import SimpleNamespace
from typing import Optional, Union

import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import BaseModel, Field

MODEL_ID = os.environ.get("MODEL_ID", "flux-3-image-klein")
WEIGHTS = os.environ.get("WEIGHTS_DIR", "/weights")
OUT_DIR = os.environ.get("OUT_DIR", "/out")
DIT_QUANT = os.environ.get("DIT_QUANT", "")
PUP_MODE = os.environ.get("PUP_MODE", "local")
PUP_URL = os.environ.get("PUP_URL", "").rstrip("/")
PUP_MEMORY = float(os.environ.get("PUP_MEMORY", "0.2"))
MAX_SIDE = int(os.environ.get("MAX_SIDE", "4096"))
# Output pixel budget. BFL's code decodes the whole latent in fp32 at once, so
# activations grow with the pixel count: native 4K (8.3 MP) wedged spark on
# 2026-10-18 — ~45 GB of Klein + the node's other tenants + tens of GB of
# decode overran the GB10's 121 GB of unified memory, which the OS shares.
MAX_PIXELS = int(os.environ.get("MAX_PIXELS", str(4400 * 1000)))
TE_OFFLOAD_PIXELS = int(os.environ.get("TE_OFFLOAD_PIXELS", "0"))  # 0: the text encoder never leaves the GPU
DEFAULT_STEPS = 16  # the distilled checkpoint is a 16-step flow map, sampled without CFG

app = FastAPI(title="flux3-klein", version="0.1")
models = None
gen_lock = asyncio.Lock()
pup_lock = threading.Lock()  # vLLM's LLM is not safe to call from two threads at once
os.makedirs(OUT_DIR, exist_ok=True)


def _log(msg):
    print(f"[flux3-klein] {msg}", flush=True)


class RemoteUpsampler:
    """Same call shape as flux3.pup.Upsampler, served by the spark pod. Any
    failure is raised as ValueError, which flux3.generate treats as "skip
    upsampling, use the prompt as typed" — a degraded image beats an error."""

    def __call__(self, prompt, images, boxes=None):
        import requests

        try:
            r = requests.post(f"{PUP_URL}/v1/upsample", timeout=180, json={
                "prompt": prompt, "boxes": boxes, "images": [_pil_to_b64(i) for i in images]})
            r.raise_for_status()
            return r.json()["caption"]
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"remote upsampler at {PUP_URL} failed: {e}") from e


def _locked(fn):
    def call(*args, **kwargs):
        with pup_lock:
            return fn(*args, **kwargs)
    return call


@app.on_event("startup")
def load():
    global models
    from flux3.pipeline import Pipeline

    t0 = time.time()
    root = os.path.join(WEIGHTS, "flux-3-image-klein")
    dit = os.path.join(root, "variants", {"fp8": "fp8r", "nvfp4": "nvfp4"}[DIT_QUANT]) if DIT_QUANT else root
    upsampler = None
    if PUP_MODE == "local":
        # first, like flux3.generate.Models: vLLM reserves its share up front
        from flux3.pup import Upsampler

        upsampler = _locked(Upsampler(os.path.join(WEIGHTS, "pup"), PUP_MEMORY))
        _log(f"upsampler loaded in {time.time() - t0:.0f}s (gpu share {PUP_MEMORY})")
    elif PUP_MODE == "remote":
        upsampler = RemoteUpsampler()
    pipeline = Pipeline({"distilled": dit}, os.path.join(root, "text_encoder"), os.path.join(root, "ae.safetensors"))
    models = SimpleNamespace(upsampler=upsampler, pipeline=pipeline, safety=None)
    _log(f"loaded in {time.time() - t0:.0f}s: dit={dit} pup={PUP_MODE} "
         f"gpu_alloc={torch.cuda.memory_allocated() / 2**30:.1f}GiB")
    # warm-up: proves the DiT/TE/AE path (and the local upsampler) before /health goes green
    t1 = time.time()
    _run(GenerateRequest(prompt="A red apple on a wooden table, soft window light.", width=512, height=512,
                         steps=4, seed=0, upsample=PUP_MODE == "local"), [])
    _log(f"warm-up done in {time.time() - t1:.0f}s; ready")


def _b64_to_pil(data: str) -> Image.Image:
    if data.startswith("data:"):
        data = data.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(data)))


def _pil_to_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _safe_name(name: Optional[str]) -> str:
    base = re.sub(r"[^A-Za-z0-9_.-]+", "-", name or "").strip("-") or uuid.uuid4().hex[:8]
    return base if base.endswith(".png") else base + ".png"


def _parse_boxes(boxes):
    """Boxes arrive as a list or a JSON string (multipart forms, inference.club's
    pass-through). Each is {"id"?, "desc", "bbox": [y_min, x_min, y_max, x_max]} in
    0-1, or an edit box {"id", "desc", "from", "src_bbox", "tgt_bbox"} — see BFL's README."""
    if boxes in (None, "", []):
        return None
    if isinstance(boxes, str):
        try:
            boxes = json.loads(boxes)
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"boxes must be a JSON list: {e}")
    if not isinstance(boxes, list) or not all(isinstance(b, dict) for b in boxes):
        raise HTTPException(400, "boxes must be a list of objects")
    return boxes


class GenerateRequest(BaseModel):
    prompt: str
    images: list[str] = []  # base64 PNG/JPEG reference images (edit / multi-reference)
    boxes: Optional[Union[list[dict], str]] = None
    width: Optional[int] = None
    height: Optional[int] = None
    steps: int = Field(default=DEFAULT_STEPS, ge=1, le=50)
    seed: Optional[int] = None
    upsample: bool = True
    name: Optional[str] = None  # filename under OUT_DIR
    return_b64: bool = True


def _run(req: GenerateRequest, refs):
    from flux3.generate import generate

    t0 = time.time()
    te = models.pipeline.text_encoder
    # Above TE_OFFLOAD_PIXELS the 9 GB encoder steps aside to system RAM once
    # the prompt is encoded, leaving the GPU to the DiT's activations (2K on a
    # 24 GB card), and comes back afterwards. Smaller images keep it resident.
    evict = TE_OFFLOAD_PIXELS and (req.width or 1024) * (req.height or 1024) > TE_OFFLOAD_PIXELS
    if evict:
        encode = te.encode

        def encode_then_evict(prompt):
            out = encode(prompt)
            te.model.to("cpu")
            torch.cuda.empty_cache()
            return out

        te.encode = encode_then_evict
    try:
        image, record = generate(models, "distilled", req.prompt, refs, _parse_boxes(req.boxes), req.width,
                                 req.height, req.steps, None, req.seed, pup=req.upsample)
    finally:
        if evict:
            te.encode = encode
            te.model.to(te.device)
    record["seconds"] = round(time.time() - t0, 1)
    record["te_offloaded"] = bool(evict)
    _log(f"{image.width}x{image.height} refs={len(refs)} boxes={bool(req.boxes)} upsampled={record['upsampled']} "
         f"in {record['seconds']}s peak_gpu={torch.cuda.max_memory_allocated() / 2**30:.1f}GiB")
    torch.cuda.reset_peak_memory_stats()
    return image, record


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_ID, "loaded": models is not None, "quant": DIT_QUANT or "bf16",
            "pup": PUP_MODE, "node": os.environ.get("NODE_NAME", "")}


async def _generate(req: GenerateRequest):
    if models is None:
        raise HTTPException(503, "pipeline not loaded yet")
    if req.seed is None:
        req.seed = int.from_bytes(os.urandom(4), "little") >> 1
    refs = [_b64_to_pil(i) for i in req.images]
    for side in (req.width, req.height):
        if side is not None and not 256 <= side <= MAX_SIDE:
            raise HTTPException(400, f"sides must be 256-{MAX_SIDE}")
    if (req.width or 1024) * (req.height or 1024) > MAX_PIXELS:
        raise HTTPException(400, f"at most {MAX_PIXELS / 1e6:.1f} MP per image here (e.g. 2048x2048)")
    async with gen_lock:
        try:
            img, record = await asyncio.to_thread(_run, req, refs)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except torch.OutOfMemoryError:
            torch.cuda.empty_cache()
            raise HTTPException(507, "out of GPU memory at this size; try a smaller one")
    name = _safe_name(req.name)
    img.save(os.path.join(OUT_DIR, name))
    with open(os.path.join(OUT_DIR, name[:-4] + ".json"), "w") as f:
        json.dump(record, f, indent=2, ensure_ascii=False)
    out = {"file": name, **record, "node": os.environ.get("NODE_NAME", ""), "quant": DIT_QUANT or "bf16"}
    if req.return_b64:
        out["b64_png"] = _pil_to_b64(img)
    return out


@app.post("/v1/generate")
async def generate_native(req: GenerateRequest):
    return await _generate(req)


class UpsampleRequest(BaseModel):
    prompt: str
    images: list[str] = []
    boxes: Optional[Union[list[dict], str]] = None


@app.post("/v1/upsample")
async def upsample(req: UpsampleRequest):
    if PUP_MODE != "local" or models is None:
        raise HTTPException(503, "no local upsampler here")
    refs = [_b64_to_pil(i) for i in req.images]
    t0 = time.time()
    caption = await asyncio.to_thread(models.upsampler, req.prompt, refs, _parse_boxes(req.boxes))
    _log(f"upsample (remote caller) refs={len(refs)} in {time.time() - t0:.1f}s")
    return {"caption": caption, "seconds": round(time.time() - t0, 1)}


@app.get("/files/{name}")
def get_file(name: str):
    path = os.path.join(OUT_DIR, _safe_name(name))
    if not os.path.isfile(path):
        raise HTTPException(404)
    return FileResponse(path, media_type="image/png")


# ---- OpenAI-shaped surface (what inference-club-agent routes type=image to) ----
# Beyond the OpenAI fields (prompt, n, size, response_format) the inference.club
# playground sends the knobs this model has: seed, steps, upsample (the prompt
# upsampler on/off) and boxes (layout). revised_prompt carries the upsampled
# caption — what the DiT actually rendered.


def _parse_size(size: Optional[str]):
    """'1024x1024' -> (1024, 1024); None/'auto' -> (None, None) — 1 MP for
    text-to-image, the first reference's size for edits. Sides snap to 16."""
    if not size or size == "auto":
        return None, None
    try:
        w, h = (int(x) for x in size.lower().split("x"))
    except ValueError:
        raise HTTPException(400, f"size must look like 1024x1024, got {size!r}")
    w, h = min(w, MAX_SIDE) // 16 * 16, min(h, MAX_SIDE) // 16 * 16
    if w < 256 or h < 256:
        raise HTTPException(400, "size sides must be at least 256")
    return w, h


def _openai_requests(prompt, images, *, n, size, seed, steps, upsample, boxes):
    w, h = _parse_size(size)
    return [GenerateRequest(
        prompt=prompt, images=images, width=w, height=h, boxes=boxes,
        seed=None if seed is None else seed + i, steps=steps or DEFAULT_STEPS,
        upsample=True if upsample is None else upsample,
    ) for i in range(max(1, min(int(n or 1), 4)))]


async def _openai_response(reqs):
    data = []
    for r in reqs:
        out = await _generate(r)
        data.append({"b64_json": out["b64_png"], "revised_prompt": out["prompt"], "seed": out["seed"],
                     "width": out["width"], "height": out["height"], "steps": out["steps"],
                     "upsampled": out["upsampled"]})
    return {"created": int(time.time()), "data": data}


class OpenAIImageRequest(BaseModel):
    prompt: str
    n: int = 1
    size: Optional[str] = None  # "1024x1024", any WxH up to MAX_SIDE, or "auto"
    response_format: str = "b64_json"
    quality: Optional[str] = None  # accepted, ignored
    background: Optional[str] = None  # accepted, ignored (no alpha output)
    seed: Optional[int] = None
    steps: Optional[int] = Field(default=None, ge=1, le=50)
    upsample: Optional[bool] = None
    boxes: Optional[Union[list[dict], str]] = None


def _bool(v: Optional[str]) -> Optional[bool]:
    return None if v in (None, "") else str(v).lower() in ("1", "true", "yes", "on")


@app.post("/v1/images/generations")
async def openai_generations(req: OpenAIImageRequest):
    return await _openai_response(_openai_requests(
        req.prompt, [], n=req.n, size=req.size, seed=req.seed, steps=req.steps,
        upsample=req.upsample, boxes=req.boxes))


@app.post("/v1/images/edits")
async def openai_edits(
    prompt: str = Form(...),
    # 1..10 reference images ("the first image", "the second image", … in the
    # prompt). OpenAI's single-source field is `image`; inference.club sends
    # several as `image[]`.
    image: list[UploadFile] = File(default=[]),
    image_list: list[UploadFile] = File(default=[], alias="image[]"),
    n: int = Form(1),
    size: Optional[str] = Form(None),
    seed: Optional[int] = Form(None),
    steps: Optional[int] = Form(None),
    upsample: Optional[str] = Form(None),
    boxes: Optional[str] = Form(None),
):
    refs = list(image) + list(image_list)
    if not refs:
        raise HTTPException(400, "at least one reference image is required (`image` or `image[]`)")
    if len(refs) > 10:
        raise HTTPException(400, "at most 10 reference images")
    imgs = [base64.b64encode(await f.read()).decode() for f in refs]
    return await _openai_response(_openai_requests(
        prompt, imgs, n=n, size=size, seed=seed, steps=steps, upsample=_bool(upsample), boxes=boxes))
