---
title: The Rest of the Fleet
description: The computers that aren't in the cluster — the operator machine, the spare hardware, and the wishlist.
tags: [hardware, laptops, wishlist]
---

# The Rest of the Fleet

Not every computer in the house is a cluster node. The machines outside the cluster shape it too, and one of them is arguably the most important machine in the whole system.

{/* screenshot: hardware/fleet-family-photo.jpg — Brian-provided photo slot */}

## MacBook Pro — the operator machine

My daily driver, and deliberately **not** a cluster node. This is the machine the lab is operated from: it holds the Git checkout, the kubeconfig, the certificate authority that the whole `.lan` TLS setup chains to, and the Keychain credentials that let AI agents open the password vault. When Claude Code works on the cluster, it works from here.

Keeping it separate from the cluster is intentional. The cluster should survive any of its own machines failing, and the operator machine should survive the cluster failing. That way there is always a working place to fix things from — the [break-glass runbook](/gitops/the-trio) assumes this machine exists. It does make the laptop its own single point of failure, which is why everything it uniquely holds is being copied into the vault, one credential at a time.

It could join the cluster, but it won't: a machine used to control and repair the cluster shouldn't also be subject to the cluster's own reboots and maintenance.

## Razer Blade 16 — spare GPU laptop

A GPU laptop that currently does nothing for the lab. It's the obvious candidate if I want a burst node — a sixth machine that joins for a heavy job and then leaves — or a dedicated Windows/gaming machine that stays out of the cluster. For now it is unassigned spare capacity.

## Laptops as nodes

Two of my old laptops are cluster nodes now: [x1](/hardware/nodes) and, most recently, [t430](/hardware/nodes). Converting a laptop takes several changes it doesn't come with: passwordless sudo, sleep and lid-switch disabled, WiFi power-save off, trust certificates installed, and a battery alert. A laptop can run as a server, but it still behaves like a laptop in ways you have to account for — and, as t430 taught me, a laptop that has *joined* the cluster hasn't necessarily had any of that prep applied. It can look `Ready` and still be one closed lid away from dropping out.

## Raspberry Pis — unused

A small stack of Pis, currently doing nothing. The most useful jobs they could take on:

- **Second DNS resolver** — the household currently depends on one Pi-hole on one node. A Pi in a separate failure domain is the standard fix, and it's a prerequisite for pointing the router's DHCP at Pi-hole network-wide.
- **Watchdog** — a small always-on box that pings the main machines and sends wake-on-LAN packets would handle waking spark when it goes offline.
- **Offsite backup target** — a Pi at a relative's house receiving nightly restic snapshots is the cheapest way to stop keeping all backups in one building.

None of these exist yet, but each is a small project.

## The wishlist

1. **Ethernet cabling** — the highest priority. Every node is on WiFi, and every hard problem in this lab (storage replication, CI transfer speed, large image pulls, spark's instability) gets easier with cables. It is the biggest single improvement available and costs very little.
2. **A second Pi-hole / DNS failure domain** — see above; also enables household-wide ad-blocking.
3. **Offsite backups** — the remaining gap in the disaster-recovery plan.
4. **More disk on a3** — the control plane's data disk is the fullest in the fleet.
5. **More nodes from hardware I already own** — done once, now: an old ThinkPad (t430) joined as a sixth node. It cost nothing and added CPU headroom, which is the right kind of expansion. New computers are still not the priority — cables are.

{/* screenshot: hardware/wishlist-cables.jpg — optional: unused ethernet cable, Brian-provided */}
