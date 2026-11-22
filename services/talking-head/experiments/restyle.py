"""Round 3 experiment: restyle rendered frames one at a time with FLUX 3 Klein.

Each rendered frame goes to the image-edit model together with a reference
portrait of the person we want, and (optionally) an earlier *output* frame so the
model can stay consistent with what it already drew.

    python restyle.py ref  <out_dir>                      # make the reference portrait
    python restyle.py run  <out_dir> <frames_dir> <mode>  # mode: ref | prev1 | prev3

Talks to the flux3-klein service's native /v1/generate (JSON, base64 images).
Standard library only. FLUX_URL defaults to a local port-forward:
    kubectl -n inference-club port-forward svc/flux3-klein-4090 18000:8000
"""
import base64
import glob
import json
import os
import sys
import time
import urllib.request

URL = os.environ.get("FLUX_URL", "http://127.0.0.1:18000")
WIDTH, HEIGHT = int(os.environ.get("W", "576")), int(os.environ.get("H", "1024"))
SEED = int(os.environ.get("SEED", "7"))
STEPS = int(os.environ.get("STEPS", "16"))

REF_PROMPT = (
    "Photograph, head and shoulders portrait of a man in his early thirties with short dark brown hair, "
    "light stubble, hazel eyes and a calm neutral expression, mouth closed, looking at the camera. "
    "He wears a dark blue collared shirt. Soft warm window light from the left, plain grey studio "
    "background, 85mm lens, natural skin texture, sharp focus."
)

BASE = (
    "Image 1 is a photograph of a real man. Image 2 is a frame from a 3D animation. "
    "Redraw image 2 as a real photograph in which the person is the man from image 1: his face, hair, "
    "skin and stubble. Copy from image 2 exactly, without changing them: the head position and angle, "
    "the mouth shape and how far the lips and jaw are open, the teeth that are visible, the eyelids "
    "(open or closed), the dark blue shirt, the bookshelf, the lamp and the lighting. Keep the framing: "
    "the head is the same size and in the same place in the picture as in image 2. "
    "Photorealistic, natural skin, shallow depth of field."
)
PROMPTS = {
    "ref": BASE,
    "prev1": BASE + " Image 3 is the previous frame of the same video, already redrawn: keep the man, "
             "his hair, the shirt and the room looking identical to image 3. Only the mouth and eyelids "
             "may differ, and they must follow image 2.",
}
PROMPTS["prev3"] = PROMPTS["prev1"].replace("the previous frame", "an earlier frame")


def b64(path):
    return base64.b64encode(open(path, "rb").read()).decode()


def generate(prompt, images, out_path):
    body = json.dumps({"prompt": prompt, "images": images, "width": WIDTH, "height": HEIGHT,
                       "steps": STEPS, "seed": SEED, "upsample": False}).encode()
    request = urllib.request.Request(URL + "/v1/generate", body, {"Content-Type": "application/json"})
    started = time.time()
    for attempt in range(8):                      # a port-forward can drop mid-run
        try:
            reply = json.load(urllib.request.urlopen(request, timeout=600))
            break
        except OSError as error:
            print("retrying after", error, flush=True)
            time.sleep(5)
    else:
        raise SystemExit("the image service is not reachable")
    image = reply["b64_png"]
    open(out_path, "wb").write(base64.b64decode(image))
    return time.time() - started


def main():
    command, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    if command == "ref":
        print("reference portrait: %.1fs" % generate(REF_PROMPT, [], os.path.join(out_dir, "ref.png")))
        return
    frames_dir, mode = sys.argv[3], sys.argv[4]
    lag = {"ref": 0, "prev1": 1, "prev3": 3}[mode]
    ref = b64(os.path.join(os.path.dirname(out_dir.rstrip("/\\")), "ref.png"))
    frames = sorted(glob.glob(os.path.join(frames_dir, "*.png")))
    limit = int(os.environ.get("LIMIT", "0")) or len(frames)
    times, outputs = [], []
    for index, frame in enumerate(frames[:limit]):
        out_path = os.path.join(out_dir, os.path.basename(frame))
        images, prompt = [ref, b64(frame)], PROMPTS["ref"]
        if lag and index >= lag:
            images.append(b64(outputs[index - lag]))
            prompt = PROMPTS[mode]
        if not os.path.exists(out_path):
            times.append(generate(prompt, images, out_path))
            print("%s %d/%d %.1fs" % (mode, index + 1, limit, times[-1]), flush=True)
        outputs.append(out_path)
    if times:
        json.dump({"mode": mode, "frames": len(times), "seconds_per_frame": round(sum(times) / len(times), 2),
                   "width": WIDTH, "height": HEIGHT, "steps": STEPS, "seed": SEED, "prompt": PROMPTS[mode]},
                  open(os.path.join(out_dir, "stats.json"), "w"), indent=2)
        print("%s: %.2f s/frame over %d frames" % (mode, sum(times) / len(times), len(times)))


if __name__ == "__main__":
    main()
