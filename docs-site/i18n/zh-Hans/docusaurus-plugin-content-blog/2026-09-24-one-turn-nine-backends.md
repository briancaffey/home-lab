---
title: "一轮对话，九个后端"
authors: brian
tags: [observability, opentelemetry, hermes, helm, lessons]
description: "我的 hermes-otel 插件声称支持的每一个可自托管后端，现在都用官方 Helm chart 跑在集群里，一次真实的智能体对话会落进它们全部。安装是容易的部分。有意思的失败是：一份没人在读的配置文件、一个在有人注册之前什么都不接收的 collector，以及一个从写下那天起就一直在悄悄失败的五分钟循环。"
draft: true
---

先说实在话：我维护着 [hermes-otel](https://github.com/briancaffey/hermes-otel)，一个给 Hermes 智能体用的 OpenTelemetry 插件，它的 README 列了十来个支持的后端。直到这周之前，"支持"的意思是"我读了文档，写了一个导出器"。现在它的意思好多了：那张表上每一个*能*自托管的后端，都用官方 Helm chart 跑在了我的 k3s 集群里，而一次真实的 [Hermes](/ai/hermes) 对话——一个带工具调用的 `/v1/runs` 请求——在每一个后端里都以链路的形式出现了。九个后端，一轮对话，一个晚上。[后端页面](/observability/otel-backends)有矩阵；这里是故事。

<!-- truncate -->

## 为什么是九个

没有人需要九个链路追踪后端。我也不需要。实验室原本就有 [Langfuse](/observability/langfuse) 和 Phoenix，它们依然是我真正会打开来*读*链路的两个。

但插件作者面对的问题和用户不一样。当有人开 issue 说"Jaeger 后端不工作"时，我想对着一个我能登录进去的 Jaeger 来回答，而不是凭对某个文档页面的记忆。而"可自托管"是关于*后端*的一个声明，只有做过了才算真：官方 chart 存在、它能在一个节点上起来、它能接收插件发出的 OTLP、链路在 UI 里看得见。这周，这些步骤里每一步都至少有一个意外。

所以这次工作的形状是：对 OpenObserve、Jaeger v2、Grafana Tempo、SigNoz、Uptrace 和 Parseable 中的每一个——再加一个顶替 `lgtm` 类型的 OTel Collector——从官方 chart 装一个 Helm release，values 进 git，钉在 a2，一个 `.lan` ingress，一块 Homepage 磁贴，密钥经 External Secrets 从 Vaultwarden 送达。然后把插件同时指向所有后端，发一轮对话。

## 那个不是后端的后端

hermes-otel 的 `lgtm` 类型期待的是"一个 OTLP 接收器，后面站着 Grafana"。在笔记本上那就是 `grafana/otel-lgtm` 演示容器。它没有 chart，没有持久存储，我早就决定不移植它。而它在结构上*是什么*呢——一个挡在 Tempo、Prometheus 和 Loki 前面的 collector。所以 k3s 上的版本就是这个：一个 OpenTelemetry Collector（contrib），在 `:4318` 接收，链路转发给我刚装好的 Tempo，指标转发给 Prometheus——它需要一个开关 `--web.enable-otlp-receiver`，才能接受推送而不只是被抓取——日志暂时没有去处，因为我的 Loki 是 2.9，没有 OTLP 端点，而 collector-contrib 删掉了它的 `loki` 导出器。这个缺口是一个已经立项的 Loki 3 迁移。

然后网关第二次证明了自己的价值。Parseable OSS 结果是没法直接对话的：插件的 `parseable` 类型用 API key 认证，而 OSS 没有 API key（任何带这个头的请求都得到 401）；而且 OSS 对 OTLP/protobuf 直接拒绝（`400 Protobuf ingestion is not supported in Parseable OSS`），而 Python 导出器只会发 protobuf。可 collector 能重新编码成 OTLP/JSON、加上 Basic 认证、按信号设置一个流名称头。于是 Parseable 只由网关来喂，别无其他，而且能用。一个"不支持"这个插件的后端，变成了一个插件多绕一跳就能到达的后端。

## 三个值得留下的失败

**没人在读的配置。** 七个后端起来了，每个 OTLP 端点都用手工拼的请求做了冒烟测试，全是 200。我发了一次真实对话。链路去了 Langfuse *Cloud*。

插件没问题。安装步骤把它的配置种到了 `/opt/data/.hermes/plugins/hermes_otel/`——旧 fork 分支用的路径。1.x 的插件在 `HERMES_HOME` 设为 `/opt/data` 时，查找的是 `/opt/data/plugins/hermes_otel/`（init 容器每次启动都会重装）或者 `/opt/data/hermes_otel.yaml`。两个都没找到，它退回到环境变量自动检测，找到了一对长得像 Langfuse 的密钥，把自己配成了云端。它从没告诉我它忽略了我的文件，因为在它看来根本没有文件。

修法是一个挂载的 ConfigMap，再用 `HERMES_OTEL_CONFIG` 指向它——插件优先级最高的路径，卷上没有任何东西可以被重启清掉。教训是我不断以新装扮重新学到的那一条：*端点返回的 200 测试的是接收方，不是发送方。* 唯一的证明是 UI 里的链路。

**什么都不接收的 collector。** SigNoz 起来时一片绿，每个 pod 都是 Running，而它的 collector 的 4318 端口是关着的。collector 启动时通过 OpAMP 向 SigNoz 应用注册，而在第一个用户和组织存在之前，这次注册会失败。注册一个管理员，过一会儿端口就开了。chart 没有提这件事。"Ready"是真的；"在接收流量"不是。

**从来没工作过的循环。** 这一个和可观测性完全无关。External Secrets 通过一个跑着 `bw serve` 的小桥接 pod 来读我的 Vaultwarden，它把保险库缓存在内存里，所以桥接有一个后台循环，每五分钟敲一次自己的 `/sync` 端点。一晚上立起七个后端意味着七个新的保险库条目，而在我重启桥接之前，没有一个出现在集群里。那个循环调用的是 `node`。镜像的 PATH 上没有 `node`。从写下的那天起，它每五分钟就悄悄失败一次，全程 readiness 探针是绿的，因为提供一份过期的保险库仍然算"在提供服务"。现在它调用 `wget`。

## 我会告诉做同样事情的人

- 早点把 collector 放进去。一个能重新编码并扇出的网关，不用碰发送方就能解决一整类"这个后端很挑剔"的问题。
- 别指望 chart 仓库一直待在原地：Grafana 社区 chart 在 1 月搬到了 `grafana-community`，旧的 `grafana/tempo` 是一个停在 1.24 的陈旧版本。
- 安装前先看 operator 的情况。SigNoz 带来一个集群级的 ClickHouse operator；Uptrace 想为它的存储装三个 operator，我用普通 StatefulSet 把它们全换掉了。
- 端到端测试是唯一的测试。上面每一个失败，从组件自己的健康检查里都看不出来。

Homepage 上现在有九块磁贴，全都指向同一条链路。我会留着它们，直到对每一个都形成了看法，然后 `helm uninstall` 命令早就写在各自的 README 里了。
