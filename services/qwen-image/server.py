"""Qwen-Image-2.1 HTTP server — a thin FastAPI wrapper around diffusers'
QwenImage21Pipeline (text-to-image, reference-image editing, RGBA output).

Endpoints
  GET  /health                 -> {"status": "ok", "model": ..., "loaded": bool}
  POST /v1/generate            -> native: JSON in, JSON out (b64 PNG + saved path)
  POST /v1/images/generations  -> OpenAI-shaped (prompt, size, n, response_format)
  POST /v1/images/edits        -> OpenAI-shaped multipart (image[], prompt)
  GET  /files/{name}           -> a PNG saved under OUT_DIR

One generation at a time (asyncio lock). Where the 33 GB pipeline lives is
decided by OFFLOAD below: all resident on spark, swapped through a 4090 on a3.
"""
import asyncio
import base64
import io
import os
import re
import time
import uuid
from typing import Optional

import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import BaseModel, Field

MODEL_ID = os.environ.get("MODEL_ID", "Qwen/Qwen-Image-2.1")
OUT_DIR = os.environ.get("OUT_DIR", "/out")
# Placement modes (OFFLOAD env):
#   none   – everything resident in bf16 (~34 GB; spark's 128 GB unified memory)
#   model  – diffusers enable_model_cpu_offload: one component on the GPU at a
#            time (~18 GB peak) but every call re-reads 33 GB from CPU RAM, and
#            on a box without enough RAM to cache it that means the disk
#            (a3: ~5 min/image). Kept for reference.
#   te-nf4 – same offload hooks, but the text encoder is quantized to 4-bit NF4
#            (~5.5 GB) so the CPU copies (~21 GB) fit in a3's RAM and the swaps
#            run at PCIe speed: ~30 s per 1024² image next to Dia. The 4-bit
#            vision tower cannot follow reference images (edits come out grainy
#            and off-prompt) — text-to-image only. 2K and ≥2 refs need `none`.
OFFLOAD = os.environ.get("OFFLOAD", "none")
DEFAULT_STEPS = int(os.environ.get("DEFAULT_STEPS", "40"))

app = FastAPI(title="qwen-image", version="0.1")
pipe = None
lock = asyncio.Lock()
os.makedirs(OUT_DIR, exist_ok=True)


@app.on_event("startup")
def load():
    global pipe
    from diffusers import QwenImage21Pipeline

    t0 = time.time()
    if OFFLOAD == "te-nf4":
        from transformers import BitsAndBytesConfig, Qwen3VLForConditionalGeneration

        te = Qwen3VLForConditionalGeneration.from_pretrained(
            MODEL_ID, subfolder="text_encoder", dtype=torch.bfloat16, device_map={"": "cuda"},
            quantization_config=BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                bnb_4bit_compute_dtype=torch.bfloat16),
        )
        pipe = QwenImage21Pipeline.from_pretrained(MODEL_ID, text_encoder=te, dtype=torch.bfloat16)
        # accelerate hooks: each component is moved to the GPU for its forward and
        # back to RAM when the next one runs (TE 5.5 GB nf4 -> DiT 14.2 GB -> VAE).
        # After the first call the CPU copies are ordinary RAM, not the mmap'd
        # safetensors, so the swaps run at PCIe speed instead of disk speed.
        pipe.enable_model_cpu_offload()
    else:
        pipe = QwenImage21Pipeline.from_pretrained(MODEL_ID, dtype=torch.bfloat16)
        if OFFLOAD == "model":
            pipe.enable_model_cpu_offload()
        else:
            pipe.to("cuda")
    print(f"[qwen-image] pipeline loaded in {time.time() - t0:.0f}s (offload={OFFLOAD}) "
          f"exec_device={pipe._execution_device}", flush=True)
    # warm-up: pages every weight through the GPU once (the slow first call) and
    # proves the whole path works before /health goes green
    t1 = time.time()
    _run("warm-up", [], None, 1.0, 512, 512, 512, 2, 0)
    print(f"[qwen-image] warm-up done in {time.time() - t1:.0f}s; ready", flush=True)


def _b64_to_pil(data: str) -> Image.Image:
    if data.startswith("data:"):
        data = data.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(data)))


