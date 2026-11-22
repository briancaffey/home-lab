# talking-head

Type a sentence, get a rigged 3D head saying it. A vertical slice of a bigger
project (photo -> faithful, rigged, speaking 3D human); the likeness step is
not here yet, so the head is a stock MakeHuman character.

```
text --Dia--> speech.wav --LAM Audio2Expression--> curves.json (52 ARKit weights/frame)
     --Blender + MPFB2--> head.mp4, head.glb, head.blend
```

## Run it

```bash
./run.sh a2e     demo "[S1] Hello there. This is a test." 11 700   # text -> speech -> curves
./run.sh blender demo                                               # curves -> video + model
STILL_ONLY=1 ./run.sh blender demo                                  # one preview frame, for look-dev
```

Outputs land on a2 under `/opt/talking-head/runs/<run>/`. Pick a seed and check
the speech before rendering: Dia sometimes produces noise for a given seed, and
runs long if `max_new_tokens` (the last argument, ~86 per second) is too high.

## How it is deployed

- Namespace `talking-head` plus one ConfigMap holding `scripts/` (`kubectl apply -k .`,
  which `run.sh` does for you).
- Two one-shot **Jobs**, templated by `run.sh` and pinned to a2. Both use the
  shared-GPU pattern (no `nvidia.com/gpu` claim), so they ride next to trellis2.
- No custom images. `job-a2e` starts from `pytorch/pytorch:2.1.2-cuda12.1` and
  `job-blender` from `ubuntu:24.04`; each downloads what it needs once into
  `/opt/talking-head/cache` on the node (hostPath).
- Blender renders headless with Cycles on the 4090 through OptiX (~1.3 s/frame at 720x1280).
- The set is built in `scripts/head.py`: a small study (bookshelf, lamp), warm key light,
  shallow focus and a slow camera push-in, framed 9:16.

## Pieces and licences

| Piece | Licence |
|---|---|
| Dia (in-cluster service, `services/dia`) | Apache-2.0 |
| LAM_Audio2Expression, code and weights | Apache-2.0 |
| Blender, MPFB2 add-on | GPL |
| MakeHuman system assets, `faceunits01` ARKit shapes | CC0 |

## Known limits

- The model only drives the mouth, jaw and blinks: no head motion, brows or gaze.
- Lower teeth show too much; the stock ARKit shapes need tuning.
- `files2.makehumancommunity.org` can crawl (80 kB/s on 2026-11-22); the script
  uses the `files.` mirror and aborts a stalled download.
- The first run on a node pulls a ~3.5 GB image and ~700 MB of Blender and assets.
