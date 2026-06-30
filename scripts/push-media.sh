#!/usr/bin/env bash
# push-media — push a local file into the home-cluster MinIO `generations/` store.
# The fan-out CronJobs then feed it to Immich / Navidrome / Paperless / the 3D
# gallery (see docs/08-media-pipeline-roadmap.md). Producers only speak S3 — this
# is the local-dev half of that contract; inference.club is the other half.
#
# Requires: mc (the MinIO client — `brew install minio-mc`).
#
# Config — env vars, or a file at ~/.config/push-media/env (KEY=VALUE lines):
#   PUSH_MEDIA_S3_ENDPOINT   default http://192.168.5.173:30900   (MinIO NodePort on a3)
#   PUSH_MEDIA_ACCESS_KEY    the `generations` access key
#   PUSH_MEDIA_SECRET_KEY    the `generations` secret key
# Retrieve the key once from the cluster:
#   kubectl -n platform get secret minio-generations -o jsonpath='{.data.access-key}' | base64 -d
#   kubectl -n platform get secret minio-generations -o jsonpath='{.data.secret-key}' | base64 -d
#
# Usage:
#   push-media <file> --type <music|images|video|pdf|3d> [--name NAME] [--tags k=v,k2=v2]
#
# Examples:
#   push-media song.mp3   --type music --tags "model=acestep,prompt=lofi"
#   push-media debug.pdf  --type pdf
#   push-media mesh.glb    --type 3d   --name dragon.glb
set -euo pipefail

CONF="${HOME}/.config/push-media/env"
[ -f "$CONF" ] && . "$CONF"

ENDPOINT="${PUSH_MEDIA_S3_ENDPOINT:-http://192.168.5.173:30900}"
ACCESS="${PUSH_MEDIA_ACCESS_KEY:-}"
SECRET="${PUSH_MEDIA_SECRET_KEY:-}"

die() { echo "push-media: $*" >&2; exit 1; }

FILE=""; TYPE=""; NAME=""; TAGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --type) TYPE="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --tags) TAGS="${2:-}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown flag: $1" ;;
    *) [ -z "$FILE" ] && FILE="$1" || die "unexpected arg: $1"; shift ;;
  esac
done

[ -n "$FILE" ] || die "no file given"
[ -f "$FILE" ] || die "no such file: $FILE"
[ -n "$TYPE" ] || die "missing --type"
case "$TYPE" in music|images|video|pdf|3d) ;; *) die "invalid --type '$TYPE' (music|images|video|pdf|3d)" ;; esac
[ -n "$ACCESS" ] && [ -n "$SECRET" ] || die "missing S3 creds (set PUSH_MEDIA_ACCESS_KEY/SECRET_KEY or $CONF)"
command -v mc >/dev/null 2>&1 || die "mc not found (brew install minio-mc)"

[ -n "$NAME" ] || NAME="$(basename "$FILE")"

# sha256 (macOS shasum / Linux sha256sum), best-effort.
SHA="$(shasum -a 256 "$FILE" 2>/dev/null | awk '{print $1}')"
[ -n "$SHA" ] || SHA="$(sha256sum "$FILE" 2>/dev/null | awk '{print $1}')" || SHA=""

# tags "k=v,k2=v2" -> JSON object
TAGS_JSON="{}"
if [ -n "$TAGS" ]; then
  TAGS_JSON="$(printf '%s' "$TAGS" | awk -F, '{printf "{"; for(i=1;i<=NF;i++){n=index($i,"="); k=substr($i,1,n-1); v=substr($i,n+1); if(i>1)printf ","; printf "\"%s\":\"%s\"",k,v} printf "}"}')"
fi

mc alias set pushmedia "$ENDPOINT" "$ACCESS" "$SECRET" >/dev/null

OBJ="pushmedia/generations/${TYPE}/${NAME}"
mc cp "$FILE" "$OBJ"

META="$(printf '{"name":"%s","type":"%s","original":"%s","sha256":"%s","pushed_at":"%s","pushed_by":"%s","tags":%s}' \
  "$NAME" "$TYPE" "$FILE" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(whoami)@$(hostname -s 2>/dev/null || hostname)" "$TAGS_JSON")"
printf '%s' "$META" | mc pipe "pushmedia/generations/_meta/${NAME}.json"

echo "push-media: ok -> generations/${TYPE}/${NAME}  (fan-out picks it up within ~5–15 min)"
