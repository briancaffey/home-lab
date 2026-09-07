#!/usr/bin/env bash
#
# vault-put-fields.sh — create or update the CUSTOM FIELDS of a Vaultwarden item
# in the `Automation` collection. This is the shape External Secrets reads
# (store.yaml: one item per k8s Secret, one hidden custom field per data key),
# where vault-put.sh only writes the login password/username/notes.
#
# Field values arrive on STDIN as a flat JSON object — never argv, never a file
# — so nothing lands in shell history or a process listing.
#
# Usage:
#   printf '%s' '{"DATABASE_URL":"...","API_KEY":"..."}' | scripts/vault-put-fields.sh <item-name>
#   Fields MERGE into the existing item: named fields are replaced, others kept.
#
# Auth/cert/Keychain model is identical to vault-secret.sh (see docs/10).
set -euo pipefail

ITEM="${1:?usage: vault-put-fields.sh <item-name>   (JSON object of fields on stdin)}"

SERVER="${BW_SERVER:-https://vault.lan}"
ORG_NAME="${BW_ORG:-homelab}"
COLLECTION_NAME="${BW_COLLECTION:-Automation}"

FIELDS_JSON="$(cat)"
[[ -n "$FIELDS_JSON" ]] || { echo "no JSON on stdin" >&2; exit 1; }

if [[ -z "${NODE_EXTRA_CA_CERTS:-}" ]]; then
  caroot="$(mkcert -CAROOT 2>/dev/null || true)"
  [[ -n "$caroot" && -f "$caroot/rootCA.pem" ]] && export NODE_EXTRA_CA_CERTS="$caroot/rootCA.pem"
fi

kc() {
  if command -v security >/dev/null 2>&1; then
    security find-generic-password -a claude -s "$1" -w 2>/dev/null
  else
    secret-tool lookup account claude service "$1" 2>/dev/null
  fi
}
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

COLL_ID="$(bw list org-collections --organizationid "$ORG_ID" --session "$SESSION" \
  | python3 -c "import sys,json;n='$COLLECTION_NAME';print(next((c['id'] for c in json.load(sys.stdin) if c['name']==n or c['name'].split('/')[-1]==n),''))")"
[[ -n "$COLL_ID" ]] || { echo "collection not found: $COLLECTION_NAME" >&2; exit 1; }

EXISTING_ID="$(bw list items --search "$ITEM" --session "$SESSION" \
  | python3 -c "import sys,json;print(next((i['id'] for i in json.load(sys.stdin) if i.get('name')=='$ITEM'),''))")"

build_item() {
  EXISTING_JSON="${1:-}" ITEM_NAME="$ITEM" FIELDS_JSON="$FIELDS_JSON" ORG_ID="$ORG_ID" COLL_ID="$COLL_ID" python3 - <<'PY'
import os, json
new = json.loads(os.environ["FIELDS_JSON"])
if not isinstance(new, dict) or not all(isinstance(v, str) for v in new.values()):
    raise SystemExit("stdin must be a flat JSON object of string values")
existing = os.environ.get("EXISTING_JSON")
if existing:
    item = json.loads(existing)
else:
    item = {
        "type": 1,
        "name": os.environ["ITEM_NAME"],
        "organizationId": os.environ["ORG_ID"],
        "collectionIds": [os.environ["COLL_ID"]],
        "notes": None,
        "login": {"username": None, "password": None, "totp": None},
        "fields": [],
    }
fields = [f for f in (item.get("fields") or []) if f.get("name") not in new]
# type 1 = hidden, so values are masked in the UI.
fields += [{"name": k, "value": v, "type": 1} for k, v in new.items()]
item["fields"] = fields
print(json.dumps(item))
PY
}

if [[ -n "$EXISTING_ID" ]]; then
  EXISTING_JSON="$(bw get item "$EXISTING_ID" --session "$SESSION")"
  build_item "$EXISTING_JSON" | bw encode | bw edit item "$EXISTING_ID" --session "$SESSION" >/dev/null
  echo "updated '$ITEM' fields in $ORG_NAME/$COLLECTION_NAME"
else
  build_item | bw encode | bw create item --session "$SESSION" >/dev/null
  echo "created '$ITEM' in $ORG_NAME/$COLLECTION_NAME"
fi