def _safe_name(name: Optional[str]) -> str:
    base = re.sub(r"[^A-Za-z0-9_.-]+", "-", name or "").strip("-") or uuid.uuid4().hex[:8]
    return base if base.endswith(".png") else base + ".png"


def _run(prompt, images, negative_prompt, true_cfg_scale, width, height, output_resolution, steps, seed):
    gen = torch.Generator("cuda").manual_seed(seed)
    t0 = time.time()
    marks = {"start": t0}

    def on_step(p, i, t, kw):
        if i == 0:
            marks["first_step"] = time.time()
            print(f"[qwen-image] step 0 done at +{marks['first_step'] - t0:.1f}s "
                  f"(prompt/ref encode + transformer to GPU) dev={p.transformer.device} "
                  f"gpu_alloc={torch.cuda.memory_allocated() / 2**30:.1f}GiB", flush=True)
        elif i in (steps // 2, steps - 1):
            print(f"[qwen-image] step {i} at +{time.time() - t0:.1f}s "
                  f"({(time.time() - marks['first_step']) / i:.2f}s/step)", flush=True)
        return {}

    kwargs = dict(
        prompt=prompt,
        num_inference_steps=steps,
        generator=gen,
        output_resolution=output_resolution,
        callback_on_step_end=on_step,
    )
    if images:
        kwargs["image"] = images
    if width and height:
        kwargs.update(width=width, height=height)
        kwargs["output_resolution"] = max(width, height, output_resolution)
    if negative_prompt and true_cfg_scale > 1:
        kwargs.update(negative_prompt=negative_prompt, true_cfg_scale=true_cfg_scale)
    try:
        out = pipe(**kwargs).images[0]
    except Exception:
        # an OOM mid-call leaves accelerate's offload hooks half-moved (DiT on the
        # GPU, encoder split across devices) and poisons every later call; put
        # everything back before re-raising
        try:
            pipe.maybe_free_model_hooks()
        except Exception as e:  # noqa: BLE001
            print(f"[qwen-image] hook reset failed: {e}", flush=True)
        torch.cuda.empty_cache()
        raise
    print(f"[qwen-image] done in {time.time() - t0:.1f}s peak_gpu={torch.cuda.max_memory_allocated() / 2**30:.1f}GiB",
          flush=True)
    torch.cuda.reset_peak_memory_stats()
    return out


class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = None
    true_cfg_scale: float = 1.0
    width: Optional[int] = None
    height: Optional[int] = None
    output_resolution: int = 1024
    steps: int = Field(default=DEFAULT_STEPS, ge=1, le=100)
    seed: Optional[int] = None
    images: list[str] = []  # base64 PNG/JPEG reference images (edit mode)
    name: Optional[str] = None  # filename under OUT_DIR
    return_b64: bool = True


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_ID, "loaded": pipe is not None, "offload": OFFLOAD}


async def _generate(req: GenerateRequest):
    if pipe is None:
        raise HTTPException(503, "pipeline not loaded yet")
    seed = req.seed if req.seed is not None else int.from_bytes(os.urandom(4), "little")
    refs = [_b64_to_pil(i) for i in req.images]
    async with lock:
        t0 = time.time()
        img = await asyncio.to_thread(
            _run, req.prompt, refs, req.negative_prompt, req.true_cfg_scale,
            req.width, req.height, req.output_resolution, req.steps, seed,
        )
        secs = time.time() - t0
    name = _safe_name(req.name)
    path = os.path.join(OUT_DIR, name)
    img.save(path)
    out = {"file": name, "width": img.width, "height": img.height, "mode": img.mode,
           "seed": seed, "steps": req.steps, "seconds": round(secs, 1),
           "node": os.environ.get("NODE_NAME", ""), "offload": OFFLOAD}
    if req.return_b64:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out["b64_png"] = base64.b64encode(buf.getvalue()).decode()
    return out


@app.post("/v1/generate")
async def generate(req: GenerateRequest):
    return await _generate(req)


@app.get("/files/{name}")
def get_file(name: str):
    path = os.path.join(OUT_DIR, _safe_name(name))
    if not os.path.isfile(path):
        raise HTTPException(404)
    return FileResponse(path, media_type="image/png")


