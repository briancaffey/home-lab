---
title: "4090 上的图生 3D，以及让我的控制平面 panic 的那两次生成"
slug: trellis-panicked-the-control-plane
authors: brian
tags: [ai, inference, 3d, kernel, lessons]
description: "TRELLIS.2 能把一张照片变成一个带贴图的 3D 网格。它在 spark 上停放了好几个月，于是我给它做了一个正经的 4090 镜像。它在 a3 上的头两次生成，每次都让我唯一的控制平面内核崩溃。锁死守护把它重启了，集群自己痊愈，模型搬到了 a2，现在大约一分钟出一个网格。"
draft: true
---

先说句老实话：我终于把微软的 TRELLIS.2 正经跑起来了。你给它一张物体的照片，大约一分钟后它还给你一个带贴图的 3D 网格。走到这一步，需要一个新的容器镜像、一次从 spark 的搬家，以及在 a3 上的一次短暂停留——它连着两次让我唯一的控制平面内核崩溃。两次集群都在没有我的情况下恢复了，而这正是我想写的部分。

<!-- truncate -->

## 它为什么被停放

TRELLIS.2 在替补席上坐了好几个月，停放在 spark 上。那个 arm64 构建从宿主机挂载源码，跑得比应有的慢 10-15 倍（原因我始终没查清），还要和 vLLM 抢 spark 的统一内存。每次我想要一个网格，都得先决定把谁赶走。所以它大部分时间都没在跑。

## 给真 GPU 一个真镜像

解决办法是别再和 spark 较劲，改为瞄准 4090。我在 [Trellis2-DGX-Spark-Docker](https://github.com/briancaffey/Trellis2-DGX-Spark-Docker) 里加了一个 `Dockerfile.4090`：CUDA 12.4 上的 torch 2.6、一个预编译的 flash-attn wheel，以及为 4090 编译好的 TRELLIS CUDA 扩展。模型源码和它的 FastAPI 包装层都烤进了镜像，不再依赖节点上放着的任何文件。镜像推到 Harbor，和其他一切一样通过 Argo CD 部署。

## 然后 a3 倒了。两次。

a3 的 4090 最闲，所以我先在那里试。第一次测试生成让节点重启了，第二次也是。两次内核都撞上了同一个 bug：Ubuntu 7.0 HWE 内核上的 `kernel BUG at fs/namei.c:934`，发生在一次生成引发的那阵密集编译和文件 IO 期间。第一个受害者是正在读 cgroups 的 netdata，第二个则是 `k3s-server` 本身。

九月份，一次内核锁死让同一台节点[发着烫空转了九个小时](/blog/2026/09/22/the-control-plane-was-a-space-heater)，而没人发现。这一次，每次崩溃只花了大约五分钟。从那以后每台节点都跑着一个锁死守护，它会把内核 oops 变成 panic 加重启，所以 a3 自己重启了，Pod 回来了，API 也恢复了。我什么都没碰。正是这些设置，让这篇文章讲的是一个模型，而不是第二次宕机。

查清*原因*又多教了我一课。journal 是空的，因为机器在来得及写下任何东西之前就挂了。内核栈在 `/var/lib/systemd/pstore` 里——内核会把临终遗言存进固件存储，跨重启保留下来。这周之前我还不知道要去那里找。现在，任何莫名其妙的重启之后，那都是我第一个查的地方。

## 它现在住在哪里

规矩很简单：**不要在唯一的控制平面上跑又重又突发的 GPU 任务。** TRELLIS 搬到了 a2，那里跑着较老的 6.8 内核，至今纹丝不动。在 1024 级联流水线上全 bf16 运行，预热后大约 50-100 秒出一个网格，峰值 VRAM 约 14 GB。每个网格有 30-50 万个面，GLB 大约 20 MB。它还能渲染一段转台预览视频；为此得把 opencv 钉在 5 以下，因为 opencv 5 读不了给场景打光的 EXR 文件。

它和 LTX-2.5 视频服务器轮流使用 a2 的卡，并以模型 `trellis-2` 接入了 inference.club，是俱乐部唯一的 3D 模型。完整介绍在 [TRELLIS.2 页面](/ai/trellis2)。
