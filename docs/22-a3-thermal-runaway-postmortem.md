# 22 — a3 thermal runaway postmortem (2026-09-22)

**Symptom:** a3 (the sole k3s control plane, i9-14900K + RTX 4090) was hot to the
touch with hot air blowing out, unreachable over SSH, and the cluster API was
degraded. Brian hard-powered it at 18:22 EDT.

**Verdict:** not a fan, dust, or GPU problem. A **Linux kernel bug on 6.17.0-14**
put two CPU cores into an infinite loop *inside the kernel* at 09:15 EDT. They
spun at full turbo clock for **9 hours 7 minutes** (the kernel's own watchdog
line: `soft lockup - CPU#12 stuck for 30629s`), which is the heat. The same
lockup held a core networking lock, so SSH and the node's network stack died
with it, and nothing on the box was configured to reboot on a lockup.

## Timeline (EDT, from a3's journal of the previous boot)

| time | event |
|------|-------|
| 01:46 | a3 boots (this was already the 4th boot in 2 days) |
| 04:38 | first kernel WARNING involving a root `fuser` process (RCU stall) |
| 09:14:49 | Intel WiFi firmware crashes and restarts (`iwlwifi ... Hardware restart was requested`) |
| 09:15:14 | `watchdog: BUG: soft lockup - CPU#12 stuck for 26s! [kubectl]` and `CPU#25 stuck for 26s! [fuser]` — both in `mas_walk` (maple-tree VMA walk) via `lock_vma_under_rcu` / `lock_next_vma` |
| 09:17:04 | hung-task reports: `khugepaged`, `NetworkManager`, `k3s-server` (blocked on `rtnl_lock`), `node_exporter` (thermal sysfs mutex) all stuck >122 s |
| 09:15 → 18:22 | k3s logs `Network Policy Controller heartbeat missed` every second; containerd `StopContainer ... context deadline exceeded` every few minutes; two CPUs at 100% kernel time |
| 18:22:54 | last log line: `soft lockup - CPU#12 stuck for 30629s!` — hard power-off |
| 18:23 | reboot; investigation starts |

## Root cause

1. **Kernel bug (the trigger).** Kernel 6.17 reads `/proc/PID/maps` under
   per-VMA locks + RCU instead of the mmap lock. A root `fuser` process was
   scanning every process's `/proc/*/maps` while a `kubectl` process was
   page-faulting; both ended up looping forever in the maple-tree walk
   (`mas_walk` / `mas_next_slot`). Stack traces are in the appendix. This code
   path was reworked in later kernels; a3 was on **6.17.0-14 with no kernel
   meta-package installed**, so it never received any 6.17 point releases or
   the 24.04 HWE move to 7.0 (a1 has been on 7.0.0-30 for 3+ weeks without a
   single lockup).
2. **No guard rails (why it lasted 9 hours).** `kernel.softlockup_panic=0`,
   no hardware watchdog loaded, no alert for "CPU pinned in kernel mode" or
   "node temperature". A lockup on a headless box is a space heater until a
   human walks over.
3. **Contributing: CPU out of spec.** The 14900K was running BIOS microcode
   `0x11d` (BIOS 0220, Sept 2023) because the `intel-microcode` package had been
   removed. The kernel flagged it at every boot (`x86/CPU: Running old
   microcode`, taint `S = CPU_OUT_OF_SPEC`). That is the pre-fix microcode for
   the Raptor Lake Vmin-instability degradation issue. Not the cause of the
   lockup, but a real reliability risk on exactly this CPU.

**Ruled out:** GPU (idle, 31 °C after reboot), memory (52 GB free), disk
health (WD 6 TB SMART clean, 0 reallocated), thermal throttling as a *cause*
(temperatures were the effect), a runaway pod (the spinning threads were
kernel-side).

**What ran `fuser`?** Not conclusively identified. It ran as root (UID 0) at
04:38 and 09:15. Pods on a3 that ship the `fuser` binary: the inference-club
agent, scrutiny-collector, local-path-provisioner. It does not matter for the
fix: reading `/proc/PID/maps` is legitimate; the kernel must not hang on it.

## Secondary finding: a3's disk layout

k3s `data-dir` is `/mnt/d/k3s-data` on a **5400 rpm WD HDD** (the SQLite DB is
already bind-mounted from the SSD at `/opt/k3s-db`, good). That means
containerd's image store, every container's writable layer, and the 14 GB of
`local-path` PVs (Postgres ×3, ClickHouse, Prometheus, Qdrant, Redis…) all
live on the spinning disk. After the reboot the node sat at ~50% PSI "full"
I/O stall for 15 minutes while everything restarted, and the Longhorn
`dia-models` RWX volume streamed 26 MB/s at 330 ms latency over WiFi. This is
why probes time out and pods look flaky after every reboot on a3. **Not the
cause of the heat**, but it is the next reliability item — see follow-ups.

## Fix (deployed 2026-09-22)

### On the nodes — `scripts/node-lockup-guard.sh` (run on a1, a2, a3, t430)

