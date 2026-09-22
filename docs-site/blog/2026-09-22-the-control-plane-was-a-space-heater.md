---
title: "The Control Plane Was a Space Heater for Nine Hours"
authors: brian
tags: [kubernetes, hardware, kernel, incident, observability, lessons]
description: "a3, my only k3s control plane, sat hot to the touch and unreachable for nine hours. It wasn't a fan, dust, or the GPU: two CPU cores were stuck in an infinite loop inside the Linux kernel, and nothing on the box was configured to do anything about it. Here is what happened, what I got wrong beforehand, and the three-layer guard every node runs now."
draft: true
---

The quick honest take: on 2026-09-22 I walked over to a3 — the i9-14900K tower that is my *only* Kubernetes control plane — and it was hot to the touch, blowing warm air, and not answering SSH. It had been like that since 9:15 that morning. Nine hours. My first guesses were the usual home-lab suspects: a dead fan, dust, a runaway GPU job. It was none of those. Two CPU cores had been spinning in an infinite loop *inside the Linux kernel* the whole time, at full turbo clock, and that is what a space heater made of silicon looks like. The kernel had known for nine hours. Nobody had told it what to do about it.

<!-- truncate -->

## What I found when I finally looked

The last line in a3's journal before I hard-powered it was this:

```
watchdog: BUG: soft lockup - CPU#12 stuck for 30629s! [kubectl]
```

Thirty thousand seconds. The kernel's own watchdog had been printing that complaint, with the number growing, since 09:15. Two cores were involved: one running a `kubectl` process that had taken a page fault, and one running a root `fuser` process that was reading every process's `/proc/PID/maps`. Both were stuck in the same place — the maple-tree walk the kernel uses to find which memory mapping an address belongs to — and neither was ever going to get out.

A stuck core on its own is bad but survivable. What made it a full outage was that the stuck path was holding `rtnl_lock`, the lock that guards the kernel's networking configuration. Within two minutes, `NetworkManager`, `k3s-server`, and even `node_exporter` were all reported as hung tasks waiting on it. The network stack wedged, SSH died with it, and the k3s server started logging "network policy controller heartbeat missed" every second for the next nine hours. Because a3 is the only control plane, the cluster API was degraded the whole time. Pods on the other five nodes kept running — that part of the Kubernetes promise held — but nothing could be scheduled, changed, or fixed.

**Ruled out**, for the record: the GPU (idle, 31 °C after reboot), memory (52 GB free), the disks (SMART clean), and a misbehaving pod (the spinning threads were kernel-side, not userland). Thermal throttling was an *effect*, not a cause.

## Why it lasted nine hours

This is the part I actually want to write down, because the kernel bug is not really my fault and the nine hours mostly are.

**a3 was on a kernel that never got updates.** It was running 6.17.0-14, a "bare" kernel package with no meta-package pulling in point releases. That is the kind of thing that happens when a kernel gets installed by hand during some other emergency and nobody circles back. The `/proc/PID/maps` code path that looped here was reworked in later kernels. Meanwhile a1 — same class of hardware, same workload style — had quietly been on the 7.0 HWE line for weeks with zero lockups. I had a control group and didn't know it.

**Nothing was configured to reboot on a lockup.** Linux ships with `kernel.softlockup_panic=0`, which means "log it and carry on." No hardware watchdog was loaded. On a server that someone can walk over to, that is a defensible default. On a headless box in a closet, it turns a two-minute reboot into a nine-hour space heater.

**No alert covered "alive but stuck."** My [alerting](/observability/alerting) has a `NodeDown` rule, earned the hard way, and it did not fire — because a3 never fully went away. node-exporter was still up and still being scraped, just slowly, from a machine whose network stack was wedged. Two cores at 100% *kernel* time is a loud, unmistakable signal, and I had no rule listening for it.

**The CPU was running 2023 microcode.** Not the trigger, but the thing that scared me most after the fact. The `intel-microcode` package had been removed at some point, so the 14900K was booting on BIOS microcode `0x11d` — from before Intel's fix for the Raptor Lake instability problem that this exact CPU is famous for. The kernel had been tainting itself `CPU_OUT_OF_SPEC` at every boot. It was in the logs. I never looked.

