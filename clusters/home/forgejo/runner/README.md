# Forgejo Actions runner (in-cluster, a2)

Runner + privileged dind sidecar; jobs are containers on the pod-local docker
daemon (host network → `localhost:2376`). Layer cache and registration state
persist on local-path PVCs pinned to a2. **Never build on a1.**

## One-time secrets (in-cluster only, never committed)

```sh
# registration token: mint in the pod (or Forgejo UI → Site administration → Actions → Runners)
TOKEN=$(kubectl exec -n forgejo deploy/forgejo -- \
  su git -c "forgejo --config /data/gitea/conf/app.ini actions generate-runner-token")
kubectl -n forgejo create secret generic forgejo-runner-token --from-literal=token="$TOKEN"

# mkcert CA — runner registers/clones via forgejo.lan, dind pushes to harbor.lan
kubectl -n forgejo create secret generic lan-ca \
  --from-file=rootCA.pem="$(mkcert -CAROOT)/rootCA.pem"
```

## Apply

```sh
kubectl apply -k clusters/home/forgejo/runner
```

The token is consumed on first registration; `.runner` on the PVC keeps the
identity across restarts (no zombie runner entries). To re-register from
scratch: delete `.runner` on the PVC, refresh the token secret, restart.

## Labels

`runs-on: docker` (or `ubuntu-latest`) → `ghcr.io/catthehacker/ubuntu:act-22.04`
— has node, git and the docker CLI, so checkout + `docker build`/`push` work in
one image. Jobs get `DOCKER_HOST`/TLS + mkcert CA injected via
`runner/config.yaml`.
