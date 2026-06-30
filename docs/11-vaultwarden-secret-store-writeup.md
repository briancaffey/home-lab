# 11 — Making Vaultwarden the homelab secret store for automation (writeup)

*What was built, why, and the gotchas hit along the way. The how-to-use
reference is `docs/10-vaultwarden-cli.md`; this is the rationale + changelog.*

## The problem

Automation in this repo regularly needs credentials — the Forgejo issue-filing
flow, Paperless uploads, registry robots, etc. Two recurring pains:

1. **No durable home for tokens.** The Forgejo flow minted a *throwaway*
   access-token by `exec`-ing into the pod on every run, because there was
   nowhere safe to keep a long-lived one. Wasteful and leaves orphaned
   `claude-*` tokens behind.
2. **Secrets must never hit disk.** This is a public repo, and the agent's
   auto-mode guard (correctly) blocks materializing a live credential into an
   inspectable file. So "just drop it in a dotenv" is off the table.

Vaultwarden was already deployed (`clusters/home/vaultwarden/`, `https://vault.lan`)
but nothing programmatic used it. Goal: make it the **one-stop shop** that
automation — including Claude — reads from and writes to, without any secret
ever landing in the repo, a file, or shell history.

## Design decisions (and the alternatives rejected)

**Access via the `bw` CLI, personal-vault API.** Vaultwarden is
Bitwarden-compatible, so the official `bw` CLI is the natural client. Considered
Bitwarden **Secrets Manager** (`bws`, machine accounts, fine-grained projects) —
rejected because Vaultwarden's Secrets Manager support is experimental/unreliable.
The classic `bw` item API is rock-solid on Vaultwarden.

**A dedicated bot account, scoped to one collection — not the personal vault.**
Bitwarden personal vaults are all-or-nothing: hand the CLI your own account and
it can read *every* password you own. Instead:
- Org `homelab` → collection `Automation`.
- A separate `claude-bot` user with **Edit Items** on `Automation` *only*.
So automation can read **and** write homelab tokens, but is structurally
incapable of seeing anything outside that one collection. Least privilege.

**Long-lived creds in the macOS Keychain, read at runtime.** Two constraints
forced this shape:
- Claude's shells are **ephemeral** — env vars / `BW_SESSION` don't persist
  between tool calls, so every task must unlock-and-fetch in one shot.
- Live creds can't be written to a file (the guard, and good hygiene).
So the bot's API key + master password live in the **login Keychain** (Brian
populated them once, out of band). The wrapper scripts *read* them with
`security find-generic-password` at runtime, do an in-memory `bw unlock`, fetch
or store one item, and exit. Nothing secret is ever written by the scripts.

**Writes take the value on stdin, never argv/file.** `vault-put.sh` reads the
secret from stdin so it isn't left in shell history or a process listing — it
flows straight into the encrypted vault, which is the one place it's *supposed*
to live.

**mkcert CA trust.** `vault.lan` uses the mkcert `home-tls` cert; `bw` is a Node
app and won't validate it by default. The scripts auto-set
`NODE_EXTRA_CA_CERTS=$(mkcert -CAROOT)/rootCA.pem`. (`NODE_TLS_REJECT_UNAUTHORIZED=0`
was rejected outright — never disable TLS verification against a credential store.)

## What was built

- **`scripts/vault-secret.sh <item> [field]`** — read a secret to stdout.
- **`scripts/vault-put.sh <item> [field]`** — create/update a secret (value on
  stdin).
- **`docs/10-vaultwarden-cli.md`** — the how-to-use reference + one-time setup.
- **`vaultwarden.yaml`** — `SIGNUPS_ALLOWED` flipped to `"false"` now that both
  accounts exist (a credential store should not sit with open registration).
- Keychain items (Brian, out of band): `vaultwarden-bot-{clientid,clientsecret,password}`.
- **Forgejo PAT** minted (scopes `write:issue,read:repository`) and stored as the
  `forgejo-api` item, replacing the per-run throwaway-token dance.

## Gotchas hit during setup (so the next person doesn't)

- **Org API key ≠ user API key.** `bw login --apikey` needs the *bot user's*
  personal API key (`client_id: user.…`), not the Organization API key
  (`client_id: organization.…`, scope `api.organization`). The org key is for
  the org-management API and is useless here.
- **`/admin` was disabled** (no `ADMIN_TOKEN` secret). Didn't need it — signups
  were still open, so the bot account was registered directly, then signups closed.
- **Confirming a member ≠ granting collection access.** The bot showed up
  *confirmed* in the org but saw **zero collections** until the `Automation`
  collection was explicitly assigned to the member.
- **Collection was nested** as `Default collection/Automation`. The scripts now
  match a collection by its **last path segment**, so `BW_COLLECTION=Automation`
  still resolves.
- **"Edit Items" vs "Edit Items, hidden passwords."** The latter hides password
  *values* from the bot — which breaks reads. Must be plain **Edit Items**.
- **`bw config server` refuses to run while logged in.** Calling it every
  invocation errored once authenticated. Fixed: only set the server *before* the
  first login (it persists thereafter).

## Verification

- Read/write **round-trip**: wrote a marker via `vault-put.sh`, read the
  identical value back via `vault-secret.sh`, then soft-deleted the test item. ✅
- **Forgejo PAT**: read back from the vault and used against the live API —
  authenticated and read `brian/home-lab` successfully. (`/api/v1/user` returns
  empty by design: the token deliberately lacks `read:user` scope.) ✅

## Security posture / follow-ups

- Bot is confined to the `Automation` collection; personal vault untouched.
- Signups closed; secrets never enter the repo, a file, or shell history; the
  Forgejo token is least-privilege.
- **Open debt:** Vaultwarden's whole vault is one SQLite DB on a3 with **no
  backups yet** (tracked in the manifest header) — this now holds real
  automation secrets, so backups matter more. Token **rotation**: revoke the
  bot's API key and re-run the `security add-generic-password -U …` commands.
- **Next:** migrate other workflows (Paperless, registry creds) to pull from the
  `Automation` collection the same way.
