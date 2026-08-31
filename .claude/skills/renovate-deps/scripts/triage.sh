#!/usr/bin/env bash
# Triage open chore(deps) PRs on forgejo.lan/brian/home-lab.
# For each PR: the version change, the files it touches, the Argo CD app that
# owns those files, and whether that app self-heals (i.e. merge == deploy).
#
# Usage: triage.sh [PR_NUMBER ...]      (default: all open PRs)
set -uo pipefail

REPO_API="https://forgejo.lan/api/v1/repos/brian/home-lab"
CRED=$(printf 'protocol=https\nhost=forgejo.lan\n\n' | git credential fill 2>/dev/null)
U=$(sed -n 's/^username=//p' <<<"$CRED")
P=$(sed -n 's/^password=//p' <<<"$CRED")
if [ -z "${U:-}" ] || [ -z "${P:-}" ]; then
  echo "ERROR: no forgejo.lan credentials from git credential helper" >&2; exit 1
fi
api() { curl -sf -u "$U:$P" "$@"; }

# path -> argo app + selfHeal, built once
# NOTE: multi-source apps (e.g. external-secrets) have a null .spec.source.path
# and carry their real path in .spec.sources[].path. Missing that once reported a
# secrets-critical file as "not deployed" -- collect from both.
APPS=$(kubectl -n argocd get app -o json 2>/dev/null | jq -r '
  .items[] as $a
  | ( [ $a.spec.source.path ] + [ ($a.spec.sources // [])[].path ] )
  | .[] | select(. != null)
  | [ ., $a.metadata.name,
      (if $a.spec.syncPolicy.automated.selfHeal then "SELFHEAL" else "manual" end)
    ] | @tsv' | sort -r)

owner_of() { # $1 = changed file path -> "app (selfheal)" for the longest matching app path
  local f="$1" p n s
  while IFS=$'\t' read -r p n s; do
    [ "$p" = "-" ] && continue
    case "$f" in "$p"/*) echo "$n ($s)"; return;; esac
  done <<<"$APPS"
  # Not "safe" -- just not directly path-synced. It may still ship via a CI image
  # build (docs-site -> home-docs) or a source this map doesn't cover. Verify.
  echo "no direct path match — VERIFY (CI-built? multi-source?)"
}

if [ $# -gt 0 ]; then NUMS="$*"; else
  NUMS=$(api "$REPO_API/pulls?state=open&limit=100" | jq -r '.[] | select(.title | startswith("chore(deps)")) | .number')
fi

for n in $NUMS; do
  meta=$(api "$REPO_API/pulls/$n") || { echo "#$n: fetch failed"; continue; }
  echo "═══ PR #$n ═══"
  jq -r '"  title:     \(.title)\n  branch:    \(.head.ref)\n  mergeable: \(.mergeable)  labels: \([.labels[].name] | join(","))"' <<<"$meta"

  diff=$(api "$REPO_API/pulls/$n.diff")
  echo "  version change:"
  grep -E '^[-+][^-+]' <<<"$diff" | grep -E 'image:|version:|"version"|releases/download' | sed 's/^/    /' | sort -u | head -6

  echo "  files -> owning argo app:"
  while read -r f; do
    [ -z "$f" ] && continue
    printf '    %-58s %s\n' "$f" "$(owner_of "$f")"
  done < <(grep '^+++ b/' <<<"$diff" | sed 's|^+++ b/||' | sort -u)

  # overlap with other open PRs = guaranteed rebase
  echo "$diff" | grep '^+++ b/' | sed 's|^+++ b/||' | sort -u > "/tmp/.rnv.$n"
  echo
done

echo "═══ file overlaps (these will conflict; merge one, rebase the other) ═══"
for a in /tmp/.rnv.*; do for b in /tmp/.rnv.*; do
  na=${a##*.}; nb=${b##*.}
  [ "$na" -ge "$nb" ] 2>/dev/null && continue
  shared=$(comm -12 "$a" "$b")
  [ -n "$shared" ] && echo "  #$na <-> #$nb: $(tr '\n' ' ' <<<"$shared")"
done; done
rm -f /tmp/.rnv.*
