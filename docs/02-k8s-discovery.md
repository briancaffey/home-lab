# Design: kubernetes-native service discovery for inference-club-agent

`agent.yaml` today is a hand-maintained map of hosts → services → models that
drifts from reality (see 01-inventory.md). When the agent runs inside k3s, the
cluster IS that map. The agent should read it from the k8s API and report a
manifest that's both more accurate and richer (exact image, full command with
flags, pod phase, restart counts, node GPU labels).

## What replaces agent.yaml

The answer to "what does agent.yaml look like in k3s": it shrinks to bootstrap
identity only — everything service-shaped moves to labels/annotations on the
Services themselves.

```yaml
# all of it — supplied via Helm values / env / Secret, no hosts: block at all
agent:
  name: club-host-k8s            # provider name (experimental account first)
  # api key via INFERENCE_CLUB_API_KEY from a k8s Secret
discovery:
  mode: kubernetes               # the new mode; "static" keeps old behavior
  namespace: inference-club      # watch scope
```

## Label & annotation schema (on each k8s Service)

Labels = selection + the few fields worth filtering on. Annotations = the
structured payload (models, features) that doesn't belong in label syntax.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: magpie-tts
  namespace: inference-club
  labels:
    inference-club.com/managed: "true"     # discovery selector — the ONLY required label
    inference-club.com/type: tts           # llm|stt|tts|image|mesh|music|video
    inference-club.com/engine: other       # vllm|lmstudio|other — same enum as agent.yaml
  annotations:
    # models: same fields the agent.yaml `models:` block carries today
    # (id/hf/name/input_modalities/output_modalities), YAML/JSON string.
    inference-club.com/models: |
      - id: magpie-tts-multilingual
    inference-club.com/features: "timestamps"        # comma list, optional
    inference-club.com/base-path: "/v1"              # appended to the svc URL
    inference-club.com/api-key-secret: "lmstudio-key" # optional: Secret name whose
                                                      # `api-key` key the agent sends
                                                      # upstream as a Bearer (stripped
                                                      # from the manifest, like today)
spec:
  selector: { app: magpie-tts }
  ports: [{ name: http, port: 9000 }]
```

Derived, not declared (this is the payoff):

| agent.yaml field (old) | k8s source (new) |
|---|---|
| `hosts[].address` / `hostname` | Pod's `spec.nodeName` → Node addresses |
| `hosts[].gpu.{vendor,model,vram_gb,count}` | Node labels from GPU-feature-discovery (`nvidia.com/gpu.product`, `nvidia.com/gpu.memory`, `nvidia.com/gpu.count`) |
| `services[].url` | `http://<svc>.<ns>.svc.cluster.local:<port>` + base-path annotation |
| `services[].command` (cosmetic, hand-typed) | Pod `spec.containers[].image` + `command` + `args` — exact and always true |
| — (never had) | pod phase, ready, restartCount, image digest, resource requests/limits |

## Non-k8s services (LM Studio on the spark host)

A selector-less Service + manual endpoint carries the same labels, so the agent
treats it uniformly — no special "external" code path:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: lmstudio
  namespace: inference-club
  labels: { inference-club.com/managed: "true", inference-club.com/type: llm,
            inference-club.com/engine: lmstudio }
  annotations:
    inference-club.com/base-path: "/v1"
    inference-club.com/api-key-secret: lmstudio-key
    inference-club.com/models: |
      - id: google/gemma-4-12b
        hf: google/gemma-4-12B
        input_modalities: [text, image, audio]
spec:
  ports: [{ port: 1234 }]
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: lmstudio-1
  namespace: inference-club
  labels: { kubernetes.io/service-name: lmstudio }
addressType: IPv4
ports: [{ port: 1234 }]
endpoints: [{ addresses: ["192.168.6.19"] }]
```

(External endpoints get no nodeName → the manifest reports them without GPU
metadata, same as agent.yaml's hand-typed blocks do today. Good enough.)

## Agent implementation sketch (inference-club-agent repo)

- `internal/discovery/` package with two implementations of one interface:
  `Static` (current agent.yaml parser, unchanged) and `Kubernetes`.
- `Kubernetes` (AS BUILT, 2026-06-11): stdlib-only REST against the cluster
  API — four namespace-scoped LISTs (services?labelSelector=managed, pods,
  endpointslices) + nodes, polled every 30s (AGENT_DISCOVERY_INTERVAL) with
  the built YAML byte-diffed so an unchanged cluster re-pushes nothing;
  SIGHUP forces an immediate re-list. client-go informers were considered and
  rejected: the dependency would dwarf the rest of the module for list-only
  polling at homelab scale. The builder produces the same manifest structs as
  the static parser → upload + router code untouched.
- Router targets: keep routing by `type` exactly as today; upstream URL is the
  Service DNS name (in-cluster, no NodePorts needed for east-west).
- RBAC (ships in the Helm chart): ServiceAccount + Role (services,
  endpointslices, pods, secrets[named only]: get/list/watch in
  `inference-club`) + ClusterRole (nodes: get/list/watch).
- Manifest extension: new optional `runtime` block per service (image, command,
  args, pod_phase, restarts, node) — additive, so `manifest_validator` on the
  backend accepts old agents unchanged; backend/CatalogModel work tracked in
  the inference.club repo when we want to DISPLAY it.

## Networking

- **East-west** (agent → services): cluster DNS, nothing to configure.
- **North-south** (backend → agent): the agent's listen port exposed via a
  LoadBalancer Service (k3s klipper ServiceLB binds it on node LAN IPs).
  - Local dev (AGENT_DIRECT): backend at 192.168.6.12 reaches
    `http://<any-node-LAN-IP>:8090`; advertise host = that node IP. Pin the LB
    to a3 via `svccontroller.k3s.cattle.io/lbpool` if we want a stable IP.
  - Prod (Phase 6): tailscale sidecar in the agent pod (or tailscale k8s
    operator) joins the tailnet exactly like today's docker agent; advertise
    the tailnet FQDN. No backend changes.

## Helm chart (lives in inference-club-agent: charts/inference-club-agent)

values: club URL, agent name, existingSecret (API key), discovery.mode,
discovery.namespace, service.type (LoadBalancer|NodePort), direct mode bool,
tailscale.enabled (Phase 6). Templates: Deployment, SA/Role/RoleBinding/
ClusterRole(Binding), Service, optional agent.yaml ConfigMap (static mode only,
for non-k8s users — chart serves both modes).
