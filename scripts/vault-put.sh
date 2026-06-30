#!/usr/bin/env bash
#
# vault-put.sh — create or update a secret in Vaultwarden's `Automation`
# collection (the companion writer to scripts/vault-secret.sh).
#
# The secret VALUE is read from STDIN — never from argv and never from a file —
# so it isn't left in shell history, a process listing, or on disk. It flows
# straight into the vault (the encrypted store), which is the whole point.
#
# Auth/cert/Keychain model is identical to vault-secret.sh (see that file and
# docs/10-vaultwarden-cli.md). Requires the bot to have "Can edit" access to the
# `Automation` collection.
#
# Usage:
#   printf '%s' '<secret-value>' | scripts/vault-put.sh <item-name> [field]
#     field: password (default) | notes
#
#   # examples
#   printf '%s' "$NEW_TOKEN"      | scripts/vault-put.sh forgejo-api
#   scripts/vault-secret.sh other | scripts/vault-put.sh copy-of-other   # piped in
#
set -euo pipefail

ITEM="${1:?usage: vault-put.sh <item-name> [field]   (secret value on stdin)}"
FIELD="${2:-password}"

SERVER="${BW_SERVER:-https://vault.lan}"
ORG_NAME="${BW_ORG:-homelab}"
COLLECTION_NAME="${BW_COLLECTION:-Automation}"

VALUE="$(cat)"
[[ -n "$VALUE" ]] || { echo "no value on stdin" >&2; exit 1; }

if [[ -z "${NODE_EXTRA_CA_CERTS:-}" ]]; then
  caroot="$(mkcert -CAROOT 2>/dev/null || true)"
  [[ -n "$caroot" && -f "$caroot/rootCA.pem" ]] && export NODE_EXTRA_CA_CERTS="$caroot/rootCA.pem"
fi

kc() { security find-generic-password -a claude -s "$1" -w 2>/dev/null; }
BW_CLIENTID="$(kc vaultwarden-bot-clientid)"         || { echo "missing keychain item: vaultwarden-bot-clientid" >&2; exit 1; }
BW_CLIENTSECRET="$(kc vaultwarden-bot-clientsecret)" || { echo "missing keychain item: vaultwarden-bot-clientsecret" >&2; exit 1; }
BW_PASSWORD="$(kc vaultwarden-bot-password)"         || { echo "missing keychain item: vaultwarden-bot-password" >&2; exit 1; }
export BW_CLIENTID BW_CLIENTSECRET

if [[ "$(bw status 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status","unauthenticated"))' 2>/dev/null)" == "unauthenticated" ]]; then
  bw config server "$SERVER" >/dev/null
  bw login --apikey >/dev/null
fi
SESSION="$(BW_PASSWORD="$BW_PASSWORD" bw unlock --passwordenv BW_PASSWORD --raw)"
bw sync --session "$SESSION" >/dev/null

ORG_ID="$(bw list organizations --session "$SESSION" \
  | python3 -c "import sys,json;print(next((o['id'] for o in json.load(sys.stdin) if o['name']=='$ORG_NAME'),''))")"
[[ -n "$ORG_ID" ]] || { echo "org not found: $ORG_NAME" >&2; exit 1; }

# Match the collection by full name OR by its last path segment, so a nested
# collection like "Default collection/Automation" resolves from BW_COLLECTION=Automation.
COLL_ID="$(bw list org-collections --organizationid "$ORG_ID" --session "$SESSION" \
  | python3 -c "import sys,json;n='$COLLECTION_NAME';print(next((c['id'] for c in json.load(sys.stdin) if c['name']==n or c['name'].split('/')[-1]==n),''))")"
[[ -n "$COLL_ID" ]] || { echo "collection not found: $COLLECTION_NAME" >&2; exit 1; }

EXISTING_ID="$(bw list items --search "$ITEM" --session "$SESSION" \
  | python3 -c "import sys,json;print(next((i['id'] for i in json.load(sys.stdin) if i.get('name')=='$ITEM'),''))")"

# Build the item JSON in python; the secret arrives via env, never argv.
build_item() {
  ITEM_NAME="$ITEM" FIELD="$FIELD" VALUE="$VALUE" ORG_ID="$ORG_ID" COLL_ID="$COLL_ID" python3 - <<'PY'
import os, json
field = os.environ["FIELD"]; value = os.environ["VALUE"]
item = {
    "type": 1,  # login
    "name": os.environ["ITEM_NAME"],
    "organizationId": os.environ["ORG_ID"],
    "collectionIds": [os.environ["COLL_ID"]],
    "notes": value if field == "notes" else None,
    "login": {
        "username": None,
        "password": value if field != "notes" else None,
        "totp": None,
    },
}
print(json.dumps(item))
PY
}

if [[ -n "$EXISTING_ID" ]]; then
  build_item | bw encode | bw edit item "$EXISTING_ID" --session "$SESSION" >/dev/null
  echo "updated '$ITEM' in $ORG_NAME/$COLLECTION_NAME"
else
  build_item | bw encode | bw create item --session "$SESSION" >/dev/null
  echo "created '$ITEM' in $ORG_NAME/$COLLECTION_NAME"
fi
