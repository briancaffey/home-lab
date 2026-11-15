"""nano-edge-tts server: Kokoro-82M's text side + the 1.75M-parameter
nano-edge-tts decoder (drmhse/nano-edge-tts), CPU only.

Three API shapes on one port:
  - Riva-shaped   POST /v1/audio/synthesize (multipart), GET /v1/audio/list_voices
                  -- what inference.club's backend speaks to a `tts` service,
                  so this is a drop-in next to the Magpie NIM.
  - OpenAI-shaped POST /v1/audio/speech (JSON), GET /v1/models
  - health        GET /health, GET /v1/health/ready

Extras over a plain Riva service (all optional):
  voice     one name, or a blend: "af_heart+am_michael" / "af_heart:0.7+bm_george:0.3"
  speed     0.5 .. 2.0
  decoder   "nano" (default) | "kokoro" (the original 53M decoder, only when
            KEEP_KOKORO_DECODER=1 -- for A/B listening)
  stream    true -> audio is sent sentence by sentence as it is rendered
            (wav with an open-ended header, or raw pcm)

Everything (Kokoro weights, voices, decoder) is baked into the image; the pod
needs no network and no volume.
"""
import asyncio
import io
import logging
import os
import re
import struct
import threading
import time

import numpy as np
import soundfile as sf
import soxr
import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from huggingface_hub import hf_hub_download, snapshot_download
from kokoro import KPipeline

import nano_edge_tts

log = logging.getLogger("nano-edge-tts")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

MODEL_ID = os.environ.get("MODEL_ID", "nano-edge-tts")
KOKORO_REPO = os.environ.get("KOKORO_REPO", "hexgrad/Kokoro-82M")
DEFAULT_VOICE = os.environ.get("DEFAULT_VOICE", "af_heart")
MAX_CHARS = int(os.environ.get("MAX_INPUT_CHARS", "20000"))
KEEP_KOKORO = os.environ.get("KEEP_KOKORO_DECODER", "0") == "1"
SR = 24000

if os.environ.get("TORCH_THREADS"):
    torch.set_num_threads(int(os.environ["TORCH_THREADS"]))

# voice prefix -> (kokoro lang code, Riva-style language tag)
LANGS = {
    "a": ("a", "en-US"), "b": ("b", "en-GB"), "e": ("e", "es-ES"), "f": ("f", "fr-FR"),
    "h": ("h", "hi-IN"), "i": ("i", "it-IT"), "p": ("p", "pt-BR"),
}
# The decoder was trained on these two; the rest "run but are untested".
SUPPORTED_LANGS = {"a", "b"}


class Engine:
    def __init__(self):
        t0 = time.monotonic()
        self.model = nano_edge_tts.load(repo_id=KOKORO_REPO)
        self.nano = self.model.decoder
        self.kokoro = None
        if KEEP_KOKORO:
            from kokoro import KModel
            self.kokoro = KModel(repo_id=KOKORO_REPO).eval().decoder
        self.pipes = {}
        self.lock = threading.Lock()  # one synthesis at a time; torch uses all cores
        # Voices = whatever is in the local Kokoro snapshot. The image bakes in
        # only the languages in LANGS and runs offline, so list the directory
        # (snapshot_download refuses a partial snapshot when offline).
        if os.environ.get("HF_HUB_OFFLINE") != "1":
            snapshot_download(KOKORO_REPO, allow_patterns=["voices/[abefhip]*.pt"])
        root = os.path.dirname(hf_hub_download(KOKORO_REPO, "config.json"))
        self.voices = sorted(f[:-3] for f in os.listdir(os.path.join(root, "voices")) if f.endswith(".pt"))
        self.voices = [v for v in self.voices if v[0] in LANGS]
        self.pipe("a")
        # Warm-up: first call pays for G2P model load + torch lazy init.
        self.render("Ready.", DEFAULT_VOICE)
        log.info("loaded in %.1fs, %d voices, threads=%d, kokoro decoder kept=%s",
                 time.monotonic() - t0, len(self.voices), torch.get_num_threads(), KEEP_KOKORO)

    def pipe(self, lang):
        if lang not in self.pipes:
            self.pipes[lang] = KPipeline(lang_code=lang, model=self.model, repo_id=KOKORO_REPO)
        return self.pipes[lang]

    def resolve_voice(self, spec):
        """'af_heart' | 'af_heart+am_michael' | 'af_heart:0.7,bm_george:0.3' -> (lang, tensor, canonical name).
        Unknown names fall back to the default voice (a client configured for
        another TTS model keeps working)."""
        parts = [p for p in re.split(r"[+,]", (spec or "").strip()) if p.strip()]
        names, weights = [], []
        for p in parts:
            name, _, w = p.strip().partition(":")
            if name not in self.voices:
                continue
            try:
                weights.append(float(w) if w else 1.0)
            except ValueError:
                weights.append(1.0)
            names.append(name)
        if not names or sum(weights) <= 0:
            names, weights = [DEFAULT_VOICE], [1.0]
        lang = names[0][0]
        pipe = self.pipe(lang)
        if len(names) == 1:
            return lang, pipe.load_single_voice(names[0]), names[0]
        total = sum(weights)
        pack = sum(pipe.load_single_voice(n) * (w / total) for n, w in zip(names, weights))
        canonical = "+".join(f"{n}:{w / total:.2f}" for n, w in zip(names, weights))
        return lang, pack, canonical

    def segments(self, text, voice, speed=1.0, decoder="nano", lang=None, by_sentence=False):
        """Yield float32 numpy chunks, one per Kokoro segment. Kokoro packs up to
        ~510 phonemes (about 30 s of speech) into a segment; by_sentence splits at
        sentence ends instead, so a stream's first audio arrives after one sentence."""
        vlang, pack, _ = self.resolve_voice(voice)
        pipe = self.pipe(lang or vlang)
        with self.lock:
            if decoder == "kokoro":
                if self.kokoro is None:
                    raise HTTPException(400, "decoder=kokoro needs KEEP_KOKORO_DECODER=1")
                self.model.decoder = self.kokoro
            try:
                with torch.inference_mode():
                    split = r"(?<=[.!?…])\s+|\n+" if by_sentence else r"\n+"
                    for r in pipe(text, voice=pack, speed=speed, split_pattern=split):
                        if r.audio is not None:
                            yield r.audio.numpy().astype(np.float32)
            finally:
                self.model.decoder = self.nano

    def render(self, text, voice, **kw):
        chunks = list(self.segments(text, voice, **kw))
        return np.concatenate(chunks) if chunks else np.zeros(0, np.float32)


