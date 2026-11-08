---
title: "Image-to-3D on a 4090, and the two generations that panicked my control plane"
slug: trellis-panicked-the-control-plane
authors: brian
tags: [ai, inference, 3d, kernel, lessons]
description: "TRELLIS.2 turns one photo into a textured 3D mesh. It sat parked on spark for months, so I built it a proper 4090 image. Its first two generations on a3 each crashed the kernel on my only control plane. The lockup guard rebooted it, the cluster healed itself, and the model moved to a2, where it now makes a mesh in about a minute."
draft: true
---

The quick honest take: I finally got Microsoft's TRELLIS.2 running properly. You give it one photo of an object, and about a minute later you get back a textured 3D mesh. Getting there took a new container image, a move off spark, and a short stop on a3 that crashed the kernel on my only control plane twice in a row. The cluster recovered both times without me, and that part is what I want to write about.

<!-- truncate -->

## Why it was parked

TRELLIS.2 had been on the bench for months, parked on spark. The arm64 build mounted its source code from the host, ran 10-15x slower than it should have for reasons I never pinned down, and competed with vLLM for spark's unified memory. Every time I wanted a mesh, I had to decide what to evict first. So it mostly didn't run.

## A real image for a real GPU

The fix was to stop fighting spark and target a 4090. I added a `Dockerfile.4090` to [Trellis2-DGX-Spark-Docker](https://github.com/briancaffey/Trellis2-DGX-Spark-Docker): torch 2.6 on CUDA 12.4, a prebuilt flash-attn wheel, and TRELLIS's CUDA extensions compiled for the 4090. The model source and its FastAPI wrapper are baked in, so nothing depends on files sitting on a node. It goes to Harbor and deploys through Argo CD like everything else.

## Then a3 fell over. Twice.

a3's 4090 was the least busy, so that's where I tried it first. The first test generation rebooted the node. So did the second. Both times the kernel hit the same bug, `kernel BUG at fs/namei.c:934`, on Ubuntu's 7.0 HWE kernel, during the burst of compiling and file IO a generation kicks off. The first victim was netdata reading cgroups. The second was `k3s-server` itself.

In September, a kernel lockup left this same node [spinning hot for nine hours](/blog/2026/09/22/the-control-plane-was-a-space-heater) while nobody noticed. This time each crash cost about five minutes. Since then every node runs a lockup guard that turns a kernel oops into a panic and a reboot, so a3 rebooted itself, pods came back, and the API returned. I didn't touch anything. Those settings are why this post is about a model and not a second outage.

Finding *why* took one more lesson. The journal was empty, because the machine died before it could write anything down. The traces were in `/var/lib/systemd/pstore`, where the kernel saves its last words in firmware storage across a reboot. I didn't know to look there before this week. Now it's the first place I check after any unexplained reboot.

## Where it lives now

The rule is simple: **no heavy, bursty GPU jobs on the only control plane.** TRELLIS moved to a2, which runs the older 6.8 kernel and hasn't flinched. In full bf16 on the 1024 cascade pipeline it makes a mesh in about 50-100 seconds once warm, with a peak of about 14 GB of VRAM. Each mesh has 300-500k faces in a GLB of about 20 MB. It can also render a turntable preview video. That needed opencv pinned below 5, because opencv 5 can't read the EXR file that lights the scene.

It shares a2's card with the LTX-2.5 video server by taking turns, and it's wired into inference.club as model `trellis-2`, the club's only 3D model. The full write-up is on the [TRELLIS.2 page](/ai/trellis2).
