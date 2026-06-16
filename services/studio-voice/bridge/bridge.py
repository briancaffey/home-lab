"""HTTP -> gRPC bridge for the Maxine Studio Voice NIM.

The NIM exposes speech enhancement only over a bidirectional-streaming gRPC API
(/nvidia.ai4m.studiovoice.v1.StudioVoice/EnhanceAudio). inference.club's agent
speaks HTTP, so this tiny FastAPI app sits beside the NIM in the same pod and
turns the OpenAI-style multipart request the agent forwards into the gRPC call.

Contract (matches backend AudioEnhanceView -> {provider}/audio/enhance):
  POST /audio/enhance   (also /v1/audio/enhance)
    multipart/form-data: file=<audio>, model=<id>, response_format=<wav|...>
    -> 200 audio/wav  (the enhanced audio bytes)

Non-streaming mode: we stream the raw uploaded WAV bytes to the NIM in 64 KiB
chunks and concatenate the response chunks back into a WAV — no audio decoding
needed (the NIM owns encode/decode), so this stays dependency-light.
"""
import os
import grpc
from fastapi import FastAPI, UploadFile, Form, HTTPException
from fastapi.responses import Response, JSONResponse

import studiovoice_pb2
import studiovoice_pb2_grpc

GRPC_TARGET = os.environ.get("STUDIO_VOICE_GRPC", "127.0.0.1:8001")
CHUNK = 64 * 1024
# Warm enhancement of a short clip is ~5-14s, but the NIM's FIRST inference after
# a model (re)load triggers a slow TRT warmup. Use a generous deadline so a cold
# first request COMPLETES instead of being cancelled — a cancelled mid-warmup call
# wedges the single model instance.
DEADLINE_S = float(os.environ.get("STUDIO_VOICE_DEADLINE", "300"))
# 64 MiB max message — well above any short speech clip.
GRPC_OPTS = [
    ("grpc.max_send_message_length", 64 * 1024 * 1024),
    ("grpc.max_receive_message_length", 64 * 1024 * 1024),
]


def _silent_wav(seconds=0.5, sr=48000):
    """A valid 48 kHz mono PCM16 WAV of silence — no audio libs needed."""
    import struct
    pcm = b"\x00\x00" * int(seconds * sr)
    return (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16)
            + b"data" + struct.pack("<I", len(pcm)) + pcm)


app = FastAPI(title="studio-voice-bridge")


@app.on_event("startup")
def _warmup():
    """Prime the NIM's TRT warmup in the background so the first real user
    request is fast and never has to absorb the cold-start latency."""
    import threading

    def run():
        import time
        for _ in range(60):  # retry while the NIM model finishes loading
            try:
                _enhance(_silent_wav())
                return
            except Exception:
                time.sleep(10)
    threading.Thread(target=run, daemon=True).start()


def _enhance(audio_bytes: bytes) -> bytes:
    def _requests():
        for i in range(0, len(audio_bytes), CHUNK):
            yield studiovoice_pb2.EnhanceAudioRequest(
                audio_stream_data=audio_bytes[i : i + CHUNK]
            )

    with grpc.insecure_channel(GRPC_TARGET, options=GRPC_OPTS) as channel:
        # NIM 1.6.1 registers nvidia.maxine.studiovoice.v1.MaxineStudioVoice
        # (the public nim-clients "latest" renamed this to StudioVoice — do NOT
        # use those stubs; these are extracted from the running image).
        stub = studiovoice_pb2_grpc.MaxineStudioVoiceStub(channel)
        out = bytearray()
        for resp in stub.EnhanceAudio(_requests(), timeout=DEADLINE_S):
            if resp.HasField("audio_stream_data"):
                out += resp.audio_stream_data
        return bytes(out)


async def _handle(file: UploadFile, response_format: str):
    if file is None:
        raise HTTPException(status_code=400, detail="missing_file")
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="missing_file")
    try:
        enhanced = _enhance(audio)
    except grpc.RpcError as e:
        raise HTTPException(status_code=502, detail=f"upstream_grpc_error: {e.code()}")
    if not enhanced:
        raise HTTPException(status_code=502, detail="empty_upstream_response")
    ext = (response_format or "wav").lower()
    media = "audio/ogg" if ext in ("ogg", "opus") else "audio/wav"
    return Response(
        content=enhanced,
        media_type=media,
        headers={"Content-Disposition": f'inline; filename="enhanced.{ext}"'},
    )


@app.post("/audio/enhance")
@app.post("/v1/audio/enhance")
async def enhance(file: UploadFile = None, model: str = Form(default=""),
                  response_format: str = Form(default="wav")):
    return await _handle(file, response_format)


@app.get("/health")
@app.get("/v1/health/ready")
@app.get("/v1/health/live")
def health():
    # The NIM's own /v1/health/ready (port 8000) gates the pod; the bridge is
    # ready once it can open a channel. Report ok so its own probe stays green.
    try:
        with grpc.insecure_channel(GRPC_TARGET) as ch:
            grpc.channel_ready_future(ch).result(timeout=2)
        return JSONResponse({"status": "ready", "grpc": GRPC_TARGET})
    except Exception:
        return JSONResponse({"status": "starting", "grpc": GRPC_TARGET}, status_code=503)
