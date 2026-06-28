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

HOSTS=(headlamp.lan home.lan grafana.lan openwebui.lan jupyter.lan invokeai.lan abs.lan jellyfin.lan vault.lan "*.lan")

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
