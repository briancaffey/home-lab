#!/usr/bin/env bash
# wait-healthy.sh <sha> <app>[,<app>...]
# After a direct push to main: refresh the Argo apps, wait (~15 min max each)
# until each is Synced to <sha> (or a descendant) and Healthy, then list any
# non-Job pod in the apps' namespaces that is not Ready or restarted in the last
# 10 min. Handles multi-source apps (.status.sync.revisions). Exit 1 on failure.
# Run in the foreground: background shells here are bash 3.2.
set -uo pipefail
SHA="$1"; IFS=, read -ra APPS <<<"$2"
for a in "${APPS[@]}"; do kubectl -n argocd annotate app "$a" argocd.argoproj.io/refresh=normal --overwrite >/dev/null 2>&1; done
fail=0
for a in "${APPS[@]}"; do
  ok=""
  for i in $(seq 1 90); do   # ~15 min
    read -r rev sync health <<<"$(kubectl -n argocd get app "$a" -o json | jq -r '"\((.status.sync.revision // (.status.sync.revisions // [] | map(select(test("^[0-9a-f]{40}$"))) | .[0]) // "-")) \(.status.sync.status) \(.status.health.status)"' 2>/dev/null)"
    if [ -n "$rev" ] && git -C ~/git/home-cluster merge-base --is-ancestor "$SHA" "$rev" 2>/dev/null && [ "$sync" = Synced ] && [ "$health" = Healthy ]; then ok=1; break; fi
    sleep 10
  done
  if [ -n "$ok" ]; then echo "OK   $a ${rev:0:7} $sync/$health"; else echo "FAIL $a ${rev:0:7} $sync/$health"; fail=1
    kubectl -n argocd get app "$a" -o json | jq -r '.status.resources[]? | select((.health.status // "Healthy") != "Healthy" or .status != "Synced") | "     \(.kind)/\(.name) \(.status) \(.health.status // "") \(.health.message // "")"' | head -8
  fi
  ns=$(kubectl -n argocd get app "$a" -o jsonpath='{.spec.destination.namespace}')
  kubectl -n "$ns" get pods -o json 2>/dev/null | jq -r --arg a "$a" '.items[] | select((.metadata.ownerReferences // [])[0].kind != "Job") |
     select(.status.phase != "Succeeded") |
     . as $p | (.status.containerStatuses // [])[] |
     select((.ready|not) or ((.lastState.terminated.finishedAt // "1970-01-01T00:00:00Z") | fromdateiso8601 > (now - 600))) |
     "     !! \($a) \($p.metadata.name) ready=\(.ready) restarts=\(.restartCount) \(.state|keys[0]) \(.state.waiting.reason // "")"'
done
exit $fail
