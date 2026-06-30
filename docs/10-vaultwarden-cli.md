# 10 — Vaultwarden as the homelab secret store (CLI access)

Vaultwarden (`https://vault.lan`, see `clusters/home/vaultwarden/`) is the
cluster's password/secret manager. This doc describes how automation — including
Claude — reads homelab tokens from it **without ever materializing a credential
into a file**, via the `bw` (Bitwarden) CLI and `scripts/vault-secret.sh`.

## Why this design

Two constraints shaped it:

1. **Claude's shells are ephemeral** — env vars and `BW_SESSION` don't persist
   between tool calls, so every task must unlock-and-fetch in one shot.
2. **A credential store must stay all-encrypted at rest**, and live secrets must
   never land in a committable file (this repo is public).

So: long-lived bot credentials live in the **macOS login Keychain** (populated
once, out of band). `scripts/vault-secret.sh` reads them at runtime, performs an
in-memory `bw unlock`, fetches one item, and exits. The script contains no
secrets and is safe to commit.

## Scope: a dedicated bot account, not your personal vault

Bitwarden personal vaults are all-or-nothing — anyone with the account reads
*everything*. So automation gets a **separate user** with access to **only one
shared Collection**:

- **Organization:** `homelab`
- **Collection:** `Automation` (the only collection shared to the bot)
- **Bot user:** `claude-bot@vault.lan` (or any address; SMTP is off so it's never
  emailed), invited to the org with **read-only** access to `Automation` only.

Put automation tokens (Forgejo API token, Paperless, registry robots, etc.) as
items in the `Automation` collection. The bot — and therefore Claude — can see
those and nothing else.

## One-time setup (do this once)

### 1. Vaultwarden web UI (`https://vault.lan`)
1. **New Organization** → name `homelab`.
2. In the org, **Collections → New** → `Automation`.
3. **Members → Invite** → email `claude-bot@vault.lan`, role *User*, grant access
   to the `Automation` collection only, **Can edit** (read-write, so automation
   can both read and store secrets — still scoped to just this collection). Set
   **Hide passwords = off** (the CLI needs to read them).
   - Signups are closed on this instance, so invite from the org (or temporarily
     flip `SIGNUPS_ALLOWED` / use `/admin` to create the account, then accept the
     org invite and confirm the member).
4. Log in as `claude-bot`, set its **master password**, and accept the invite.
5. As `claude-bot`: **Settings → Security → Keys → View API Key** → copy
   `client_id` and `client_secret`.
6. Move/create the homelab token items into the `Automation` collection (e.g. an
   item named `forgejo-api` whose *password* field is the Forgejo PAT).

### 2. macOS Keychain (on this Mac)
Store the three bot credentials (account = `claude`):

```bash
security add-generic-password -U -a claude -s vaultwarden-bot-clientid     -w '<client_id>'
security add-generic-password -U -a claude -s vaultwarden-bot-clientsecret -w '<client_secret>'
security add-generic-password -U -a claude -s vaultwarden-bot-password     -w '<master_password>'
```

That's it. Nothing else to configure — `bw` and the mkcert CA trust are already
in place.

## Usage

```bash
# default field is "password"
TOKEN=$(scripts/vault-secret.sh forgejo-api)

# other built-in fields
USER=$(scripts/vault-secret.sh harbor-robot username)

# a custom named field on the item
KEY=$(scripts/vault-secret.sh some-item my-field)
```

The script: trusts the mkcert `home-tls` CA (`NODE_EXTRA_CA_CERTS`), logs in with
the API key if not already authenticated, unlocks to a one-shot session, `bw
sync`s, and prints the requested value to stdout. Pipe it straight into the
consumer (e.g. `curl -H "Authorization: token $(scripts/vault-secret.sh forgejo-api)"`).

### Writing secrets

`scripts/vault-put.sh` is the companion writer — it creates/updates an item in
the `Automation` collection. The secret value is read from **stdin** (never argv
or a file), so it goes straight into the vault without touching disk or shell
history:

```bash
printf '%s' "$NEW_TOKEN" | scripts/vault-put.sh forgejo-api          # password field
printf '%s' 'some note'  | scripts/vault-put.sh my-note      notes   # notes field
```

Re-running with an existing item name updates it in place. Requires the bot to
have **Can edit** on the `Automation` collection.

## Notes / gotchas

- **Cert:** `vault.lan` uses the mkcert `home-tls` cert; `bw` (Node) needs
  `NODE_EXTRA_CA_CERTS=<mkcert -CAROOT>/rootCA.pem`. The script sets this
  automatically. Pointing at the tailnet `*.ts.net` URL (real LE cert) needs no
  CA override — set `BW_SERVER` to override the default.
- **What persists on disk:** only `bw`'s encrypted vault + auth tokens under
  `~/Library/Application Support/Bitwarden CLI`. The vault stays locked; the
  decryption key (`BW_SESSION`) only ever exists in-memory per invocation.
- **Rotating creds:** revoke the bot's API key in its *Settings → Security* and
  re-run the `security add-generic-password -U …` commands with the new values.
- **Migrating existing workflows:** the Forgejo issue-filing flow
  (`[[pdf-paperless-forgejo-workflow]]`) currently mints a short-lived token each
  run. Once a long-lived Forgejo PAT lives in `Automation` as `forgejo-api`, that
  flow can `scripts/vault-secret.sh forgejo-api` instead of `exec`-ing into the
  pod to mint one.
```
