# cluster-scoped config (`clusters/home`)

Cluster-wide kustomize bases. Two flavours live here:

- **Raw manifests** wired into `kustomization.yaml` (namespaces, `gpu`,
  `monitoring`) — applied the usual way: `kubectl apply -k clusters/home`.
- **Helm-via-kustomize** bases (`headlamp`, `homepage`, `loki`) — opt-in,
  applied individually. They are intentionally **not** wired into the top-level
  `kustomization.yaml` so the plain `kubectl apply -k` flow keeps working.

## LAN service access pattern

Services are reached by name over HTTPS on the LAN, e.g. `https://headlamp.lan/`:

1. **Traefik** (k3s built-in) is the single ingress on ports 80/443 of every node.
2. Each service is a `ClusterIP` + `Ingress` (class `traefik`) for `<name>.lan`.
3. **TLS**: a local **mkcert** CA. Run `scripts/lan-certs.sh` to (re)issue the
   leaf cert and create the `*-tls` secrets. Run `mkcert -install` once per
   client machine to trust the CA. Keys never enter git (see `.gitignore`).
4. **DNS**: client-side only — add `192.168.5.173  <name>.lan` to `/etc/hosts`
   on the machine(s) that need it (no network DNS changes).
5. **Homepage discovery**: add to the ingress
   `labels: { gethomepage.dev/enabled: "true" }` plus
   `annotations: gethomepage.dev/{name,group,icon,href}` and it auto-appears.

## Apply

```sh
# prerequisite: TLS secrets
bash scripts/lan-certs.sh

# raw cluster config (namespaces, gpu, monitoring incl. Grafana+Loki datasource)
kubectl apply -k clusters/home

# Helm-based apps (standalone kustomize binary; kubectl's embedded one is too old)
kustomize build --enable-helm clusters/home/headlamp | kubectl apply -f -
kustomize build --enable-helm clusters/home/homepage | kubectl apply -f -
kustomize build --enable-helm clusters/home/loki     | kubectl apply -f -
```

| service  | URL                   | notes                                  |
|----------|-----------------------|----------------------------------------|
| Homepage | https://home.lan/     | auto-discovers labeled ingresses       |
| Headlamp | https://headlamp.lan/ | k8s dashboard, no-login (LAN only)     |
| Grafana  | https://grafana.lan/  | + Loki logs datasource, NVIDIA DCGM dash|

> **One-time transition note:** these three apps were first installed
> imperatively with `helm install`. Applying the kustomize render above adopts
> the same objects under `kubectl`. To stop double-management, clear the old
> Helm bookkeeping (does NOT delete the workloads):
> `kubectl -n <ns> delete secret -l owner=helm,name=<release>`.
