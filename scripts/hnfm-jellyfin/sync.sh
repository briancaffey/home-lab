#!/usr/bin/env bash
# Convert HNFM video generations into a Jellyfin "Movies" library and sync them
# to the cluster (a2), where Jellyfin serves them at https://jellyfin.lan/.
#
# Idempotent end to end:
#   - the converter skips items whose latest render is already staged (.hnfm.json marker)
#   - rsync only ships changed/new files
# So you can run it as often as you like; it only does work for NEW generations.
#
#   bash scripts/hnfm-jellyfin/sync.sh              # convert + sync everything new
#   bash scripts/hnfm-jellyfin/sync.sh --force      # rebuild all (e.g. after NFO changes)
#   bash scripts/hnfm-jellyfin/sync.sh --only 48706825,48672232   # specific HN ids
#
# Overridable via env:
#   HNFM_DIR    path to the hn.fm checkout            (default: ~/git/hn.fm)
#   HNFM_STAGE  local staging dir for built folders   (default: ~/.cache/hnfm-jellyfin/stage)
#   HNFM_DEST   rsync destination (Jellyfin library)  (default: brian@192.168.5.96:/home/brian/media/hnfm/)
#   JELLYFIN_API_KEY  if set, triggers a library scan when done (see README; store in Vaultwarden)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HNFM_DIR="${HNFM_DIR:-$HOME/git/hn.fm}"
HNFM_STAGE="${HNFM_STAGE:-$HOME/.cache/hnfm-jellyfin/stage}"
HNFM_DEST="${HNFM_DEST:-brian@192.168.5.96:/home/brian/media/hnfm/}"

mkdir -p "$HNFM_STAGE"
echo "==> converting HNFM outputs -> $HNFM_STAGE"
python3 "$HERE/hnfm_to_jellyfin.py" "$HNFM_DIR/outputs/hn/item" "$HNFM_STAGE" "$@"

echo "==> syncing to $HNFM_DEST"
rsync -a "$HNFM_STAGE/" "$HNFM_DEST"
n=$(find "$HNFM_STAGE" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')
echo "==> $n movie folders present in the library"

# Optional: kick a Jellyfin scan so new items appear immediately (else they show
# up on Jellyfin's scheduled scan / real-time monitoring).
if [[ -n "${JELLYFIN_API_KEY:-}" ]]; then
  echo "==> triggering Jellyfin library scan"
  curl -sk -X POST "https://jellyfin.lan/Library/Refresh?api_key=${JELLYFIN_API_KEY}" \
       --resolve jellyfin.lan:443:192.168.5.173 -o /dev/null -w "    scan requested (HTTP %{http_code})\n" || true
fi
