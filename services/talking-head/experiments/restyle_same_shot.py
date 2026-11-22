"""Round 3, strategy D: anchor on a restyled frame from the same shot instead of a separate portrait.

    python restyle_same_shot.py <work_dir>     # expects <work_dir>/frames/*.png, writes <work_dir>/D/
    ALL=1 restyles every frame; the default is eight sample frames.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import restyle  # noqa: E402

here = os.path.abspath(sys.argv[1])
frames = sorted(os.path.join(here, "frames", f) for f in os.listdir(os.path.join(here, "frames")))
out = os.path.join(here, "D")
os.makedirs(out, exist_ok=True)

ANCHOR = (
    "Turn this frame from a 3D animation into a real photograph. Keep everything exactly where it is: "
    "the man's head position, size and angle, his closed mouth, his dark blue shirt, the bookshelf and "
    "the lamp behind him, the framing and the warm lighting. Make him a real man in his early thirties "
    "with short dark brown hair and light stubble, with natural skin texture. Photorealistic, shallow depth of field."
)
FRAME = (
    "Image 1 is a photograph. Image 2 is a frame from a 3D animation of the same shot, a moment later. "
    "Redraw image 2 as a photograph that looks exactly like image 1: the same real man, hair, stubble, "
    "shirt, room, framing and lighting. Take only two things from image 2: the mouth (how far the lips "
    "and jaw are open and which teeth show) and the eyelids (open or closed). Photorealistic."
)

anchor = os.path.join(out, "anchor.png")
if not os.path.exists(anchor):
    print("anchor %.1fs" % restyle.generate(ANCHOR, [restyle.b64(frames[0])], anchor), flush=True)
picks = range(len(frames)) if os.environ.get("ALL") else [1, 5, 9, 13, 17, 21, 25, 29]
for i in picks:
    target = os.path.join(out, os.path.basename(frames[i]))
    if not os.path.exists(target):
        seconds = restyle.generate(FRAME, [restyle.b64(anchor), restyle.b64(frames[i])], target)
        print("D %d %.1fs" % (i, seconds), flush=True)
