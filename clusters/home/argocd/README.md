# Argo CD — GitOps CD for the cluster (home-lab#29)

Upstream non-HA install (pinned in `kustomization.yaml`), UI at
<https://argocd.lan/> behind Traefik (TLS terminated at the ingress;
`server.insecure=true` keeps the backend plain HTTP).

## Apply / upgrade

```sh
kubectl apply -k clusters/home/argocd --server-side
bash scripts/lan-certs.sh   # argocd-tls secret + mkcert CA into argocd-tls-certs-cm
```

`--server-side` is required — the CRDs blow past the client-side annotation
size limit. **Re-applying resets `argocd-tls-certs-cm` to empty** (upstream
ships it empty), which breaks cloning from `https://forgejo.lan` — always
re-run `scripts/lan-certs.sh` after an apply/upgrade.

## Login

Initial `admin` password (then change it in the UI and delete the secret):

```sh
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

## Applications

`apps/` holds the Application CRs (one per deployed app), applied separately
so CRDs exist first:

```sh
kubectl apply -k clusters/home/argocd/apps
```

Argo CD polls repos every ~3 min; the Forgejo webhook
(`https://argocd.lan/api/webhook`) makes syncs instant.