# ---- OpenAI-shaped surface (what inference-club-agent routes type=image to) ----
# Beyond the OpenAI fields (prompt, n, size, background, response_format) the
# inference.club playground sends the knobs this model actually has: seed,
# steps, negative_prompt + guidance (true CFG), and any WxH size up to 2048.
RGBA_PREFIX = "This is an RGBA image with transparency. "
RGBA_SUFFIX = " The image has an alpha channel and the background is transparent."
MAX_SIDE = int(os.environ.get("MAX_SIDE", "2048"))


def _parse_size(size: Optional[str]):
    """'1024x1024' -> (1024, 1024); None/'auto' -> (None, None). Sides are
    clamped to MAX_SIDE and rounded down to the VAE's multiple of 32."""
    if not size or size == "auto":
        return None, None
    try:
        w, h = (int(x) for x in size.lower().split("x"))
    except ValueError:
        raise HTTPException(400, f"size must look like 1024x1024, got {size!r}")
    w, h = min(w, MAX_SIDE) // 32 * 32, min(h, MAX_SIDE) // 32 * 32
    if w < 256 or h < 256:
        raise HTTPException(400, "size sides must be at least 256")
    return w, h


def _transparent_prompt(prompt: str, background: Optional[str]) -> str:
    if (background or "").lower() == "transparent" and not prompt.startswith(RGBA_PREFIX):
        return RGBA_PREFIX + prompt + RGBA_SUFFIX
    return prompt


def _openai_request(prompt, images, *, n, size, seed, steps, negative_prompt, guidance, background):
    w, h = _parse_size(size)
    return [GenerateRequest(
        prompt=_transparent_prompt(prompt, background), images=images, width=w, height=h,
        seed=None if seed is None else seed + i, steps=steps or DEFAULT_STEPS,
        negative_prompt=negative_prompt or None, true_cfg_scale=guidance if guidance else 1.0,
        output_resolution=max(w or 1024, h or 1024) if (w or h) else 1024,
    ) for i in range(max(1, min(int(n or 1), 4)))]


async def _openai_response(reqs):
    data = []
    for r in reqs:
        out = await _generate(r)
        data.append({"b64_json": out["b64_png"], "revised_prompt": r.prompt, "seed": out["seed"],
                     "width": out["width"], "height": out["height"], "steps": out["steps"]})
    return {"created": int(time.time()), "data": data}


class OpenAIImageRequest(BaseModel):
    prompt: str
    n: int = 1
    size: Optional[str] = None  # "1024x1024", any WxH up to 2048, or "auto"
    response_format: str = "b64_json"
    background: Optional[str] = None  # "transparent" | "opaque" | "auto"
    quality: Optional[str] = None  # accepted, ignored
    seed: Optional[int] = None
    steps: Optional[int] = Field(default=None, ge=1, le=100)
    negative_prompt: Optional[str] = None
    guidance: Optional[float] = Field(default=None, ge=1.0, le=20.0)  # true_cfg_scale; needs negative_prompt


@app.post("/v1/images/generations")
async def openai_generations(req: OpenAIImageRequest):
    return await _openai_response(_openai_request(
        req.prompt, [], n=req.n, size=req.size, seed=req.seed, steps=req.steps,
        negative_prompt=req.negative_prompt, guidance=req.guidance, background=req.background))


@app.post("/v1/images/edits")
async def openai_edits(
    prompt: str = Form(...),
    # 1..10 reference images ("image 1", "image 2", … in the prompt). OpenAI's
    # single-source field is `image`; inference.club sends several as `image[]`.
    image: list[UploadFile] = File(default=[]),
    image_list: list[UploadFile] = File(default=[], alias="image[]"),
    n: int = Form(1),
    size: Optional[str] = Form(None),
    background: Optional[str] = Form(None),
    seed: Optional[int] = Form(None),
    steps: Optional[int] = Form(None),
    negative_prompt: Optional[str] = Form(None),
    guidance: Optional[float] = Form(None),
):
    refs = list(image) + list(image_list)
    if not refs:
        raise HTTPException(400, "at least one reference image is required (`image` or `image[]`)")
    if len(refs) > 10:
        raise HTTPException(400, "at most 10 reference images")
    imgs = [base64.b64encode(await f.read()).decode() for f in refs]
    return await _openai_response(_openai_request(
        prompt, imgs, n=n, size=size, seed=seed, steps=steps,
        negative_prompt=negative_prompt, guidance=guidance, background=background))