| layer | setting | effect |
|-------|---------|--------|
| sysctl | `kernel.softlockup_panic=1`, `hardlockup_panic=1`, `watchdog_thresh=30`, `panic=15` | a CPU stuck in the kernel for 60 s panics; the box reboots 15 s later instead of spinning for hours |
| hardware watchdog | `iTCO_wdt` (Intel PCH TCO) + systemd `RuntimeWatchdogSec=120` | if even PID 1 stops running, the chipset resets the board |
| microcode | `intel-microcode` reinstalled (06-b7-01 → current) | 14900K gets Intel's stability microcode from the OS loader at boot |
| kernel (a3 only, `--kernel`) | `linux-generic-hwe-24.04` → **7.0.0-34** | off the buggy 6.17.0-14; the meta-package keeps it patched. 6.17 and 6.14 kept in GRUB as fallbacks. NVIDIA 580.173 DKMS built cleanly for 7.0. |

### In the cluster — Prometheus rules (`clusters/home/monitoring/config/homelab-alerts.yml`, group `node-runaway`)

| alert | fires when | severity |
|-------|------------|----------|
| `NodeCPUStuckInKernel` | any single CPU >95% kernel time for 10 m | critical |
| `NodeHighTemperature` | any coretemp sensor >95 °C for 10 m | warning |
| `NodeIOStalled` | PSI I/O "full" >50% for 30 m | warning |
| `NodeRebooted` | boot time changed | warning (so a guard-triggered reboot is visible) |

Delivered by Argo CD (`home-monitoring` app) → Reloader restarts Prometheus.

### Docs / repo
- `docs/20` onboarding runbook lists `node-lockup-guard.sh` as a mandatory prep script.
- `CLAUDE.md`: incident noted under known constraints; a1's LAN IP corrected to `192.168.4.25`.

## Verification

See the "Verification" section at the end (filled after the reboot).

## Follow-ups (ranked)

1. **BIOS update on a3** (ASUS ROG STRIX Z790-E GAMING WIFI II is on 0220 from
   2023). Newer BIOS carries the 0x12B+ microcode natively and the Intel
   default power profile for 14900K. Manual, needs a monitor + USB stick.
2. **Move a3's hot storage off the HDD.** Same bind-mount trick already used
   for the SQLite DB: rsync `/mnt/d/k3s-data/storage` (14 GB of databases) to
   the SSD and bind-mount it back; consider containerd's root too if the SSD
   (68 GB free) can hold the image store. Do it in a planned window (k3s
   stopped, final rsync, fstab, reboot).
3. **Kernel meta-packages on a2 and t430**: a2 is on the 22.04 HWE 6.8 line,
   t430 on a bare 6.14 — run the guard with `--kernel` when convenient.
4. **HA control plane** (already on the roadmap): the 9-hour outage was the
   whole cluster's API because a3 is the only server.
5. **Stale docs:** `README.md` and `docs/05` still list a1 at `192.168.5.253`
   (left untouched because those files had uncommitted edits in progress).

## Appendix — key kernel traces

```
Sep 22 09:15:14 a3 kernel: watchdog: BUG: soft lockup - CPU#12 stuck for 26s! [kubectl:2011730]
Sep 22 09:15:14 a3 kernel: RIP: 0010:mas_walk+0x11c/0x400
Sep 22 09:15:14 a3 kernel:  lock_vma_under_rcu+0x64/0x220
Sep 22 09:15:14 a3 kernel:  do_user_addr_fault+0x14c/0x8d0
Sep 22 09:15:14 a3 kernel:  exc_page_fault+0x7f/0x1b0

Sep 22 09:15:14 a3 kernel: watchdog: BUG: soft lockup - CPU#25 stuck for 26s! [fuser:2011794]
Sep 22 09:15:14 a3 kernel: RIP: 0010:mas_next_slot+0x0/0x440
Sep 22 09:15:14 a3 kernel:  ? mas_find+0x65/0x1c0
Sep 22 09:15:14 a3 kernel:  lock_next_vma+0x38/0x290
Sep 22 09:15:14 a3 kernel:  proc_get_vma.isra.0+0xb0/0x1f0
Sep 22 09:15:14 a3 kernel:  m_next+0x1b/0x40
Sep 22 09:15:14 a3 kernel:  seq_read_iter+0x301/0x4c0

Sep 22 09:17:04 a3 kernel: INFO: task k3s-server:3852 blocked for more than 122 seconds.
Sep 22 09:17:04 a3 kernel:  rtnl_lock+0x15/0x20  <- networking config lock held by the stuck path

Sep 22 18:22:54 a3 kernel: watchdog: BUG: soft lockup - CPU#12 stuck for 30629s! [kubectl:2011730]
```

```
Hardware: ASUS ROG STRIX Z790-E GAMING WIFI II, BIOS 0220 09/06/2023
CPU: Intel i9-14900K (family 6 model 183 stepping 1), microcode 0x11d before / OS-loaded after
Kernel before: 6.17.0-14-generic (no meta-package)   after: 7.0.0-34-generic (linux-generic-hwe-24.04)
Taint before: P S W OEL  (S = CPU_OUT_OF_SPEC = old microcode, L = SOFTLOCKUP)
```
