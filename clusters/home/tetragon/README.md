# Tetragon — runtime security for the home cluster

eBPF sensor on every node: sees every process start, plus whatever kernel
hooks the policies in `policies/` ask for, tagged with pod identity, filtered
in the kernel. Report and rationale: [`docs/23-tetragon-runtime-security.html`](../../../docs/23-tetragon-runtime-security.html).

| piece | where |
|---|---|
| Agent DaemonSet + operator (chart `cilium/tetragon` 1.8.0) | `kustomization.yaml`, `values.yaml` |
| Detection policies (post-only, cannot break anything) | `policies/` |
| Enforcement policy (kills; NOT wired into any kustomization) | `enforce/` |
| Argo CD Application `home-tetragon` | `../argocd/apps/home-services.yaml` |
| Prometheus scrape job `tetragon` + alert rules | `../monitoring/config/prometheus.yml`, `tetragon-alerts.yml` |
| Events in Loki | `{namespace="tetragon", container="export-stdout"}` (promtail picks them up, nothing to configure) |

**Status (2026-11-24):** phase 1 is live. Agents run 2/2 on all seven nodes
(kernels 6.8, 7.0 and spark's 7.0-nvidia), all seven scrape targets are up,
events reach Loki, zero ring-buffer loss, ~170–200 Mi per agent. The policies
in `policies/` and `enforce/` are schema-valid but have **never been loaded**
— the "verify" items under phases 2 and 3 are still real unknowns.

Open item from day one: each event carries ~6.3 KB of `node_labels` (see the
note in `values.yaml`); strip it in promtail before leaving this running for
months, since Loki has no retention.

`t` below is shorthand for a shell on one agent:

```bash
alias t='kubectl -n tetragon exec ds/tetragon -c tetragon --'
# a specific node:
kubectl -n tetragon get pods -o wide -l app.kubernetes.io/name=tetragon
```

## Phase 0 — pre-flight (5 min, per node)

```bash
ls /sys/kernel/btf/vmlinux                 # BTF present (required)
uname -r                                   # 5.10+ on spark (arm64)
ss -ltnp | grep -E ':2112|:6789'           # agent is hostNetwork: ports must be free
```

Spark runs NVIDIA's DGX OS kernel, not the Ubuntu HWE line — it is the node
most likely to surprise you. If its agent crash-loops, pin the DaemonSet off
it with `nodeSelector`/`affinity` in `values.yaml` and carry on.

## Phase 1 — observe (week 1)

Merge this branch with the `- policies` line in `kustomization.yaml` still
commented. Argo syncs the namespace, CRDs, agent and operator.

```bash
kubectl -n tetragon get pods -o wide       # one agent per node, 2/2
t tetra probe                              # what THIS kernel supports (override, signal, lsm)
t tetra getevents -o compact               # live stream; then in another shell:
kubectl -n vaultwarden exec deploy/vaultwarden -- ls /data
```

You should see the `ls` appear with its pod, namespace and parent process.
That is the whole point of phase 1: learn what normal looks like.

Things to look for in Grafana → Explore → Loki:

```logql
# every shell started inside a pod (kubectl exec, entrypoint scripts, exploits)
{namespace="tetragon", container="export-stdout"} | json
  | process_exec_process_binary =~ ".*/(sh|bash|ash|dash)$"

# anything executed out of /tmp or /dev/shm
{namespace="tetragon", container="export-stdout"} | json
  | process_exec_process_binary =~ "^/(tmp|dev/shm)/.*"

# what runs in the host PID namespace / with CAP_SYS_ADMIN (audit L1)
{namespace="tetragon", container="export-stdout"} |= "CAP_SYS_ADMIN" | json
```

Verify before moving on:

- [ ] agents healthy on all nodes incl. spark; `up{job="tetragon"} == 1`
- [x] export volume measured: ~4.6 GB/day raw after tuning (was ~17). Loki's
      data dir sits on a3's 1.8 T disk (the 10Gi PVC size is not enforced by
      local-path) with no retention — strip `node_labels`, then recheck.
- [ ] agent memory after a week vs the 1Gi limit (first hour: 170–200 Mi)
- [ ] the redaction filters actually mask a `--password=...` test command

