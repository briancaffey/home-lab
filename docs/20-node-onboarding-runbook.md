# 20 — Node onboarding runbook

How to add a new node to the home k3s cluster, end to end. Written after the
t430 add (2026-07-08); supersedes the one-off `19-t430-node-onboarding` guide as
the *reusable* procedure. Covers amd64 laptops/desktops **and** arm64 boards
(Raspberry Pi, like spark).

> **The join is the easy part.** A node registers in one `curl | sh`. What makes
> it *stay healthy* is the prep — especially power-save on laptops. t430 joined,
> ran pods for 15 minutes, then went `NotReady` ("kubelet stopped posting")
> because it slept: the prep scripts hadn't been run. **Do the prep first.**

---

## 0. Naming & the box label

k3s names the node after its **hostname**, and we mirror that into the
`inference-club.com/box=<name>` label (workloads pin to nodes with it).

| series | meaning | examples |
|--------|---------|----------|
| `a1`–`a3` | amd64 desktop, RTX 4090 | GPU inference + control plane (a3) |
| `spark`   | arm64 DGX Spark, GPU | arm64 workloads |
| `x1`      | amd64 CPU laptop (ThinkPad) | Hermes home |
| `t430`    | amd64 CPU laptop | (this add) |
| `p1`, `p2`… | **arm64 Raspberry Pi** (suggested) | light/edge workloads |

**Rule: the hostname must be unique and must NOT collide with an existing node.**
The classic trap (t430) is a **cloned system drive** that boots with the donor
machine's hostname (e.g. `a3`) — rename before joining or you fight the real node.

---

## 1. Decisions before you start

- **Architecture?** `amd64` (laptops/desktops) or `arm64` (Pi/spark). k3s is
  multi-arch and the join command is identical — but see §7 for the arm64
  scheduling caveat (our `apps/` images are amd64-only).
