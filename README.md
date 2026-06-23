# home-lab

Brian's home inference fleet, migrating from hand-run docker containers to
k3s. Four Ubuntu boxes on one LAN, registered to inference.club via the
inference-club-agent.

| node  | LAN IP        | arch    | GPU             | role                      |
|-------|---------------|---------|-----------------|---------------------------|
| a3    | 192.168.5.173 | amd64   | RTX 4090        | k3s server (control plane) + workloads |
| a1    | 192.168.5.253 | amd64   | RTX 4090        | k3s agent                 |
| a2    | 192.168.5.96  | amd64   | RTX 4090        | k3s agent (⚠ needs reboot: NVML driver mismatch) |
| spark | 192.168.6.19  | arm64   | DGX Spark (GB10)| k3s agent                 |

**👉 What's running & how to reach it on the LAN:** [docs/05-service-directory.md](docs/05-service-directory.md)

## Layout

```
docs/      00-plan.md            master plan: decisions, phases, requirements
           01-inventory.md       captured state of every box and service (pre-migration)
           02-k8s-discovery.md   design: agent discovers services from the k8s API
clusters/  home/                 cluster-scoped kustomize (namespace, GPU runtime, device plugin)
services/  <name>/               one kustomize base per inference service as it migrates
scripts/   install-k3s-*.sh      node bootstrap (run with sudo on each box)
article/   draft.md              "from docker sprawl to k3s" write-up, grows with the migration
```

## Related repos

- [inference-club-agent](https://github.com/briancaffey/inference-club-agent) —
  the agent itself; grows a `kubernetes` discovery mode and a Helm chart
  (chart lives THERE so any provider can use it; this repo only holds values).
- [inference.club](https://github.com/inference-club/inference.club) — the platform.
