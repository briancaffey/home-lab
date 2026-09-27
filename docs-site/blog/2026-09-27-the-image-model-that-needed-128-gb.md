---
title: "The Image Model That Needed 128 GB"
authors: brian
tags: [ai, inference, image, spark, gpu, lessons]
description: "Qwen-Image 2.1 is the first image model I've run that renders text correctly and edits from reference photos — and the first whose 33 GB of weights no RTX 4090 in the house could hold. Two attempts on a3 each looked like they worked. One of them silently couldn't edit at all. The DGX Spark, the node I'd written off as 'runs nothing critical', turned out to be the only honest home for it."
draft: true
---

The quick honest take: Alibaba released [Qwen-Image 2.1](https://huggingface.co/Qwen/Qwen-Image-2.1) on 2026-09-20, and within a week it was serving at `qwen.lan` — text-to-image, edits from up to ten reference photos, and real transparent PNGs from a single pipeline. It is the first image model I've run at home whose text rendering I'd trust on a menu. It is also 33 GB of bf16 weights, and every GPU in the cluster is a 24 GB RTX 4090. So this is not really a post about an image model. It's a post about the three places I tried to put it, why the two clever ones failed in different ways, and why the [DGX Spark](/hardware/nodes) — a box I've described on this very site as a specialist that runs nothing critical — is where it lives now. The [service page](/ai/qwen-image) has the reference; this is the story.

<!-- truncate -->

## What 33 GB is made of

Three components: a Qwen3-VL 9B text/vision encoder (17.5 GB), a 7B single-stream diffusion transformer (14.2 GB), and a 4-channel VAE (1.4 GB — the fourth channel is alpha, which is why transparency is native rather than a post-process). The encoder is the interesting one. It's a vision-language model, and the same tower that reads your prompt also looks at your reference images. Keep that in mind; it's the whole plot.

None of this fits in 24 GB alongside anything else. So the question was never *which* 4090, it was *how to cheat*.

## Attempt 1: offload, and the disk that pretended to be RAM

diffusers has `enable_model_cpu_offload`: keep one component on the GPU at a time, shuttle the others to system RAM. Peak VRAM drops to about 18 GB. It fits. I put it on a3, which has the most free VRAM of the three towers.

Every image took over five minutes.

The mechanism was obvious once I looked: each call streams all 33 GB through the GPU again, and "from CPU RAM" assumes the RAM can hold the weights. a3 is my control plane, with 62 GB of RAM already doing control-plane things, and it could not keep 33 GB of memory-mapped safetensors in page cache. So the weights came from where mmap falls back to — the 5400 rpm hard disk. Offload on a box that can't cache the model isn't GPU offload; it's disk streaming with extra steps.

## Attempt 2: quantize the big one, and the edit that did nothing

Second try, same box. Keep the DiT and VAE swapping through the GPU via the offload hooks — those two together fit in RAM — and shrink the 17.5 GB encoder to 4-bit NF4, about 5.5 GB, so the whole working set stays off the disk. About 30 seconds per 1024² image. Text-to-image was genuinely excellent: signs, menus, comic lettering, all crisp. I was ready to call it done.

Then I tested editing. A photo of a sign reading "HOME LAB", the instruction *change the sign to say "GPU CLUB"*. What came back was a grainier copy of the input that still said "HOME LAB".

Not a bad edit — *no* edit. And the failure makes complete sense in hindsight: the encoder I'd quantized is the vision tower. At 4 bits it could still read a text prompt well enough that generation looked perfect, but it could no longer see a reference image well enough to act on it. Quantization hadn't made the model uniformly a bit worse; it had removed one specific capability, and it happened to be the one I hadn't tested yet. Two or more references pushed it into an out-of-memory error next to Dia on the shared card, and the OOM left the offload hooks half-moved — encoder split across devices, transformer stranded on the GPU — so every later call failed too until the server learned to reset them.

This is the lesson I most wanted to write down. **Quantize the component you can afford to lose, and test the feature you actually wanted, not the one that's easy to demo.** Text-to-image is easy to demo. Reference editing was the reason I wanted this model.

## Home: the box I'd written off

The DGX Spark's GB10 has 128 GB of unified memory. The whole pipeline sits resident in bf16 — about 32 GB — with nothing swapped and nothing quantized. Around 60 seconds per 1024² image *or* edit, multi-reference composition works, native 2K works. Per step it is slower than a 4090; it is not a fast GPU. It is simply the only machine in the house that can do the entire job without a compromise, and for this model "the entire job" was the point.

I'd spent months describing spark as the odd one out: arm64, its own subnet, often offline, nothing critical. All still true. But "runs nothing critical" had quietly become "runs nothing much", and this is the first workload where its one unusual property is the property that matters. The a3 build survives as a hand-applied fallback for text-to-image only, clearly labeled as such.

## The unglamorous part: moving 33 GB over WiFi

No node in this cluster has an ethernet cable, and this project charged me the full WiFi tax:

- a3 downloaded the weights at about 9 MB/s, and a 4.4 GB PyTorch container image kept truncating on the way down. So neither pod has a custom image at all — a3 reuses the ltx2 image already cached there, spark reuses the arm64 vLLM nightly it already had, and both `pip install` the few extra packages at start with a host-side pip cache so restarts take seconds.
- spark's own uplink is about 3 MB/s. It never downloaded the model. I relayed a3's copy through my laptop at about 8 MB/s, because the laptop has a better path to each box than the two boxes have to each other. `hf download` still runs at pod start, but it's idempotent, so once the cache is there the pod stands on its own.
- diffusers is pinned to a main-branch commit tarball, because 2.1 pipeline support post-dates the current release. Renovate can't bump that; I'll have to.

None of this is interesting engineering. All of it is what "the cluster is on WiFi" actually costs, itemized.

## What it does now that it's home

I ran a 44-prompt showcase to find out what I'd built: text rendering in English and Chinese, menus with prices, infographics, comics with lettering, photorealism, art styles, 2K and odd aspect ratios, counting and layout, RGBA stickers and logos, single-reference edits (backgrounds, add/remove, seasons, text, relighting, outpainting), region-guided edits with a drawn red circle, multi-reference composition, and a guidance on/off pair. A gallery page came out of it. Text was letter-perfect in every spot check, and the reference edits — the thing Attempt 2 could not do at all — are the model's best trick.

It's wired up like the rest of the [fleet](/ai/inference-fleet): an OpenAI-shaped images API so the inference.club agent discovers it as an image endpoint, a `.lan` hostname, a Homepage tile, an Argo CD Application. From the outside it looks like just another service. It took three placements to make that true.
