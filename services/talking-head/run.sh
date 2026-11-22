#!/bin/bash
# Submit one stage of the pipeline as a Job and follow its log.
#   ./run.sh a2e   <run-name> "<text with [S1] tag>" [seed] [max_new_tokens]
#   ./run.sh blender <run-name>
set -euo pipefail
cd "$(dirname "$0")"
STAGE=$1; export RUN=$2 TEXT=${3:-} SEED=${4:--1} MAX_NEW_TOKENS=${5:-1300}
kubectl apply -k . >/dev/null
kubectl -n talking-head delete job "$STAGE-$RUN" --ignore-not-found --cascade=foreground >/dev/null
python3 - <<PY | kubectl apply -f -
import os, string, json
src = open("job-$STAGE.yaml").read()
env = {k: json.dumps(os.environ.get(k, ""))[1:-1] for k in ("RUN", "TEXT", "SEED", "MAX_NEW_TOKENS")}
print(string.Template(src).safe_substitute(env))
PY
# The first run on a node pulls a multi-GB image, so wait for the pod to leave
# Pending before following the log.
until kubectl -n talking-head get pod -l job-name="$STAGE-$RUN" -o jsonpath='{.items[0].status.phase}' 2>/dev/null | grep -qE "Running|Succeeded|Failed"; do sleep 5; done
kubectl -n talking-head logs -f "job/$STAGE-$RUN"
kubectl -n talking-head wait --for=condition=complete "job/$STAGE-$RUN" --timeout=60s