- **Reused/cloned drive?** If yes, you MUST purge the donor's k3s + rename (§2).
- **Disk size?** Small single-disk nodes (Pi SD card, the t430's 100 GB) keep the
  **default** k3s data-dir. Do NOT copy a3's `--data-dir=/mnt/d/k3s-data` move —
  that was a3-specific (second disk). Images live on root; watch usage.
- **OS on Pis:** use **Ubuntu Server 24.04 arm64**, not Raspberry Pi OS — the prep
  scripts assume `systemd-resolved` + NetworkManager (Pi OS uses dhcpcd and
  breaks `trust-lan-ca.sh`'s split-DNS step).

---

## 2. Prepare the OS (on the node)

```bash
# a) If this is a CLONED drive: purge the donor's k3s + cluster identity FIRST
sudo /usr/local/bin/k3s-uninstall.sh 2>/dev/null || true
sudo /usr/local/bin/k3s-agent-uninstall.sh 2>/dev/null || true
sudo rm -rf /etc/rancher /var/lib/rancher /var/lib/kubelet
which k3s || echo clean

# b) Set a unique hostname (k3s uses it as the node name)
sudo hostnamectl set-hostname <name>       # e.g. x2, p1 — NOT an existing node
sudo sed -i "s/\b<old-hostname>\b/<name>/g" /etc/hosts   # fix 127.0.1.1 line
# re-login or reboot so it takes

# c) Reclaim disk if the drive came from a GPU box (no GPU here):
#    remove the CUDA/NVIDIA apt SOURCE (stops recurring heavy upgrades), then purge
sudo rm -f /etc/apt/sources.list.d/*cuda*.list /etc/apt/sources.list.d/*nvidia*.list
sudo apt-get update
sudo apt-get purge -y '^nvidia-.*' '^libnvidia-.*' '^cuda.*' '^libcudnn.*' 'nvidia-container*'
sudo apt-get autoremove --purge -y && sudo apt-get clean
sudo du -x -h --max-depth=2 / 2>/dev/null | sort -rh | head -20   # hunt leftover models
```

## 3. Router (eero)

- Add a **DHCP reservation** so the node's IP is stable. Any of the LAN subnets
  works — a3/others are `192.168.5.x`, spark is `192.168.6.19`, t430 is
  `192.168.4.33`. The eero routes between them, so a different `/24` is fine (§6).
- Give it a nickname matching the hostname.

## 4. Prep scripts — run BEFORE the join, in this order

From your laptop repo (`~/git/home-cluster`), against `<ip>`:

```bash
for s in node-sudoers node-powersave node-sysctls node-hosts; do
  ssh brian@<ip> "sudo bash -s" < scripts/$s.sh
done
scp "$(mkcert -CAROOT)/rootCA.pem" brian@<ip>:/tmp/lan-rootCA.pem
ssh brian@<ip> "sudo bash -s" < scripts/trust-lan-ca.sh
```

| script | what it fixes | note |
|--------|---------------|------|
| `node-sudoers.sh` | passwordless sudo for `brian` | run first — makes the rest unattended |
| `node-powersave.sh` | ⭐ **mask sleep/suspend, lid=ignore, WiFi power-save off** | **the reason t430 went NotReady.** Mandatory on every laptop. |
| `node-sysctls.sh` | inotify limits (jellyfin crashloop fix) | |
| `node-hosts.sh` | static `harbor.lan → 192.168.5.173` | breaks the Pi-hole-outage pull deadlock |
| `trust-lan-ca.sh` | mkcert CA in OS trust + `.lan` split-DNS → Pi-hole | self-verifies against `home.lan` |

> SSH keys: `ssh-copy-id brian@<ip>` for password-less in; generate a key on the
> node and authorize it on the others for out.

## 5. Join as an agent

```bash
# token lives on a3 at the MOVED data-dir path:
ssh brian@192.168.5.173 sudo cat /mnt/d/k3s-data/server/node-token

# on the NEW node — pin the version to match the server exactly:
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.35.5+k3s1 \
  K3S_URL=https://192.168.5.173:6443 K3S_TOKEN='<token>' \
  sh -s - agent --node-label inference-club.com/box=<name>
```

> **Agent, not server.** Second control planes mean SQLite→etcd HA migration and
> want wired + fast disks — never a WiFi laptop or a Pi. HA later, on desktops.

## 6. Reachability (if the node is on a different /24)

Run on the node before/after joining:
```bash
nc -vz 192.168.5.173 6443     # k3s API — must pass or the join can't work
nc -vz 192.168.5.173 443      # harbor.lan / Traefik ingress
```
Cross-subnet is fine (spark on `.6.x` proves it); this just catches routing gaps early.

## 7. Harbor pull trust (after the agent is up)

```bash
scp "$(mkcert -CAROOT)/rootCA.pem" brian@<ip>:/tmp/lan-rootCA.pem
ssh brian@<ip> "sudo bash -s" < scripts/k3s-registries.sh
```
Points containerd at Harbor's proxy cache + pins its CA, restarts the agent.

## 8. Post-join verification & guardrails (from your laptop)

```bash
kubectl get nodes -o wide                       # <name> Ready, right IP, v1.35.5+k3s1
kubectl get node <name> -o jsonpath='{.metadata.labels}' | tr , '\n' | grep -E 'box|arch'
```

- **Ready, then flaps to NotReady?** → power-save (§4) wasn't applied, or WiFi
  drop. On a laptop this is the #1 cause. Wake it, run `node-powersave.sh`.
- **arm64 nodes (Pi/spark) — scheduling guardrail:** our `apps/` images (built by
  the Forgejo dind runner) are **amd64-only**. Any pod without an arch constraint
  that lands on an arm64 node fails (`exec format error` / ImagePullBackOff).
  Workloads already pin `kubernetes.io/arch: amd64` where needed — verify new
  ones do before an arm64 node exists. When in doubt, **taint the Pi** and opt
  workloads in:
  ```bash
  kubectl taint node p1 arch=arm64:NoSchedule
  # pods that should run on it add a matching toleration + arm64 nodeSelector
  ```
- **Weak nodes (Pi, old laptops):** don't enroll in Longhorn; keep heavy/write-
  heavy PVCs off SD cards; let only light or arch-agnostic pods land there.

## 9. Observability — mostly automatic, ONE manual step

Node-level observability agents are **DaemonSets**, so k8s schedules one onto the
new node automatically the moment it's Ready — no ArgoCD/deploy change needed:

| tool | how it reaches the node | new-node action |
|------|------------------------|-----------------|
| `scrutiny-collector` (SMART/disk health) | DaemonSet, **pushes** to scrutiny-web tagged `COLLECTOR_HOST_ID=spec.nodeName` | none — appears at `scrutiny.lan` under the node's name |
| `netdata-child` | DaemonSet, streams to netdata-parent | none |
| `loki-promtail` | DaemonSet, pushes logs to Loki | none |
| `nfd-worker` | DaemonSet | none |
| GPU: `dcgm`, `vram-reporter`, `nvidia-device-plugin` | DaemonSet + GPU-label affinity | none — correctly SKIP non-GPU nodes |
| **`node-exporter` → Prometheus** | DaemonSet runs, but Prometheus scrapes via **`static_configs`** | ⚠️ **MANUAL: add the node's target** |

> **The one manual step:** the monitoring stack is hand-rolled Prometheus with
> `static_configs` (no service discovery), so a new node's node-exporter is *not*
> scraped until you add it to `clusters/home/monitoring/config/prometheus.yml`
> under `job_name: node`:
> ```yaml
>       - targets: ["<node-ip>:9100"]   # <name>
>         labels: { node: <name> }
> ```
> The `prometheus-config` ConfigMap has `reloader.stakater.com/auto: true`, so
> once ArgoCD syncs the change Prometheus restarts itself and Grafana picks up the
> node — no manual rollout. (Leave GPU jobs `dcgm`/`gpu-vram` alone for CPU nodes.)

---

## Gotchas by node type

| node type | watch out for |
|-----------|---------------|
| **any laptop** | sleep/lid/WiFi-powersave → `NotReady`. `node-powersave.sh` is mandatory. |
| **cloned drive** | donor hostname collision + leftover k3s. Purge + rename first (§2). |
| **arm64 (Pi/spark)** | amd64-only `apps/` images won't run — pin/taint. Use Ubuntu Server, not Pi OS. |
| **small disk** | keep default data-dir; images fill root — prune, don't relocate. |
| **different /24** | fine (eero routes) but run the §6 reachability check. |

## Quick reference

```
server / API : https://192.168.5.173:6443   (a3, sole control plane)
node token   : a3:/mnt/d/k3s-data/server/node-token   (data-dir was moved off root)
k3s version  : v1.35.5+k3s1   (pin INSTALL_K3S_VERSION to match)
box label    : inference-club.com/box=<hostname>
prep scripts : scripts/node-{sudoers,powersave,sysctls,hosts}.sh, trust-lan-ca.sh, k3s-registries.sh
```
