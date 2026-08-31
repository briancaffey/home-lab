#!/usr/bin/env bash
# Merge ONE Renovate PR and watch it all the way to a verified-healthy rollout.
#
#   merge-and-watch.sh <pr> <argo-app> <namespace> [health-url] [pod-selector]
#
# Exits non-zero if the rollout does not converge, so a caller can stop the run.
# On failure it prints the exact `git revert` needed -- selfHeal means kubectl
# cannot roll this back.
set -uo pipefail

PR="${1:?pr number}"; APP="${2:?argo app}"; NS="${3:?namespace}"
URL="${4:-}"; SEL="${5:-}"
API="https://forgejo.lan/api/v1/repos/brian/home-lab"
CRED=$(printf 'protocol=https\nhost=forgejo.lan\n\n' | git credential fill 2>/dev/null)
U=$(sed -n 's/^username=//p' <<<"$CRED"); P=$(sed -n 's/^password=//p' <<<"$CRED")

appfield() { kubectl -n argocd get app "$APP" -o jsonpath="{$1}" 2>/dev/null; }

BEFORE_REV=$(appfield .status.sync.revision)
echo "── PR #$PR → app $APP (ns $NS)"
echo "   argo revision before: ${BEFORE_REV:0:7}"

# Snapshot restart counts so we can tell a NEW crash from pre-existing noise.
before_restarts=$(kubectl -n "$NS" get pods ${SEL:+-l "$SEL"} \
  -o json 2>/dev/null | jq -r '.items[] | select((.metadata.ownerReferences // [])[0].kind != "Job")
    | "\(.metadata.name) \((.status.containerStatuses // [])[0].restartCount // 0)"' | sort)

resp=$(curl -s -u "$U:$P" -X POST -H 'Content-Type: application/json' \
  -d '{"Do":"merge","delete_after_merge":true}' "$API/pulls/$PR/merge" -w '\n%{http_code}')
code=$(tail -1 <<<"$resp")
if [ "$code" != "200" ] && [ "$code" != "204" ]; then
  echo "   MERGE FAILED (http $code): $(sed '$d' <<<"$resp" | head -c 300)"; exit 1
fi
echo "   merged (http $code)"

MERGE_SHA=$(curl -s -u "$U:$P" "$API/pulls/$PR" | jq -r '.merge_commit_sha // empty')
echo "   merge commit: ${MERGE_SHA:0:7}"

echo "   waiting for argo to sync a new revision + report Healthy…"
ok=""
for i in $(seq 1 60); do   # up to ~10 min
  rev=$(appfield .status.sync.revision); sync=$(appfield .status.sync.status); health=$(appfield .status.health.status)
  if [ "$rev" != "$BEFORE_REV" ] && [ "$sync" = "Synced" ] && [ "$health" = "Healthy" ]; then
    echo "   argo: ${rev:0:7} $sync/$health"; ok=1; break
  fi
  [ $((i % 6)) = 0 ] && echo "   … ${rev:0:7} $sync/$health"
  sleep 10
done
[ -z "$ok" ] && { echo "   *** app did not reach Synced/Healthy on a new revision ***"; }

echo "   pods:"
kubectl -n "$NS" get pods ${SEL:+-l "$SEL"} --no-headers 2>/dev/null | sed 's/^/     /'

# A pod can be Running and still be wedged, so compare restart deltas explicitly.
after_restarts=$(kubectl -n "$NS" get pods ${SEL:+-l "$SEL"} \
  -o json 2>/dev/null | jq -r '.items[] | select((.metadata.ownerReferences // [])[0].kind != "Job")
    | "\(.metadata.name) \((.status.containerStatuses // [])[0].restartCount // 0)"' | sort)
newcrash=$(comm -13 <(echo "$before_restarts") <(echo "$after_restarts") | awk '$2>0')
[ -n "$newcrash" ] && echo "   NOTE restarting pods: $newcrash"

# Only judge pods that are NOT Job-owned. CronJob history (renovate, backups)
# leaves Failed/Succeeded pods lying around for days; counting those as a broken
# rollout once produced a false "revert this" on a merge that was perfectly fine.
bad=$(kubectl -n "$NS" get pods ${SEL:+-l "$SEL"} -o json 2>/dev/null | jq -r '
  .items[]
  | select((.metadata.ownerReferences // [])[0].kind != "Job")
  | select(.status.phase != "Succeeded")
  | [ .metadata.name,
      ( [ (.status.containerStatuses // [])[]
          | .state.waiting.reason // .state.terminated.reason // empty ] | join(",") )
    ] | @tsv' \
  | grep -cE 'ImagePull|ErrImage|CrashLoopBackOff|OOMKilled|Error')

if [ -n "$URL" ]; then
  printf '   endpoint %s -> ' "$URL"
  curl -s -o /dev/null -m 15 -w 'http=%{http_code} in %{time_total}s\n' "$URL" || echo "UNREACHABLE"
fi

if [ -z "$ok" ] || [ "${bad:-0}" -gt 0 ]; then
  echo
  echo "   ROLLOUT NOT CLEAN. selfHeal will undo any kubectl fix. To roll back:"
  echo "     git -C ~/git/home-cluster pull && git -C ~/git/home-cluster revert --no-edit ${MERGE_SHA:-<merge-sha>} && git -C ~/git/home-cluster push origin main"
  exit 1
fi
echo "   ✓ PR #$PR healthy"
