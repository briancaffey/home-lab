# 06 — Harbor private registry

How Harbor is deployed as the cluster's private container registry at
<https://harbor.lan/>, replacing the built-in `registry:2`. This covers the
single-node configuration, exposure, TLS/certs, secrets, and the gotchas we hit.

> Image-blob storage on a2's E drive is intentionally **out of scope here** — see
> the separate E-drive notes. This doc assumes the registry has *somewhere* to
> persist and focuses on Harbor itself.

Manifests: `clusters/home/harbor/` · deploy reference: its `README.md`.

---

## What it is

- Chart `harbor/harbor` **1.19.1** (app **2.15.1**), deployed helm-via-kustomize
  (`kustomize build --enable-helm clusters/home/harbor | kubectl apply -f -`),
  same pattern as open-webui / loki.
- A single-node install: **every Harbor component runs on a2**, registry is
  single-replica.
- Exposed through Traefik at `harbor.lan` with a mkcert-signed cert.

Components the chart brings up (all on a2): `core`, `portal`, `registry`,
`jobservice` (Deployments) and `database` (Postgres), `redis`, `trivy`
(StatefulSets), fronted by one `harbor-ingress`.

---

## Single-node configuration (pin everything to a2)

The most important non-obvious thing: **the Harbor chart has no global
`nodeSelector`.** A top-level `nodeSelector:` in values is silently ignored. Each
component is pinned individually, and `database`/`redis` are nested under
`.internal`:

```yaml
nginx:      { nodeSelector: { kubernetes.io/hostname: a2 } }
portal:     { nodeSelector: { kubernetes.io/hostname: a2 } }
core:       { nodeSelector: { kubernetes.io/hostname: a2 } }
jobservice: { nodeSelector: { kubernetes.io/hostname: a2 } }
registry:   { nodeSelector: { kubernetes.io/hostname: a2 } }
trivy:      { nodeSelector: { kubernetes.io/hostname: a2 } }
exporter:   { nodeSelector: { kubernetes.io/hostname: a2 } }
database:   { internal: { nodeSelector: { kubernetes.io/hostname: a2 } } }
redis:      { internal: { nodeSelector: { kubernetes.io/hostname: a2 } } }
```

We use `kubernetes.io/hostname: a2` (the standard built-in label) rather than the
repo's `inference-club.com/box` convention, because the same label keys the
storage volume's node affinity. Verify after a render with:

```bash
kustomize build --enable-helm clusters/home/harbor \
  | yq 'select(.kind=="Deployment" or .kind=="StatefulSet") | .metadata.name + " " + (.spec.template.spec.nodeSelector|tostring)'
```

The registry runs **single-replica** — required because its storage is a
ReadWriteOnce node-local volume. If we ever need HA, the registry has to move to
object storage instead.

---

## Exposure (Traefik ingress + externalURL)

```yaml
externalURL: https://harbor.lan
expose:
  type: ingress
  tls: { enabled: true, certSource: secret, secret: { secretName: harbor-tls } }
  ingress:
    className: traefik
    hosts: { core: harbor.lan }
    annotations:        # Homepage auto-discovery, Infra group
      gethomepage.dev/enabled: "true"
      gethomepage.dev/name: "Harbor"
      ...
```

`externalURL` matters: Harbor's registry token auth is bound to it, and the core
issues redirects to it, so it must be the real outside URL (`https://harbor.lan`),
not a service name. Traefik routes `harbor.lan` to the `harbor-core` service
regardless of which node the request lands on — so the host can point at any node
IP in DNS. We point `harbor.lan` at `192.168.5.173` (via the dnsmasq `*.lan`
wildcard / `/etc/hosts`).

---

## TLS / certs (the part with teeth)

Harbor speaks HTTPS, signed by the homelab **mkcert CA**. Three separate trust
problems showed up; all are worth remembering.

### 1. `*.lan` does NOT cover `harbor.lan`
The shared `*.lan` mkcert wildcard does **not** validate for `harbor.lan` in Go's
TLS stack (which Docker/crane/containerd use). Go only honors a wildcard when the
host is otherwise a match; in practice our other services work because each host
is **explicitly listed** in the cert's SANs — not because of the wildcard.

Fix: the cert must name `harbor.lan` explicitly. `harbor.lan` is now in
`scripts/lan-certs.sh` (`HOSTS` + `harbor-tls:harbor`), so a normal
`bash scripts/lan-certs.sh` run produces a unified cert that includes it. During
initial bring-up we minted a **targeted** cert instead, to avoid rotating every
other service's cert:

