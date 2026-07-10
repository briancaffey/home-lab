---
title: "构建 Dagster 流水线"
tags: [data, orchestration, dagster, gitops, claude, workflow]
service: dagster
repo_path: clusters/home/dagster
description: 一份关于家庭实验室里 Dagster 的实操指南——它是什么、怎么部署、演示流水线做了什么，以及构建新流水线的确切工作流（包括如何直接让 Claude 替我来做）。
---

# 构建 Dagster 流水线

**先说实在话。** [Dagster](./dagster.md) 是实验室的数据编排器——运行*我写的代码*、按计划、面向我已经搭好的平台去执行的那一层。这一页是[服务概览](./dagster.md)的配套：它讲**怎么做**。如果说另一页回答的是"这是什么、它是怎么接线的"，那这一页回答的就是"我到底怎么构建一条新流水线——以及怎么让 Claude 用我喜欢的方式替我来做？"

## 1. 一分钟看懂 Dagster

你把流水线写成 Python 的**资产**（asset）——一个资产就是你希望存在的某个东西（一张表、一份报告、一个文件）。你声明每个资产依赖什么，Dagster 就算出执行顺序，按计划或触发去跑，把每次运行记进 Postgres，再给你一个 UI 盯着这一切。它是 Airflow 家族的，但**以资产为先**，界面也好看得多。

三个值得知道的名词：

- **资产（Asset）**——一个可物化的产出（`@asset` 函数）。它的参数就是它的依赖。
- **作业（Job）**——一组你要一起跑的资产（`define_asset_job`）。
- **计划 / 传感器（Schedule / Sensor）**——一个作业*什么时候*跑（一个 cron，或对某个事件的反应）。

## 2. 它在这里是怎么部署的（简版）

完整细节在[服务概览](./dagster.md)里；要点如下：

