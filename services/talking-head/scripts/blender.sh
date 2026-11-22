#!/bin/bash
# Stage 3: ARKit curves + speech -> rigged MakeHuman head -> MP4 + GLB + .blend.
# Runs inside ubuntu:24.04; Blender, the MPFB2 add-on and the CC0 asset packs are
# downloaded once and cached under /work/cache.
set -euo pipefail
W=/work; RUN_DIR=$W/runs/$RUN; CACHE=$W/cache
mkdir -p "$CACHE/dl"; export DEBIAN_FRONTEND=noninteractive

echo "== [1/3] system libs"
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils unzip \
  libx11-6 libxrender1 libxxf86vm1 libxfixes3 libxi6 libxkbcommon0 libsm6 libice6 libgl1 libegl1 libgomp1 >/dev/null

echo "== [2/3] blender + add-on + assets (cached)"
# Download to .part and rename, so a stalled or killed download is never mistaken
# for a finished one; give up on a mirror that drops below 200 kB/s for 30 s.
fetch() {
  [ -s "$CACHE/dl/$1" ] && return 0
  curl -fSL --retry 3 --speed-limit 200000 --speed-time 30 -o "$CACHE/dl/$1.part" "$2" 2>&1 | tail -1
  mv "$CACHE/dl/$1.part" "$CACHE/dl/$1"
}
fetch "blender-$BLENDER_VERSION.tar.xz" "https://download.blender.org/release/Blender${BLENDER_VERSION%.*}/blender-$BLENDER_VERSION-linux-x64.tar.xz"
fetch mpfb.zip "$MPFB_URL"
fetch makehuman_system_assets_cc0.zip https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip
fetch faceunits01.zip https://files.makehumancommunity.org/functional/faceunits01.zip
B=$CACHE/blender-$BLENDER_VERSION-linux-x64
[ -x "$B/blender" ] || tar -xJf "$CACHE/dl/blender-$BLENDER_VERSION.tar.xz" -C "$CACHE"
export HOME=$CACHE/home; mkdir -p "$HOME"
"$B/blender" --command extension install-file -r user_default -e "$CACHE/dl/mpfb.zip" 2>&1 | tail -2

echo "== [3/3] build, animate, render"
"$B/blender" --background --factory-startup --python-exit-code 1 --python /scripts/head.py -- "$RUN_DIR" "$CACHE/dl"
chmod -R a+rX "$RUN_DIR"; ls -la "$RUN_DIR"
echo "== done: $RUN_DIR"