## The fix: three layers, one script

Everything landed in one script, [`scripts/node-lockup-guard.sh`](https://github.com/briancaffey/home-lab/blob/main/scripts/node-lockup-guard.sh), which is now mandatory node prep alongside the sleep-masking and WiFi power-save fixes from the [T430 story](/hardware/nodes#t430--the-second-laptop-node). It ran on a1, a2, a3, and t430 the same evening.

1. **Lockup means panic, panic means reboot.** The kernel's soft- and hard-lockup detectors are switched to panic mode with a 30-second threshold, and the panic timeout is set to 15 seconds. A core stuck in the kernel now takes the box down and back up in roughly 75 seconds. That sounds violent, and it is — but an unplanned reboot is precisely the failure mode Kubernetes is built for. Pods reschedule; the node comes back `Ready`; I get a `NodeRebooted` alert and a journal to read.
2. **A hardware watchdog behind the software one.** Intel chipsets have a TCO watchdog that will reset the board if nobody pets it. It is loaded at boot by a small systemd unit and armed by systemd itself (`RuntimeWatchdogSec`), so if even PID 1 stops running, the chipset pulls the plug. One wrinkle worth knowing: Ubuntu's kernel packages deny-list watchdog drivers, so the usual `modules-load.d` approach silently does nothing — hence the dedicated boot unit.
3. **Microcode, from the OS, every boot.** `intel-microcode` is reinstalled and verified. a3 now boots on `0x133`, the current stability release for this CPU, loaded by the kernel's early loader regardless of what the BIOS ships.

And with a flag, the script installs the HWE kernel *meta-package*, which is the real fix for "never got updates": a3 moved from 6.17.0-14 to 7.0.0-34, the NVIDIA DKMS module rebuilt cleanly, and the old kernels stay in GRUB as fallbacks.

On the cluster side, a new `node-runaway` rule group gives Prometheus the vocabulary it was missing: `NodeCPUStuckInKernel` (critical — any CPU above 95% kernel time for ten minutes; this alone would have paged me at 09:25), `NodeHighTemperature`, `NodeIOStalled`, and `NodeRebooted`. All four are on the [alerting page](/observability/alerting).

## The thing I didn't expect to find

Postmortems find things. Watching a3 come back up, it sat at roughly 50% I/O pressure-stall for a quarter of an hour while every pod restarted, and probes timed out left and right. The reason: a3's k3s data directory — containerd's image store, every container's writable layer, and about 14 GB of node-local database volumes — lives on a 5400 rpm hard disk. The SQLite datastore was already bind-mounted from the SSD, which is why I'd assumed the rest was too. It wasn't. That is not why the box overheated, but it is why "a3 feels flaky after a reboot" has been a background hum for months. Moving that data to the SSD is next on the list, along with a BIOS update on the Z790 board.

## What I'm taking from it

- **A stuck node must be able to reboot itself.** The default Linux behaviour — log a lockup and keep spinning — is wrong for any machine you can't walk over to within minutes. `softlockup_panic=1` plus a hardware watchdog is cheap insurance and I should have had it from day one.
- **"Down" and "stuck" are different alerts.** I had the first and assumed it covered the second. It doesn't. A node answering slowly from a wedged kernel looks *up* to a liveness rule.
- **Check what kernel you are actually on, and whether anything updates it.** `uname -r` and `apt list --installed 'linux-generic*'` is a ten-second audit. a1 was my control group for weeks and I never compared.
- **Read the taint flags.** `CPU_OUT_OF_SPEC` on a 14900K is not decoration.
- **A single control plane is a single point of failure, again.** I knew this in the abstract; now I know it as a number (nine hours). The [HA plan](/foundations/k3s#plans-to-migrate-to-ha) is still gated on ethernet cabling, and this incident moved cabling up the list rather than HA down it.

The full postmortem with kernel traces is [`docs/22`](https://github.com/briancaffey/home-lab/blob/main/docs/22-a3-thermal-runaway-postmortem.md) in the repo, and the a3 section of [The Six Machines](/hardware/nodes#a3--control-plane) carries the short version. a3 has been quiet and cool since, with a newer kernel, fresh microcode, and — for the first time — a plan for what to do when it isn't.
