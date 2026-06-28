# Harbor — private container registry

Replaces the built-in `registry:2` with [Harbor](https://goharbor.io/) at
<https://harbor.lan/>. Image blobs are stored on **a2's E drive** (ext4, ~5.4 TB)
via a static local PV; all Harbor pods are pinned to a2.

- Chart: `harbor/harbor` 1.19.1 (app 2.15.1), helm-via-kustomize.
- Storage: `storage.yaml` (StorageClass `e-local-a2` + PV `harbor-registry-e` →
  `/home/brian/e/k3s/volumes/harbor-registry` on a2).
- Exposure: Traefik ingress, `harbor.lan`, TLS via the `*.lan` mkcert wildcard.

## Deploy

### 1. Out-of-band secrets (never in git)
```bash
kubectl create namespace harbor

# admin password — ALSO save it in Vaultwarden ("Harbor admin")
kubectl -n harbor create secret generic harbor-admin \
  --from-literal=HARBOR_ADMIN_PASSWORD='<strong-password>'

# data-at-rest encryption key — EXACTLY 16 chars, never rotate it
kubectl -n harbor create secret generic harbor-secret-key \
  --from-literal=secretKey="$(openssl rand -hex 8)"

# TLS (harbor.lan already wired into scripts/lan-certs.sh)
bash scripts/lan-certs.sh        # creates harbor-tls in the harbor namespace
```

### 2. Apply
```bash
kustomize build --enable-helm clusters/home/harbor | kubectl apply -f -
kubectl -n harbor get pods                       # wait for all Running
kubectl -n harbor get pvc                        # registry PVC -> harbor-registry-e (e-local-a2)
```

### 3. DNS + node trust
- Add `192.168.5.173 harbor.lan` to `/etc/hosts` on client machines (Traefik
  routes to a2 regardless of which node IP you target).
- So that **pods and docker clients can pull/push** over the mkcert-signed cert,
  each node must trust the mkcert CA:
  ```bash
  for n in 192.168.5.96 192.168.5.173 192.168.6.19 192.168.5.253; do
    scp "$(mkcert -CAROOT)/rootCA.pem" brian@$n:/tmp/harbor-rootCA.pem
    ssh -t brian@$n 'sudo bash -s' < scripts/trust-harbor-ca.sh   # or copy + run
  done
  ```
  (Run `mkcert -install` once per laptop/desktop that will `docker login harbor.lan`.)

## Use it
```bash
docker login harbor.lan                          # admin / <password from Vaultwarden>
docker tag myimage:latest harbor.lan/library/myimage:latest
docker push harbor.lan/library/myimage:latest
```
In manifests: `image: harbor.lan/<project>/<repo>:<tag>`.

## Verify storage really lands on E (on a2)
```bash
du -sh /home/brian/e/k3s/volumes/harbor-registry   # grows as you push images
```

## Determinism caveat (kustomize + helm, no release state)
`secretKey` and the admin password are pinned to the secrets above, so they're
stable and your stored data stays decryptable across re-applies. The chart's
internal trust tokens (core/registry/jobservice) regenerate on each render, so a
re-`apply` rotates them and briefly restarts those pods — harmless. To eliminate
even that churn, pin `core.secret`, `core.xsrfKey`, `registry.secret`,
`jobservice.secret` (and `database.internal.password`) to fixed values too.

## Migration off the built-in registry
1. Copy the one existing image over (run where docker can reach both):
   ```bash
   skopeo copy --src-tls-verify=false \
     docker://192.168.5.173:30500/inference-club/nemotron-asr:<tag> \
     docker://harbor.lan/inference-club/nemotron-asr:<tag>
   ```
2. Repoint the nemotron-asr manifest image to `harbor.lan/...`.
3. Decommission `clusters/home/registry/` and remove the old `30500` block from
   each node's `registries.yaml`.
