# monitoring

Prometheus + Grafana for the home fleet, pinned to **a3**. Scrapes the vLLM
OpenAI server's `/metrics` endpoint and renders a vLLM engine dashboard.

All images are **upstream public** (`prom/prometheus`, `grafana/grafana-oss`)
pulled directly by k3s — nothing is built or pushed to a registry. Config and
dashboards live in ConfigMaps (see `config/` and `dashboards/`).

## Access (on the LAN)

| Service    | URL                          | NodePort |
|------------|------------------------------|----------|
| Grafana    | http://192.168.5.173:30030   | 30030    |
| Prometheus | http://192.168.5.173:30090   | 30090    |

`192.168.5.173` is a3. Grafana login is **`admin` / `changeme`** — change it on
first login (Profile → Change Password) and store the new password in 1Password.
The initial value lives in the `grafana-admin` secretGenerator in
`kustomization.yaml`.

## Apply / update

```bash
export KUBECONFIG=~/.kube/home-cluster.yaml
kubectl apply -k clusters/home/monitoring        # or: kubectl apply -k clusters/home
```

ConfigMaps use `disableNameSuffixHash: true` (stable names), so after editing
`config/*` or `dashboards/*` you must restart the consumer to pick it up:

```bash
kubectl -n monitoring rollout restart deploy/prometheus   # config/prometheus.yml, config/vllm-alerts.yml
kubectl -n monitoring rollout restart deploy/grafana      # datasource / dashboard-provider changes
```

(Grafana dashboard JSON is re-read every 10s, so dashboard edits don't need a restart.)

## Adding a vLLM target

Edit `config/prometheus.yml` → `scrape_configs[job_name=vllm].static_configs`,
add the new `IP:8000`, re-apply, and restart Prometheus. Metrics are
unauthenticated.

## Data

Both use node-local `local-path` PVCs on a3 (Prometheus 20Gi / 15d retention,
Grafana 2Gi). Because the data is node-local, the deployments are pinned to a3
via `nodeSelector: inference-club.com/box: a3` — don't remove that or a
reschedule would land on an empty volume.

## Notes

- vLLM metrics are prefixed `vllm:` (e.g. `vllm:kv_cache_usage_perc`,
  `vllm:time_to_first_token_seconds_bucket`). The NIM dashboards from
  `nvidia-nim-kit/nim-observability` use different metric names and won't work
  as-is.
- Alert rules (`config/vllm-alerts.yml`) only fire inside Prometheus; there's no
  Alertmanager wired up yet, so they're visible under Prometheus → Alerts but
  don't notify anywhere.
