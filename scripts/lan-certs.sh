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

# NOTE: every hostname must be listed EXPLICITLY. The "*.lan" SAN is kept for
# non-browser clients, but Chrome/Firefox reject wildcards directly under a
# TLD (needs >= 2 dots, i.e. *.x.lan would work but *.lan does not) — relying
# on it produces ERR_CERT_COMMON_NAME_INVALID.
HOSTS=(headlamp.lan home.lan grafana.lan openwebui.lan jupyter.lan invokeai.lan abs.lan jellyfin.lan vault.lan harbor.lan speedtest.lan netdata.lan forgejo.lan immich.lan music.lan paperless.lan models.lan phoenix.lan pihole.lan litellm.lan milvus.lan manyfold.lan gatus.lan hermes.lan omni.lan asr.lan magpie.lan flux.lan ltx.lan studio-voice.lan firecrawl.lan acestep.lan dia.lan trellis.lan lmstudio.lan kube-ops-view.lan rampart.lan longhorn.lan mailpit.lan argocd.lan hello.lan prometheus.lan clusterscape.lan qbittorrent.lan code.lan backups.lan scrutiny.lan "*.lan")

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
  # magpie.lan, flux.lan, ltx.lan, …). Each hostname must also be in HOSTS
  # above — browsers do not accept the *.lan wildcard (see NOTE there).
  "inference-tls:inference-club"
  "kube-ops-view-tls:kube-ops-view"
  "rampart-tls:rampart"
  "longhorn-tls:longhorn-system"
  "mailpit-tls:mailpit"
  "argocd-tls:argocd"
  "hello-tls:hello-gitops"
  "prometheus-tls:monitoring"
  "clusterscape-tls:clusterscape"
  "qbittorrent-tls:qbittorrent"
  "code-tls:hermes"
  "backups-tls:minio-backups"
  "scrutiny-tls:scrutiny"
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

# Argo CD's repo-server clones from https://forgejo.lan and needs the mkcert CA
# (per-host trust via argocd-tls-certs-cm). The upstream install ships that
# ConfigMap empty, so re-applying clusters/home/argocd resets it — re-run this
# script afterwards. Merge-patch keeps the install's labels intact.
if kubectl get ns argocd >/dev/null 2>&1; then
  kubectl -n argocd create configmap argocd-tls-certs-cm \
    --from-file=forgejo.lan="$(mkcert -CAROOT)/rootCA.pem" \
    --dry-run=client -o json \
    | kubectl -n argocd patch configmap argocd-tls-certs-cm --type merge --patch-file /dev/stdin
  echo "ok: mkcert CA -> argocd-tls-certs-cm (forgejo.lan)"
fi

# Namespaces whose pods need the mkcert root CA as a file (mounted at
# /etc/mkcert): hermes (bw -> vault.lan), renovate (git/API -> forgejo.lan).
# Public cert, not a secret.
for ns in hermes renovate; do
  kubectl get ns "$ns" >/dev/null 2>&1 || continue
  kubectl -n "$ns" create configmap mkcert-ca \
    --from-file=rootCA.pem="$(mkcert -CAROOT)/rootCA.pem" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "ok: mkcert CA -> configmap/mkcert-ca ($ns)"
done

echo "Done. Run 'mkcert -install' once on each client machine to trust the CA."
