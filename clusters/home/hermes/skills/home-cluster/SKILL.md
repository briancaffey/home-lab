---
name: home-cluster
description: "Operate Brian's k3s home cluster: inspect anything, scale/restart/deploy inference workloads in the inference-club namespace. Use for any request about the Kubernetes cluster, nodes, GPUs, pods, or services."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    tags: [kubernetes, k3s, cluster, gpu, vllm, infrastructure]
    related_skills: []
---

# home-cluster: operate the k3s home cluster

You run inside this cluster (namespace `hermes`, node `x1`). `kubectl` is on
PATH and authenticates automatically via your ServiceAccount — never look for
a kubeconfig.

## Your permissions

- **Read everywhere**: pods, deployments, services, ingresses, nodes, PVCs,
  events, metrics (`kubectl top`), CRDs (traefik, longhorn). Secrets are NOT
  readable outside inference-club — don't try.
- **Write ONLY in `inference-club`**: scale, restart, patch, create, delete
  workloads there. Everything else (kube-system, monitoring, harbor, …) is
  read-only by design — if a task needs write access elsewhere, say so
  instead of retrying.

## Cluster topology

| node  | arch  | GPU                     | notes |
|-------|-------|-------------------------|-------|
| a3    | amd64 | RTX 4090 (24 GB)        | control plane — treat gently |
| a1    | amd64 | RTX 4090 (24 GB)        | flaky WiFi: avoid big image pulls |
| a2    | amd64 | RTX 4090 (24 GB)        | most free disk |
| spark | arm64 | GB10 (128 GB unified)   | often offline |
| x1    | amd64 | none                    | CPU box — you live here |

Pods pin to a node with `nodeSelector: { inference-club.com/box: <name> }`.

## Conventions (respect these when creating/editing workloads)

- GPU pods: `runtimeClassName: nvidia`. Exclusive use =
  `resources.limits: { nvidia.com/gpu: 1 }`; shared use =
  `NVIDIA_VISIBLE_DEVICES=all` env and NO gpu resource request.
- One RTX 4090 has 24 GB VRAM. Before scheduling a GPU workload, check what
  is already on that node's GPU (see Playbook) — the scheduler does not
  account for shared-mode VRAM.
- Storage is `local-path` (node-local): a PVC pins its pod to one node forever.
- Inference services live in `inference-club`; most are vLLM or similar model
  servers, one Deployment each.

## Playbook

```sh
# What's in the cluster / is anything unhealthy?
kubectl get pods -A -o wide | grep -v Running
kubectl get events -A --sort-by=.lastTimestamp | tail -20

# Node capacity / who has GPU headroom?
kubectl top nodes
kubectl get pods -n inference-club -o wide            # what runs where
kubectl get pods -A -o json | grep -o '"nvidia.com/gpu": *"[0-9]*"'   # exclusive GPU claims

# Scale a service up/down (e.g. an inference deployment)
kubectl -n inference-club scale deploy/<name> --replicas=<n>

# Restart a wedged service
kubectl -n inference-club rollout restart deploy/<name>
kubectl -n inference-club rollout status deploy/<name>

# Logs / describe when debugging
kubectl -n inference-club logs deploy/<name> --tail=100
kubectl -n inference-club describe pod -l app=<name>
```

## Ground rules

- The git repo `home-cluster` is the source of truth. Ad-hoc `kubectl` changes
  (scale, image bumps) are fine for operations, but tell the user what you
  changed so the repo can be updated — flag it explicitly in your reply.
- Never delete PVCs or namespaces without the user confirming in this
  conversation.
- Scaling a GPU deployment above replicas=1 usually makes no sense (one GPU
  per node, exclusive) — ask, don't assume.
- If a pod won't schedule, check `kubectl describe pod` events first
  (GPU taken, nodeSelector mismatch, PVC on another node are the usual causes).
