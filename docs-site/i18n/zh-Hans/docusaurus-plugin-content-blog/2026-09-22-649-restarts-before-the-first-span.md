---
title: "第一个 span 到来之前，重启了 649 次"
authors: brian
tags: [langfuse, observability, llm, clickhouse, incident, lessons]
description: "自托管 Langfuse v4 花了三天、叠了四层故障，才有第一条链路真正通过：一个杀掉数据库迁移的存活探针、一个旧了两个版本的 ClickHouse、一份把宿主吃空的性能分析日志，以及一个被悄悄移除的 API。没有一个是稀奇的。但它们全都互相掩护。"
draft: true
---

先说实在话：这周我给实验室加了 [Langfuse](/observability/langfuse)——一个自托管的 LLM 链路追踪平台，这样当 [Hermes](/ai/hermes) 做了什么奇怪的事，我可以去看导致那一步的整棵模型调用树，而不是翻日志。Helm 安装花了十分钟。然后 web pod 在三天里重启了 649 次，而我从这次安装里学到的关于现代"v4"应用如何启动的知识，比任何一次一装就好的部署都多。坏了四样东西，每一样都藏在下一样后面。

<!-- truncate -->

## 故障 1：存活探针杀掉了迁移

Langfuse 的 web 容器启动时做了一件合理的事：在开始回应健康检查之前，先跑完所有待执行的数据库迁移。全新安装意味着对着空 Postgres 跑 **438 个 Prisma 迁移**，在 a3 上要好几分钟。

chart 默认的存活探针只给它大约五十秒。

于是 Kubernetes 在迁移进行到一半时杀掉了容器。Prisma 尽职地把那个迁移记为*失败*。从那以后，每一次启动都会看一眼迁移表，看到一行失败记录，拒绝再碰数据库——`Error: P3009`——这意味着它永远到不了健康检查，这又意味着探针再杀它一次。六百四十九次。

修复分三部分，只有第一部分是显而易见的：

- values 文件里一个 **10 分钟的存活窗口**，让首次启动能跑完。这是永久修复，也是对下一个人唯一重要的那一行。
- 对失败的迁移执行 `prisma migrate resolve --rolled-back`，让 Prisma 再试一次。Postgres 的 DDL 是事务性的，所以我以为重试会干干净净。
- 只不过那个迁移用的是 `CREATE INDEX CONCURRENTLY`，它**不是**事务性的。那次击杀留下了一个*无效*索引，重试死在了"already exists"上。一句 `DROP INDEX` 之后，迁移全部跑通。

最后这个细节，只有在恰好最糟的时刻被杀掉才学得到。我已经把恢复步骤写进 README，免得下次重新发现一遍。

## 故障 2：ClickHouse 旧了两个版本

Postgres 舒服了，轮到 ClickHouse 迁移——第 0039 号失败，报 `Only literals can be skip index arguments`。Langfuse v4 建的文本跳数索引需要 **ClickHouse 25.12 或更新**（推荐 26.4）。我自己管理的 StatefulSet 跑的是 25.3，因为那是我早前搭它时选的版本，之后也没有任何东西抱怨过。

这里的 ClickHouse 迁移走的是 golang-migrate，失败时会把 schema 标为 *dirty*，在人来表态之前拒绝再跑任何东西。修法是把镜像升到 26.4.5，然后手动把版本指针拨回最后一个成功的迁移。不难，但我查过的地方也都没写。

## 故障 3：ClickHouse 在吃自己的宿主

我在里面折腾的时候，ClickHouse pod 一直被 OOM 杀掉。这个实例是*空闲的*——还没有任何东西成功写进去——而它自己的性能分析日志 `system.trace_log` 已经**三天写了 4 GB**。合并那些分片需要的内存超过了我给它的 4 GiB 上限。

一个数据库靠给"什么都没干的自己"做性能分析，把自己的磁盘和内存填满，这是个真正好笑的故障模式。现在通过 StatefulSet 的 ConfigMap 里的一个 `config.d` 覆盖把它关了，内存上限提到 8 GiB。教训：任何默认开着自省日志的系统，早晚会为此向你收费。

## 故障 4：我用来测试的 API 已经被移除了

span 终于流起来了。我的"导出一个 span 再读回来"检查，导出正常——HTTP 200——然后读取返回 404。我在 worker 日志里花了不合理的时间，才找到那条发布说明：Langfuse v4 是**"仅事件"模式**。v3 的读取端点（`/api/public/traces`、`/observations`、`/metrics`）没了；现在读取侧是 `/api/public/v2/observations`。那些 span 已经在 ClickHouse 里躺了一个小时。我一直在敲一扇已经不存在的门。

## 我留下了什么

实实在在留下的是一个提交在部署旁边的**冒烟测试**：检查健康，用引导项目的密钥导出一个 OTLP span，轮询 v2 API 直到它回来。这一个脚本本可以把三天压缩成一个下午，因为它测的是*整条路径*，而不是我恰好盯着的那一段。"pod 是 Running 的"在那三天里大部分时间都是真的。只是那不是问题所在。

更软的一课关于叠加故障。这四个没有一个单独看是难的。让它们昂贵的，是每一个都要等前一个修好才看得见：Postgres 迁移不通过，你看不到 ClickHouse 版本问题；span 不流起来，你看不到 API 改名。我知道的唯一防御，是在你相信这东西能用*之前*就写好一个端到端检查，然后信它胜过信自己的眼睛。

Langfuse 现在上线了，在 `langfuse.lan` 和 tailnet 上。Hermes 的链路经 hermes-otel 落在里面。它最终会不会取代 Phoenix 成为实验室唯一的追踪存储，要等我把两个都用够了、有了观点再说。
