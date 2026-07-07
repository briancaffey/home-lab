# Homepage — MANAGED BY ARGO CD (Application `home-homepage`)

Deployed as a multi-source Argo app: upstream chart
`jameswynn/helm-charts:homepage@2.1.0` + `values.yaml` here. **Never run
`helm upgrade` or `kubectl apply` for this dir** — edit values.yaml (or bump
`targetRevision` in `clusters/home/argocd/apps/home-services.yaml`) and push.

Private bits (tailnet name) live in the out-of-band `homepage-tailnet` Secret
(recreate command in values.yaml header; name in Vaultwarden `tailnet-name`).
The old gitignored values.local.yaml overlay is retired. Custom icons remain an
out-of-band configMap (`homepage-icons`, see values.yaml).