## Phase 2 — detect (weeks 2–3)

Uncomment `- policies` in `kustomization.yaml`. Better: enable them one at a
time by commenting entries in `policies/kustomization.yaml`, quietest first
(04 → 01 → 02 → 05 → 03 → 06).

```bash
t tetra tracingpolicy list                 # STATE must be enabled on every node
```

Then trip each one on purpose — a detection you have never seen fire is a
detection you don't have:

| policy | how to trip it | alert |
|---|---|---|
| `sa-token-read` | in any pod that mounts a token: `kubectl -n <ns> exec <pod> -- cat /var/run/secrets/kubernetes.io/serviceaccount/token` | ServiceAccountTokenReadByShell |
| `k3s-crown-jewels` | on a3: `sudo head -c1 /var/lib/rancher/k3s/server/token` | K3sControlPlaneSecretRead |
| `host-persistence` | on any node: `sudo touch /etc/cron.d/tetragon-test && sudo rm /etc/cron.d/tetragon-test` — `touch` may not issue a write(); if silent use `echo x \| sudo tee` | HostPersistenceWrite |
| `monitor-kernel-modules` | `sudo modprobe dummy && sudo modprobe -r dummy` | KernelModuleLoaded |
| `pod-privilege-escalation` | in a non-root pod with `su`: `su -` (will fail, still fires) | PodPrivilegeEscalation |
| `pod-internet-egress` | `kubectl run t --rm -it --image=curlimages/curl -- curl -sI https://example.com` | none (inventory) |

Verify (unknowns that only the live cluster answers):

- [ ] which path the token read reports (`/run/...` vs `/var/run/...`) — both are listed
- [ ] the binary path k3s reports for itself; if the server shows up in
      `k3s-crown-jewels`, add its path to `matchBinaries`
- [ ] `matchBinaries` value counts are accepted (8 in `sa-token-read`)
- [ ] `__sys_setuid` / `__sys_setresuid` / `create_user_ns` exist on the 7.0
      kernels — if not, policy 05 shows `load_error` and the alert fires
- [ ] namespace exclusion in 06 actually silences qbittorrent

Known limit: without Tetragon's runtime hooks (`rthooks`, off here), pod and
namespace filtering is applied best-effort from the Kubernetes API, so the
first instants of a brand-new container can be missed. Fine for detection;
revisit before relying on enforcement for short-lived pods.

## Phase 3 — enforce (week 4+, one namespace)

`enforce/vaultwarden-data-guard.yaml`: only `/vaultwarden` may touch `/data`.
It ships in **monitor mode** — it reports what it would have blocked.

```bash
kubectl apply -f clusters/home/tetragon/enforce/vaultwarden-data-guard.yaml
t tetra tracingpolicy list                 # MODE column: monitor
kubectl -n vaultwarden exec deploy/vaultwarden -- cat /data/rsa_key.pem >/dev/null
# -> succeeds (monitor), TetragonEnforcementAction fires with action=monitor_*
```

Leave it two weeks, across a Vaultwarden restart, an image update and several
nightly backups. If the only `monitor_*` actions are your own tests:

```bash
t tetra tracingpolicy set-mode --namespace vaultwarden vaultwarden-data-guard enforce
kubectl -n vaultwarden exec deploy/vaultwarden -- cat /data/rsa_key.pem
# -> command terminated (137); vault.lan still serves
```

`set-mode` talks to the one agent you exec into — use the pod on a3 (where
Vaultwarden lives). Treat it as a trial switch; once happy change `policy-mode` to `enforce` in the
file and add it to a kustomization so git is the truth again.

**Break-glass:** `kubectl delete tracingpolicynamespaced -n vaultwarden vaultwarden-data-guard`.
Bigger hammer: `kubectl -n tetragon delete ds tetragon` — persistent
enforcement (`enableKeepSensorsOnExit`) is off, so policies unload with the agent.

## Upgrades

Renovate will open chart bumps (`helmCharts` version). Before merging a minor:
read the release notes for removed actions/renamed fields, re-run
`kustomize build --enable-helm` and watch `TetragonPolicyLoadError` after the
rollout. Same drill after any node kernel bump.
