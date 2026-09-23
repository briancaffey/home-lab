#!/usr/bin/env bash
# End-to-end check: health -> OTLP span export with the bootstrap project keys -> span visible via the v4 API.
# Usage: bash observability/langfuse/smoke-test.sh   (needs kubectl + LAN access to langfuse.lan)
set -u
PK=$(kubectl -n observability get secret langfuse-secrets -o jsonpath='{.data.init-project-public-key}' | base64 -d)
SK=$(kubectl -n observability get secret langfuse-secrets -o jsonpath='{.data.init-project-secret-key}' | base64 -d)
BASE=https://langfuse.lan
echo "health:  $(curl -sk --max-time 10 $BASE/api/public/health)"
echo "ready:   $(curl -sk --max-time 10 -o /dev/null -w '%{http_code}' $BASE/api/public/ready)"
echo "login:   $(curl -sk --max-time 10 -o /dev/null -w '%{http_code}' $BASE/auth/sign-in)"
NOW=$(python3 -c 'import time;print(int(time.time()*1e9))')
TID=$(python3 -c 'import secrets;print(secrets.token_hex(16))'); SID=$(python3 -c 'import secrets;print(secrets.token_hex(8))')
BODY=$(cat <<JSON
{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"otlp-smoke-test"}}]},
 "scopeSpans":[{"scope":{"name":"smoke"},"spans":[{"traceId":"$TID","spanId":"$SID","name":"langfuse-smoke-test","kind":1,
 "startTimeUnixNano":"$((NOW-500000000))","endTimeUnixNano":"$NOW",
 "attributes":[{"key":"gen_ai.system","value":{"stringValue":"home-lab"}}]}]}]}]}
JSON
)
echo "otlp:    $(curl -sk --max-time 20 -o /dev/null -w '%{http_code}' -u "$PK:$SK" -H 'Content-Type: application/json' -X POST "$BASE/api/public/otel/v1/traces" -d "$BODY")"
for i in $(seq 1 12); do
  # Langfuse v4 runs in events-only mode: /api/public/traces and /observations are gone,
  # /api/public/v2/observations is the read side for spans.
  N=$(curl -sk --max-time 10 -u "$PK:$SK" "$BASE/api/public/v2/observations?name=langfuse-smoke-test&limit=1" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("data",[])))' 2>/dev/null)
  [ "${N:-0}" -ge 1 ] && { echo "span visible via v2 API after ~$((i*5))s: yes"; exit 0; }
  sleep 5
done
echo "span visible via v2 API: NO (after 60s) — check langfuse-worker logs and ClickHouse events_core"; exit 1
