# Tailscale Kubernetes Operator

Exposes selected cluster services on the tailnet as `https://<name>.<tailnet>.ts.net`
with trusted HTTPS, reachable only from devices on the `briancaffey.github`
tailnet. Nothing is published to the public internet.

It's the same identity model you already use with `tsnet`: the operator joins
the tailnet as a tagged device and mints further tagged devices (one per exposed
Ingress) using an OAuth client instead of a hard-coded auth key.

## What it gives you

- `https://homepage.<tailnet>.ts.net` → Homepage (your remote front door)
- `https://grafana.<tailnet>.ts.net`  → Grafana
- Trusted certs on every device (phone/laptop) with no mkcert root to install.
- Access gated by your tailnet ACLs — only your authenticated devices.

## One-time setup in the Tailscale admin console (only you can do this)

### 1. Add tag owners to your ACL
Admin console → **Access Controls**, add to the policy file:

```jsonc
"tagOwners": {
  "tag:k8s-operator": [],
  "tag:k8s":          ["tag:k8s-operator"],
},
```

`tag:k8s-operator` = the operator's own device. `tag:k8s` = the per-service
proxy devices it creates.

Unless your policy is the default allow-all, you ALSO need a rule granting your
users access to `tag:k8s` — otherwise the proxy devices are filtered out of your
netmap (they won't resolve or connect). Add to `acls` (or the `grants`
equivalent):

```jsonc
{"action": "accept", "src": ["autogroup:member"], "dst": ["tag:k8s:*"]},
```

### 2. Enable HTTPS certificates
Admin console → **DNS** → enable **HTTPS Certificates** (MagicDNS is already on).
Required for the `*.ts.net` HTTPS to work.

### 3. Create an OAuth client
Admin console → **Settings → OAuth clients → Generate OAuth client**:
- Scopes: **Devices → Core: Write** and **Keys → Auth Keys: Write**
- Tags: **`tag:k8s-operator`** (selectable only after step 1)

Copy the **Client ID** and **Client Secret**.

## Install the operator (Helm)

Run this yourself so the secret never leaves your machine:

```bash
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm repo update
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --namespace tailscale --create-namespace \
  --set-string oauth.clientId="<CLIENT_ID>" \
  --set-string oauth.clientSecret="<CLIENT_SECRET>" \
  --wait
```

The operator registers a `tailscale` IngressClass and appears in the admin
console as a device tagged `tag:k8s-operator`.

## Expose the services

Homepage must accept the new Host header — already added to
`clusters/home/homepage/values.yaml` (`HOMEPAGE_ALLOWED_HOSTS`). Re-apply
Homepage, then apply the Ingresses:

```bash
# re-apply homepage so it accepts homepage.<tailnet>.ts.net
kubectl apply -k clusters/home/homepage

# create the two tailnet Ingresses (operator must be installed first)
kubectl apply -k clusters/home/tailscale
```

## Verify

```bash
kubectl get ingress -A | grep tailscale          # ADDRESS = the ts.net FQDN
tailscale status | grep -E 'grafana|homepage'     # the new proxy devices
curl -sI https://grafana.<tailnet>.ts.net        # expect 200/302 + valid cert
```

## What to expect / notes

- Each exposed Ingress = one small proxy pod (in `tailscale` ns) + one tailnet
  device. Fine for a handful of dashboards; don't expose all 30 services this way.
- These URLs work identically on LAN and remote (Tailscale picks direct vs relay).
- Grafana works for viewing as-is; for fully correct login redirects you can
  later set `GF_SERVER_ROOT_URL=https://grafana.<tailnet>.ts.net`.
- To expose another service: copy an Ingress file, set its namespace, backend
  service/port, and `tls.hosts[0]` (the subdomain), add it to kustomization.yaml.
- The operator is Helm-managed (not kustomize) because it ships CRDs/RBAC that
  track the chart version; the Ingresses (the part you'll edit often) stay in
  the repo as kustomize.
