"""Speed + memory benchmark: nano decoder vs Kokoro's own, on this machine.

    python bench.py [--threads N] [--rounds 3] [--kokoro]

Prints one JSON line. Run as a k8s Job pinned to a node to compare hardware.
RTF = seconds of compute per second of audio (lower is faster).
"""
import argparse
import json
import os
import platform
import resource
import sys
import time

import torch

SENTENCES = [
    "The quick brown fox jumps over the lazy dog near the quiet riverbank.",
    "She had never seen the harbour so still, nor the gulls so silent, as on that grey morning.",
    "In 2026, roughly 3.5 million people listened to the broadcast, according to the survey.",
    "Why would anyone build a decoder with fewer than two million parameters? Because it runs anywhere.",
    "Please confirm the appointment for Tuesday at a quarter past nine, and bring the signed forms with you.",
    "Rain hammered the tin roof while the kettle, forgotten on the stove, began at last to sing.",
]

ap = argparse.ArgumentParser()
ap.add_argument("--threads", type=int, default=0)
ap.add_argument("--rounds", type=int, default=3)
ap.add_argument("--kokoro", action="store_true", help="benchmark Kokoro's original decoder instead")
a = ap.parse_args()
if a.threads:
    torch.set_num_threads(a.threads)

from kokoro import KModel, KPipeline  # noqa: E402

import nano_edge_tts  # noqa: E402

t0 = time.monotonic()
model = KModel(repo_id="hexgrad/Kokoro-82M").eval() if a.kokoro else nano_edge_tts.load()
pipe = KPipeline(lang_code="a", model=model, repo_id="hexgrad/Kokoro-82M")
load_s = time.monotonic() - t0


def run():
    secs = 0.0
    t = time.monotonic()
    with torch.inference_mode():
        for s in SENTENCES:
            for r in pipe(s, voice="af_heart"):
                secs += len(r.audio) / 24000
    return time.monotonic() - t, secs


first, _ = run()  # warm-up (also the cold first-request cost)
times = []
for _ in range(a.rounds):
    dt, secs = run()
    times.append(dt)
rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
rss_mb = rss / (1024 * 1024 if sys.platform == "darwin" else 1024)
cpu = platform.processor() or platform.machine()
try:
    cpu = next(l.split(":", 1)[1].strip() for l in open("/proc/cpuinfo") if l.startswith("model name"))
except Exception:  # noqa: BLE001
    pass
print(json.dumps({
    "node": os.environ.get("NODE_NAME", platform.node()), "cpu": cpu, "arch": platform.machine(),
    "decoder": "kokoro" if a.kokoro else "nano", "threads": torch.get_num_threads(),
    "audio_s": round(secs, 2), "rtf": round(min(times) / secs, 4), "rtf_mean": round(sum(times) / len(times) / secs, 4),
    "warmup_s": round(first, 2), "load_s": round(load_s, 2), "peak_rss_mb": round(rss_mb),
}))
