"""Ask the in-cluster Dia service to speak TEXT, save a WAV. Reuses an existing file."""
import os, sys, requests

out = sys.argv[1]
if os.path.exists(out):
    print("speech already exists, reusing", out); sys.exit(0)
r = requests.post(
    os.environ.get("DIA_URL", "http://dia.inference-club.svc.cluster.local:8491") + "/generate",
    data={"text": os.environ["TEXT"], "seed": os.environ.get("SEED", "-1"),
          "max_new_tokens": os.environ.get("MAX_NEW_TOKENS", "1300")},
    timeout=600,
)
r.raise_for_status()
open(out, "wb").write(r.content)
print("speech:", out, r.headers.get("x-duration-seconds"), "s, seed", r.headers.get("x-seed"))
