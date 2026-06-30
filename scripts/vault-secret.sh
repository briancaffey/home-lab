#!/usr/bin/env bash
#
# vault-secret.sh — fetch a secret from Vaultwarden (https://vault.lan) via the
# Bitwarden CLI, WITHOUT ever writing a credential to disk.
#
# This is the cluster's one-stop entry point for homelab tokens/keys. Any task
# that needs a credential (Forgejo API token, Paperless, registry creds, etc.)
# calls this script instead of materializing a raw secret into a file.
#
# Design (see docs/09-vaultwarden-cli.md):
#   - Long-lived bot creds (API key + master password) live in the macOS login
#     Keychain — populated once, out of band, by Brian. This script READS them
#     at runtime; it never stores anything secret. Nothing here is sensitive, so
#     it is safe to commit to this PUBLIC repo.
#   - `bw login --apikey` persists only the ENCRYPTED vault + auth tokens under
#     ~/Library/Application Support/Bitwarden CLI. The master password is needed
#     to `bw unlock`, which yields an in-memory BW_SESSION used for one fetch.
#   - bw is a Node app; it must trust the mkcert `home-tls` CA to validate the
#     vault.lan TLS cert (NODE_EXTRA_CA_CERTS).
#
# Usage:
#   scripts/vault-secret.sh <item-name> [field]
#     field defaults to "password". Built-ins: password | username | totp | notes
#     anything else is looked up as a custom field on the item.
#
#   # examples
#   TOKEN=$(scripts/vault-secret.sh forgejo-api)            # the password field
#   USER=$(scripts/vault-secret.sh harbor-robot username)
#   KEY=$(scripts/vault-secret.sh some-item my-custom-field)
#
# Keychain items it expects (account = "claude"):
#   vaultwarden-bot-clientid       bot API key client_id     (e.g. user.xxxxx)
#   vaultwarden-bot-clientsecret   bot API key client_secret
#   vaultwarden-bot-password       bot account master password
# Add them once with:
#   security add-generic-password -U -a claude -s vaultwarden-bot-clientid     -w '<client_id>'
#   security add-generic-password -U -a claude -s vaultwarden-bot-clientsecret -w '<client_secret>'
#   security add-generic-password -U -a claude -s vaultwarden-bot-password     -w '<master_password>'
#
set -euo pipefail

ITEM="${1:?usage: vault-secret.sh <item-name> [field]}"
FIELD="${2:-password}"

SERVER="${BW_SERVER:-https://vault.lan}"

# Trust the mkcert home-tls root so bw can validate vault.lan. Override by
# exporting NODE_EXTRA_CA_CERTS yourself (e.g. when pointing at a *.ts.net URL
# with a real Let's Encrypt cert, where no extra CA is needed).
if [[ -z "${NODE_EXTRA_CA_CERTS:-}" ]]; then
  caroot="$(mkcert -CAROOT 2>/dev/null || true)"
  [[ -n "$caroot" && -f "$caroot/rootCA.pem" ]] && export NODE_EXTRA_CA_CERTS="$caroot/rootCA.pem"
fi

kc() { security find-generic-password -a claude -s "$1" -w 2>/dev/null; }

BW_CLIENTID="$(kc vaultwarden-bot-clientid)"     || { echo "missing keychain item: vaultwarden-bot-clientid" >&2; exit 1; }
BW_CLIENTSECRET="$(kc vaultwarden-bot-clientsecret)" || { echo "missing keychain item: vaultwarden-bot-clientsecret" >&2; exit 1; }
BW_PASSWORD="$(kc vaultwarden-bot-password)"     || { echo "missing keychain item: vaultwarden-bot-password" >&2; exit 1; }
export BW_CLIENTID BW_CLIENTSECRET

# Log in with the API key only if not already authenticated (login state
# persists across shells; the vault stays locked until unlocked). `bw config
# server` refuses to run while logged in, so only set it before first login.
if [[ "$(bw status 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status","unauthenticated"))' 2>/dev/null)" == "unauthenticated" ]]; then
  bw config server "$SERVER" >/dev/null
  bw login --apikey >/dev/null
fi

# Unlock to a fresh in-memory session key for this single invocation.
SESSION="$(BW_PASSWORD="$BW_PASSWORD" bw unlock --passwordenv BW_PASSWORD --raw)"

# Pull latest before reading so newly-added items are visible.
bw sync --session "$SESSION" >/dev/null

case "$FIELD" in
  password|username|totp|notes|uri)
    bw get "$FIELD" "$ITEM" --session "$SESSION"
    ;;
  *)
    # Custom named field on the item.
    bw get item "$ITEM" --session "$SESSION" \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((f['value'] for f in d.get('fields') or [] if f.get('name')=='$FIELD'),''),end='')"
    ;;
esac