```bash
mkcert -cert-file harbor.crt -key-file harbor.key harbor.lan
kubectl -n harbor create secret tls harbor-tls --cert=harbor.crt --key=harbor.key \
  --dry-run=client -o yaml | kubectl apply -f -
```

The `harbor-tls` secret lives in the `harbor` namespace because k8s TLS secrets
are namespace-scoped — an ingress can only reference a secret in its own namespace.

### 2. Nodes must trust the CA to pull images
For a **pod** to pull from `harbor.lan`, that node's containerd must trust the
mkcert CA. `scripts/trust-harbor-ca.sh` (run with sudo on each node) installs the
mkcert root into `/etc/rancher/k3s/harbor-rootCA.pem`, writes a `registries.yaml`
`configs."harbor.lan".tls.ca_file` entry and the OS trust store, then restarts the
right k3s unit (non-disruptive to running pods). Pushing only (from a laptop)
doesn't need this; running Harbor images in-cluster does.

### 3. Docker Desktop on a Mac doesn't see the keychain CA
`docker login harbor.lan` from the Mac failed with *x509: certificate signed by
unknown authority* even though `mkcert -install` had trusted the CA in the macOS
System keychain — Docker Desktop's Linux VM has its own trust store and only picks
up `insecure-registries` / cert changes on a **daemon restart**. We did **not**
restart Docker Desktop (it was running the HNFM + inferenceclub stacks).

Instead we pushed with **`crane`** (go-containerregistry), which is daemonless and
uses Go's TLS — and Go on macOS *does* read the System keychain, where the mkcert
CA is trusted. So `crane` worked with zero changes to the Docker daemon:

```bash
echo "$ADMIN_PW" | crane auth login harbor.lan -u admin --password-stdin
crane copy hello-world:latest harbor.lan/library/hello-world:v1
```

(If you ever do want the Docker daemon itself to push, the non-restart-free
options are: add `harbor.lan` to `insecure-registries`, or drop the CA at
`~/.docker/certs.d/harbor.lan/ca.crt` — both need a Docker Desktop restart.)

---

## Secrets & determinism under kustomize+helm

Because we render with `kustomize build --enable-helm` there is **no Helm release
state**, so anything the chart auto-generates would regenerate on every re-apply.
We pin the two that matter to out-of-band secrets (never in git):

```bash
# admin password (also stored in 1Password / Vaultwarden)
kubectl -n harbor create secret generic harbor-admin \
  --from-literal=HARBOR_ADMIN_PASSWORD='<pw>'
# data-at-rest encryption key — EXACTLY 16 chars, never rotate
kubectl -n harbor create secret generic harbor-secret-key \
  --from-literal=secretKey="$(openssl rand -hex 8)"
```

wired in values via `existingSecretAdminPassword` / `existingSecretSecretKey`.

- `secretKey` encrypts stored robot tokens / replication creds; if it changed, that
  data becomes unrecoverable. Its chart default is a *fixed* string (stable but
  insecure), so pinning it is about security **and** stability.
- The chart's internal trust tokens (`core`/`registry`/`jobservice`) still
  regenerate per render; on re-`apply` they rotate and bounce those pods —
  harmless (nothing at rest is encrypted with them). Pin
  `core.secret`/`core.xsrfKey`/`registry.secret`/`jobservice.secret` too if you
  want zero churn.

Recover the admin password from the cluster anytime:
```bash
kubectl -n harbor get secret harbor-admin -o jsonpath='{.data.HARBOR_ADMIN_PASSWORD}' | base64 -d
```

---

## Post-deploy validation we ran

1. **Health/login:** `GET /api/v2.0/health` all components healthy; admin creds →
   `GET /api/v2.0/users/current` 200.
2. **Push:** `crane copy hello-world → harbor.lan/library/hello-world:v1`; tag and
   digest confirmed via `crane ls` / `crane digest` and the Harbor API
   (`artifact_count: 1`).
3. **Persistence:** scaled `deploy/harbor-registry` to **0** (pod destroyed) then
   back to **1**; the image's digest was **identical** afterward — proving the data
   lives on the registry's persistent volume, not in the pod.

---

## Still open / follow-ups

- Run `scripts/trust-harbor-ca.sh` on the nodes so in-cluster pods can pull, then
  validate by scheduling a pod from `harbor.lan/library/hello-world`.
- Migrate the one image off the old built-in registry
  (`inference-club/nemotron-asr`) and repoint its manifest at `harbor.lan/...`.
- Decommission `clusters/home/registry/` and remove the stale `:30500` entry from
  each node's `registries.yaml`.
- Optionally back the admin password into Vaultwarden (needs a `bw`/`rbw` session).