- **平台**（webserver UI、daemon、Postgres、run launcher）位于
  [`clusters/home/dagster/`](https://github.com/briancaffey/home-lab/tree/main/clusters/home/dagster)，
  由 Argo CD 应用 `home-dagster` 部署。UI 在 `https://dagster.lan`。
- 每次流水线**运行都作为它自己的一个 Kubernetes Job 执行**（K8sRunLauncher）——
  在 `kubectl get jobs -n dagster` 里盯着它们。
- 我的**流水线代码**住在一个*独立*的仓库 `brian/dagster-pipelines`，构建成一个容器镜像
  （`harbor.lan/apps/dagster-pipelines`），由 Dagster 作为 gRPC **代码位置（code location）** 加载。
- 一切都固定到节点 **a2**（受 Harbor 信任、和 Postgres 同处一地）。

关键的心智模型：**平台 = home-lab 仓库；流水线代码 = dagster-pipelines 仓库。**
平台你很少动，流水线代码你经常动。

## 3. 演示项目里有什么

`dagster-pipelines` 仓库自带一条真实的、端到端的流水线，外加一个热身资产，这样就有个能跑的东西供你学：

| 资产 | 它做什么 |
|---|---|
| `hello_dagster` | 微不足道的冒烟测试——UI 里第一个要物化的东西。 |
| `gpu_snapshot` | 查询实验室的 **Prometheus**（dcgm-exporter 的 `DCGM_FI_DEV_*`），取每块 GPU 的利用率、显存、功耗、温度。 |
| `vram_by_pod` | 从自定义的 `vram-reporter` 指标里，取显存消耗最多的那些 Pod。 |
| `cluster_summary` | 把这些数字喂给 **LiteLLM 网关**，拿回一段自然语言的"GPU 编队状态"摘要（网关挂了还有一个模板化兜底）。 |

它们构成一个小 DAG——`gpu_snapshot` 和 `vram_by_pod` 汇入 `cluster_summary`——
并按**每日计划**运行（`daily_gpu_digest`，07:00）。它是有意设计成把整个实验室浓缩进一次作业的一趟巡礼：它读我自己的 Prometheus、用我自己的 LLM 网关思考、经由我自己的 Forgejo 和 Harbor 发布。每条新流水线都遵循这个模式。

{/* screenshot: data/dagster-asset-graph.png — the GPU digest asset graph in the Dagster UI */}

这个仓库的结构值得照抄：

- `dagster_pipelines/resources.py`——通往集群的**接缝**：`PrometheusResource`
  和 `LiteLLMResource`。新的外部系统在这里加一个新资源，而不是把 URL 硬编码进某个资产。
- `dagster_pipelines/assets.py`——资产本身。
- `dagster_pipelines/definitions.py`——把资产 + 资源 + 计划接到一起。
- `Dockerfile` + `.forgejo/workflows/build.yaml`——代码服务器镜像及其 CI。

## 4. 一条新流水线的工作流

这个环和实验室里每个应用用的都一样——推代码、CI 构建、Argo 部署——只多一个 Dagster 特有的转折（晋级镜像 tag）。

1. **写**一个新模块 `dagster_pipelines/<name>.py`（资产，如果它要跟新东西对话，还要在
   `resources.py` 里加一个新资源）。
2. **接线**到 `definitions.py`——加一个作业，如果它是定时的，再加一个计划。
3. 本地**校验**：`dagster definitions validate -m dagster_pipelines.definitions`。
4. **推送** `dagster-pipelines` 仓库 → Forgejo Actions 构建
   `harbor.lan/apps/dagster-pipelines:<sha>`。
5. **晋级**——把 [`clusters/home/dagster/values.yaml`](https://github.com/briancaffey/home-lab/tree/main/clusters/home/dagster)
   里 `dagster-user-deployments` 的镜像 tag 碰到那个 `<sha>`，然后推送 home-lab 仓库。Argo 滚动代码服务器。
6. **验证**——新的代码位置在 UI 里加载出来；启动作业，看它的 Kubernetes Job 在
   `kubectl get jobs -n dagster` 里冒出来。

:::tip[钉一个明确的 tag，别追 `:latest`]
通过钉住确切的 `<sha>`（而不是跟着一个会漂移的 `:latest`）来晋级，会让部署在 git 里可审阅、可轻松回滚——
和实验室里其他每个 GitOps 应用同样的纪律。
:::

CI 替你强制的几条规矩：钉住 `dagster==1.13.13`，并记住集成库用的是 `0.X.Y` 编号方案——
core `1.13.13` 对应的 **`dagster-postgres`/`dagster-k8s` 是 `0.29.13`**。它们必须在镜像里，否则运行 Pod 会导入失败。

## 5. 省事按钮：直接让 Claude 来

因为这是我的仓库、Claude 手里有上下文，我不会手动去做那六步——我描述一下流水线，让 Claude 把这个环跑完。
这个仓库带着一个 **Claude skill**，在
[`.claude/skills/dagster-project/`](https://github.com/briancaffey/home-lab/tree/main/.claude/skills/dagster-project)，
它把这一页上的每条惯例都编码进去了：代码放哪、资源模式、凭据
（`forgejo-bot`、`harbor-robot-apps-ci`，经由 `scripts/vault-secret.sh`）、a2 固定，以及
推送 → 构建 → 晋级 → 验证这个环。

所以提示词就只是那个*想法*：

> "做一个 Dagster 项目，拉取 Hacker News 上排名靠前的故事，把每条标题过一遍 LiteLLM 得到一行情感倾向，
> 再物化成一张每日表。放进 `dagster-pipelines` 仓库并发布出去。"

Claude 会脚手架好模块、接好作业和计划、校验它、推送它、盯着 Harbor 构建、把 `values.yaml` 里的 tag 碰一下、
让 Argo 滚动它、再启动一次验证运行——然后报告结果。提示词里值得包含的东西：

- **数据源**（"读 Prometheus / 打这个 API / 列这个 MinIO 桶"）。
- **产出**（"一张每日表"、"一条 Slack 消息"、"UI 里一份 Markdown 报告"）。
- **节奏**（"每天早上 7 点"、"仅按需"）。
- **它放哪**——默认是在 `dagster-pipelines` 里新加一个模块；如果你想要一整个独立的代码位置，就说明一下。

几个值得试的起步点子：一个 **Hacker News → 情感倾向** 摘要，一个 **MinIO 桶目录**
（对象的数量/大小/最新的那些），或一个 **备份新鲜度检查**，通过现有的 Telegram/Alertmanager 栈来告警。

## 6. 值得守住的好惯例

- **任何外部东西都用资源。** 把 URL 和客户端放进 `resources.py`，别放进资产里。资产保持纯净、可测试。
- **优雅降级。** 永远不要因为一个*可选*依赖（LLM、一个不稳的 API）挂了就让整次运行失败——
  捕获它并兜底，像 `cluster_summary` 那样。
- **丰富的 UI 元数据。** 通过 `context.add_output_metadata` 输出 Markdown 表格，让一次运行在 UI 里就把它的故事讲清楚，而不只在日志里。
- **默认用本地模型。** LLM 步骤默认用本地的 `nemotron-omni`（经由 `LITELLM_MODEL` 环境变量设置——
  切换不用重建）。云端模型走 [Rampart](./dagster.md) PII 卫兵，它能脱敏标识符。
- **没有鉴权——留意暴露面。** Dagster OSS 没有登录。它在 LAN 和默认拒绝的 tailnet 上没问题；
  在没有鉴权代理的情况下，绝不要把它放到任何更公开的地方。
