---
title: "口袋里的 Hermes，以及 spark 上的一颗本地大脑"
slug: hermes-in-my-pocket
authors: brian
tags: [ai, agents, hermes, inference, tailscale, lessons]
description: "一个周日里，集群内的 Hermes 智能体完成了一次升级，有了经由 tailnet 访问的 iPhone 应用，有了一个能在无头 Pod 里完成的 ChatGPT 订阅登录，还在 spark 上有了一个每秒约 112 个 token 的本地模型。一个小细节曾让它的链路有一阵子跑去了云端。"
draft: true
---

先说句老实话：住在我集群里的这个智能体，过去是我在笔记本上对话、用一个我并不完全掌控的模型的东西。从今天起，我在手机上和它对话，而它既可以用我的 ChatGPT 订阅思考，也可以用 spark 上一个每秒约 112 个 token 的 30B 模型。这一天的大部分工作都很顺利。值得写的是两次无声的失败：每一样都报告成功了，结果却不是我想要的。

<!-- truncate -->

## 挪动了家具的升级

Hermes 从 v2026.7.7 升到了 v0.23.0。版本号的跳跃大多只是表面的，因为上游改用了语义化版本标签。但底下的变化是实打实的。OpenTelemetry 现在打包进了镜像（Python 3.14），所以我用了几个月的那个 init 容器加 `PYTHONPATH` 的安装把戏可以退休了。反正新的启动器也会剥掉 `PYTHONPATH`。插件依赖现在住在数据卷上 Hermes 自己的依赖代里，镜像每次升级都会重新解析它们。升级前我先给智能体的数据卷拍了一个 restic 快照。它的记忆是这屋子里为数不多无法从 git 重建的东西之一。

## 又一次，没人读的配置文件

升级刚完成，我的追踪插件（hermes-otel，我自己维护）就把所有东西都发到了一个地方：Langfuse Cloud。九月时我遇到过[一模一样的症状](/observability/otel-backends)，原因不同。这次是新镜像没有带 PyYAML，所以插件读不了它的 YAML 配置。它一声不吭地跳过了这个文件，从环境变量自动检测后端，找到了 Langfuse 的密钥，于是用上了云端默认地址。

修复方法是把缺失的包声明为插件依赖，让 Hermes 去安装它们。我还把 `LANGFUSE_BASE_URL` 钉到了集群内的 Langfuse，这样即使自动检测再跑起来，也出不了家门。真正的检验是发一轮真实的智能体对话，然后去 Phoenix 里找这条链路。趁着这次，我把九月那九个链路后端里的六个停放了。Hermes 现在只发往 Weave、Phoenix 和 Langfuse。

## 手机，以及错误的端口

Hermes 的 iOS 应用还在测试版。我把智能体的网关 API 暴露到了 tailnet 上，把应用指向它，得到的是"不是 Hermes 仪表盘（HTTP 404）"。应用连接的是端口 9119 上的**仪表盘**，而不是 8642 上的 API。改一下 Tailscale Ingress 就好了。我还得删掉代理 Pod，因为它自己察觉不到后端的变化。现在它是一个仅限 tailnet 的 HTTPS 地址，带真正的证书，我用仪表盘密码登录。它永远不会上 Funnel。这个智能体能跑 kubectl，还能读保险库。

## 两颗大脑

**ChatGPT 订阅：** `hermes auth add openai-codex` 会走一次设备码登录。Pod 打印出一个链接和一个验证码，我在手机上批准。Pod 里不需要浏览器。这很方便，因为 Hermes 之前默认用的模型——NVIDIA 托管的 nemotron-3-super——已经下线，现在返回 404。

**本地：** NVIDIA 的 Nemotron 3.5 Lightning（30B-A3B，NVFP4）从 Ripple-65B 手里接过了 spark 唯一的 vLLM 槽位。我用的是 NVIDIA 给 DGX Spark 的配方：vLLM 0.27.1、Marlin MoE、fp8 KV 缓存，外加一个推测解码草稿模型。它每秒约 112 个 token，工具调用解析得干干净净，上下文窗口 80K，这是 Hermes 需要的。它占用 spark 30% 的内存。在 LiteLLM 里它是 `nemotron-lightning`，一条仅限本地的路由。spark 宕了，请求就失败，不会悄悄发给云端提供方。

一个提醒：无线节点毕竟是无线的。spark 的 WiFi 在拉取一个 4.7 GB 的镜像层时中途截断了。所以我在换模型之前就把权重和镜像预先放到了节点上，Pod 离线启动。

## 我带走的东西

我的追踪插件已经两次遇到一个被悄悄无视的配置文件，而两次所有健康检查都是绿的。"导出成功"告诉你导出发生了，却不告诉你数据去了哪里。我唯一信得过的检验，是发一个真实请求，然后在另一端找到它。细节在 [Hermes 页面](/ai/hermes)和[推理舰队页面](/ai/inference-fleet)上。
