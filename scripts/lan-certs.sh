#!/usr/bin/env bash
# Generate a mkcert leaf cert for the *.lan homelab hosts and create the TLS
# secrets the ingresses reference. Run on a machine with kubectl + mkcert.
#
#   bash scripts/lan-certs.sh
#
# The mkcert CA is reused (run `mkcert -install` once per client machine to
# trust it). Private keys are NEVER committed — see .gitignore. Re-run this
# whenever you add a new <name>.lan host (add it to HOSTS below).
set -euo pipefail

HOSTS=(headlamp.lan home.lan grafana.lan openwebui.lan jupyter.lan invokeai.lan abs.lan jellyfin.lan vault.lan harbor.lan speedtest.lan netdata.lan forgejo.lan immich.lan music.lan paperless.lan models.lan phoenix.lan pihole.lan litellm.lan milvus.lan manyfold.lan gatus.lan hermes.lan "*.lan")

# secret-name : namespace
SECRETS=(
  "headlamp-tls:headlamp"
  "home-tls:homepage"
  "grafana-tls:monitoring"
  "openwebui-tls:open-webui"
  "jupyter-tls:jupyter"
  "invokeai-tls:invokeai"
  "audiobookshelf-tls:audiobookshelf"
  "jellyfin-tls:jellyfin"
  "vaultwarden-tls:vaultwarden"
  "harbor-tls:harbor"
  "speedtest-tls:speedtest"
  "netdata-tls:netdata"
  "forgejo-tls:forgejo"
  "immich-tls:immich"
  "navidrome-tls:navidrome"
  "paperless-tls:paperless"
  "models-tls:models"
  "phoenix-tls:observability"
  "pihole-tls:pihole"
  "litellm-tls:observability"
  "milvus-tls:milvus"
  "manyfold-tls:manyfold"
  "gatus-tls:gatus"
  "hermes-tls:hermes"
  # One shared secret for ALL inference .lan ingresses (omni.lan, asr.lan,
  # magpie.lan, flux.lan, ltx.lan, …) — covered by the cert's *.lan wildcard
  # SAN, so new inference hostnames need no HOSTS entry.
  "inference-tls:inference-club"
)

command -v mkcert >/dev/null || { echo "mkcert not found (brew install mkcert nss)"; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkcert -cert-file "$TMP/lan.crt" -key-file "$TMP/lan.key" "${HOSTS[@]}"

for entry in "${SECRETS[@]}"; do
  name="${entry%%:*}"; ns="${entry##*:}"
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n "$ns" create secret tls "$name" \
    --cert="$TMP/lan.crt" --key="$TMP/lan.key" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "ok: secret/$name in $ns"
done

echo "Done. Run 'mkcert -install' once on each client machine to trust the CA."