app = FastAPI(title="nano-edge-tts")
engine: Engine | None = None


@app.on_event("startup")
def _startup():
    global engine
    engine = Engine()


def _ready():
    if engine is None:
        raise HTTPException(503, "loading")
    return {"status": "ready", "model": MODEL_ID}


app.get("/health")(_ready)
app.get("/v1/health/ready")(_ready)


PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>nano-edge-tts</title>
<style>body{font:16px/1.5 system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem;color-scheme:light dark}
textarea,select,input,button{font:inherit;width:100%;box-sizing:border-box;margin:.25rem 0 .75rem;padding:.5rem}
.row{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}audio{width:100%}small{opacity:.7}</style>
<h1>nano-edge-tts</h1>
<p><small>Kokoro-82M text side + a 1.75M-parameter decoder, on CPU. <a href=/docs>API docs</a></small></p>
<label>Text<textarea id=t rows=5>The decoder that made this has under two million parameters.</textarea></label>
<div class=row><label>Voice<select id=v></select></label>
<label>Blend with (optional)<select id=v2><option value="">none</option></select></label></div>
<div class=row><label>Speed <span id=sv>1.0</span><input id=s type=range min=0.5 max=2 step=0.1 value=1></label>
<label>Decoder<select id=d><option>nano</option><option>kokoro</option></select></label></div>
<button id=go>Speak</button><audio id=a controls></audio><p><small id=m></small></p>
<script>
const $=i=>document.getElementById(i);
fetch('/v1/audio/voices?all=1').then(r=>r.json()).then(j=>{for(const id of ['v','v2'])for(const x of j.voices)$(id).add(new Option(x,x));$('v').value='af_heart'});
$('s').oninput=()=>$('sv').textContent=(+$('s').value).toFixed(1);
$('go').onclick=async()=>{$('m').textContent='rendering';
 const voice=$('v').value+($('v2').value?'+'+$('v2').value:'');
 const r=await fetch('/v1/audio/speech',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({input:$('t').value,voice,speed:+$('s').value,decoder:$('d').value})});
 if(!r.ok){$('m').textContent=(await r.json()).error.message;return}
 $('a').src=URL.createObjectURL(await r.blob());$('a').play();
 $('m').textContent=r.headers.get('x-audio-seconds')+' s of audio in '+r.headers.get('x-gen-seconds')+' s (RTF '+r.headers.get('x-rtf')+'), voice '+r.headers.get('x-voice')};
