---
name: vaultwarden
description: "Fetch homelab credentials (API tokens, passwords, keys) from Brian's Vaultwarden vault with the vault-secret command. Use whenever a task needs a credential for a cluster service (Forgejo, Harbor, Grafana, Paperless, HuggingFace, ...) instead of asking Brian or giving up."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    tags: [secrets, credentials, vaultwarden, bitwarden, infrastructure]
    related_skills: [home-cluster]
---

# vaultwarden: fetch homelab secrets

`vault-secret` is on PATH and authenticates automatically (bot account,
read-only intent). It prints the requested value to stdout, nothing else.

```sh
vault-secret <item-name> [field]
```

`field` defaults to `password`. Built-ins: `password | username | totp |
notes | uri`; any other name reads a custom field on the item.

## Examples

```sh
TOKEN=$(vault-secret forgejo)                  # Forgejo API token
HF=$(vault-secret huggingface-api)             # HuggingFace token
U=$(vault-secret harbor-admin username)        # a username field
curl -s -H "Authorization: token $(vault-secret forgejo)" \
  https://forgejo.lan/api/v1/repos/brian/home-lab/issues
```

## Known items (2026-07; the vault is the source of truth)

`forgejo`, `paperless-api`, `grafana-admin`, `harbor-admin`, `pihole-web`,
`ghcr-pull`, `litellm-master`, `huggingface-api`, `hermes-api-server-key`,
`hermes-dashboard-password`, and others. If an item name doesn't match,
report the failure — do NOT guess names by brute force.

## Ground rules (non-negotiable)

- **Never print a full secret value into chat, logs, or files.** Capture it
  into a shell variable and use it in the same command. If Brian explicitly
  asks for a value verbatim, confirm once, then comply.
- To prove access works, report only metadata: field length, first 4
  characters, or the result of USING the credential (e.g. an HTTP 200).
- Fetch at time of use; don't stockpile secrets in notes/memory/env files.
- Item names must be exact — no substring guessing (names are unique,
  non-prefixing by convention).