</script>"""


@app.get("/", include_in_schema=False)
def index():
    return Response(PAGE, media_type="text/html")


@app.get("/v1/models")
def models():
    _ready()
    return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "drmhse"}]}


@app.get("/v1/audio/list_voices")
def list_voices(all: bool = False):
    """Riva shape: {"<comma-joined language tags>": {"voices": [...]}}.
    Only the English voices the decoder was trained on, unless ?all=1."""
    _ready()
    out = {}
    for v in engine.voices:
        if not all and v[0] not in SUPPORTED_LANGS:
            continue
        out.setdefault(LANGS[v[0]][1], {"voices": []})["voices"].append(v)
    return out


@app.get("/v1/audio/voices")
def voices(all: bool = False):
    return {"voices": [v for d in list_voices(all).values() for v in d["voices"]]}


FORMATS = {
    # name -> (soundfile format, subtype, content type)
    "wav": ("WAV", "PCM_16", "audio/wav"),
    "linear_pcm": ("WAV", "PCM_16", "audio/wav"),
    "flac": ("FLAC", "PCM_16", "audio/flac"),
    "mp3": ("MP3", None, "audio/mpeg"),
    "opus": ("OGG", "OPUS", "audio/ogg"),
    "ogg_opus": ("OGG", "OPUS", "audio/ogg"),
    "pcm": (None, None, "audio/pcm"),
}


def _resample(audio, rate):
    """The model is 24 kHz native; other rates (the club asks for 44.1 kHz) go through soxr."""
    if rate == SR or not len(audio):
        return audio
    return soxr.resample(audio, SR, rate, quality="HQ").astype(np.float32)


def _pcm16(audio):
    return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


def _encode(audio, fmt, rate):
    sf_fmt, subtype, ctype = FORMATS[fmt]
    if sf_fmt is None:
        return _pcm16(audio), ctype
    buf = io.BytesIO()
    sf.write(buf, audio, rate, format=sf_fmt, subtype=subtype)
    return buf.getvalue(), ctype


def _wav_header_open(rate):
    # Streaming WAV: sizes set to 0xFFFFFFFF, players read to end of stream.
    return (b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVEfmt " +
            struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", 0xFFFFFFFF))


async def _speak(text, voice, fmt, rate, speed, decoder, stream, lang):
    _ready()
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(400, "text is required")
    if len(text) > MAX_CHARS:
        raise HTTPException(413, f"text longer than {MAX_CHARS} characters")
    fmt = (fmt or "wav").lower()
    if fmt not in FORMATS:
        raise HTTPException(400, f"format must be one of {sorted(FORMATS)}")
    speed = min(2.0, max(0.5, float(speed or 1.0)))
    rate = int(rate or SR)
    if not 8000 <= rate <= 48000:
        raise HTTPException(400, "sample rate must be 8000..48000")
    if lang and lang not in LANGS:
        raise HTTPException(400, f"lang must be one of {sorted(LANGS)}")
    _, _, canonical = engine.resolve_voice(voice)
    kw = dict(speed=speed, decoder=decoder or "nano", lang=lang)

    if stream:
        if fmt not in ("wav", "linear_pcm", "pcm"):
            raise HTTPException(400, "stream supports wav or pcm")
        loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue()

        def work():
            try:
                for chunk in engine.segments(text, voice, by_sentence=True, **kw):
                    loop.call_soon_threadsafe(q.put_nowait, _pcm16(_resample(chunk, rate)))
            except Exception as e:  # noqa: BLE001
                log.exception("stream failed: %s", e)
            finally:
                loop.call_soon_threadsafe(q.put_nowait, None)

        threading.Thread(target=work, daemon=True).start()

        async def gen():
            if fmt != "pcm":
                yield _wav_header_open(rate)
            while (b := await q.get()) is not None:
                yield b

        return StreamingResponse(gen(), media_type=FORMATS[fmt][2],
                                 headers={"X-Voice": canonical, "X-Sample-Rate": str(rate)})

    t0 = time.monotonic()
    audio = await asyncio.to_thread(engine.render, text, voice, **kw)
    gen_s = time.monotonic() - t0
    secs = len(audio) / SR
    body, ctype = await asyncio.to_thread(_encode, _resample(audio, rate), fmt, rate)
    log.info("chars=%d voice=%s audio=%.2fs gen=%.3fs rtf=%.4f", len(text), canonical, secs, gen_s, gen_s / max(secs, 1e-6))
    return Response(body, media_type=ctype, headers={
        "X-Voice": canonical, "X-Sample-Rate": str(rate),
        "X-Audio-Seconds": f"{secs:.3f}", "X-Gen-Seconds": f"{gen_s:.3f}",
        "X-RTF": f"{gen_s / max(secs, 1e-6):.4f}",
    })


def _truthy(v):
    return str(v).lower() in ("1", "true", "yes", "on")


@app.post("/v1/audio/synthesize")
async def synthesize(request: Request):
    """Riva-shaped: multipart (or urlencoded) text, language, voice, sample_rate_hz, encoding."""
    f = await request.form()
    enc = (f.get("encoding") or "LINEAR_PCM").lower()
    return await _speak(f.get("text"), f.get("voice"), {"linear_pcm": "wav", "oggopus": "opus"}.get(enc, enc),
                        f.get("sample_rate_hz"), f.get("speed"), f.get("decoder"),
                        _truthy(f.get("stream", "")), f.get("lang"))


@app.post("/v1/audio/speech")
async def speech(request: Request):
    """OpenAI-shaped: {model, input, voice, response_format, speed, stream}."""
    try:
        b = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "JSON body required")
    return await _speak(b.get("input"), b.get("voice"), b.get("response_format"), b.get("sample_rate_hz"),
                        b.get("speed"), b.get("decoder"), _truthy(b.get("stream", "")), b.get("lang"))


@app.exception_handler(HTTPException)
async def _err(_, exc):
    return JSONResponse({"error": {"message": exc.detail, "type": "invalid_request"}}, status_code=exc.status_code)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8880")))
