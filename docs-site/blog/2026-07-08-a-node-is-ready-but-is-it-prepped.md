---
title: "Ready Is Not Prepped: Welcoming the Sixth Node"
authors: brian
tags: [kubernetes, hardware, onboarding, observability]
description: "An old ThinkPad joined the cluster and reported Ready — but Ready only means the kubelet is talking. This is what actually onboarding a node turned out to mean: join, then prep, then three manual observability touches."
draft: true
---

The quick honest take: adding a node to k3s is deceptively easy. You run one script, the node prints `Ready`, and every instinct says you're done. You are not done. `Ready` means the kubelet is talking to the API server — nothing more. It says nothing about whether the machine has been *prepared* to be a reliable member of the cluster, and on my newest node, almost none of that prep had actually happened. It was `Ready` by luck.

<!-- truncate -->

This week an old ThinkPad T430 — four cores, 8 GB of RAM, no GPU, on its own subnet — joined the cluster as [the sixth node](/hardware/nodes). It's the weakest machine in the fleet, and that's the point: it soaks up small CPU-only services so the RTX 4090 machines can stay focused on GPU work. Like my other laptop node, it's deliberately not a storage member and holds no GPU role. A weak, WiFi-only laptop is a fine place to run a scanner sidecar and a bad place to keep replicated data.

## The trap: joined is not prepped

Here's the thing that nearly bit me. The node had *joined* — it showed up in `kubectl get nodes` as `Ready`, pods were scheduling onto it, everything looked green. But joining a cluster only needs a token. Everything that keeps a laptop node *healthy* is separate host prep, and on the T430 it had been silently skipped:

- **Mask sleep and suspend, ignore the lid.** A laptop's default reflex is to go to sleep. A sleeping node is a `NotReady` node.
- **WiFi power-save off.** This is the single setting that stops a WiFi laptop node from flapping in and out of `NotReady` under light load. Leave it on and the node looks haunted.
- **Raise the inotify sysctls.** Dense, file-watching pods exhaust the default limits and crashloop with cryptic errors that have nothing to do with the pod.
- **Trust the LAN certificate authority and pin `harbor.lan`.** Without these the node can't pull from my registry or talk to `.lan` services over TLS.
- **Enroll it on the tailnet.** So I can reach it remotely like the rest.

None of that is implied by `Ready`. The lesson I keep relearning: a green node status tells you the kubelet is alive, and that's *all* it tells you. Verify the prep actually ran — don't trust the status. "It joined" and "it's ready for work" are two different claims, and only one of them shows up in `kubectl`.

## The three manual observability touches

The second half of onboarding is making the node *visible*. Most of my observability is DaemonSets — node-exporter, promtail shipping logs to Loki, netdata, Scrutiny disk-health, node-feature-discovery — so those land on a new node automatically the moment it joins. That part is genuinely zero-effort.

But three things are stubbornly manual, one per subsystem, and each fails silently if you forget it:

1. **Prometheus scrape target.** My monitoring is [hand-rolled on purpose](/observability/prometheus-grafana) — plain `static_configs`, no Operator, no ServiceMonitors, because I value being able to read the whole config in one file. The tax on that legibility is that a new node's node-exporter runs instantly but Prometheus won't scrape it until I add the target by hand. An Operator would have discovered it; I chose the readable file and the manual edit that comes with it.
2. **The fleet dashboard's node-label mapping.** My Grafana dashboard has hardcoded IP-to-node-name mappings for the temperature labels. Until I added the new node's IP, its row rendered blank — data flowing, nowhere to land.
3. **Restart Dozzle.** This one is a genuine quirk worth [writing down](/observability/logs). [Dozzle](/observability/logs) runs as a single pod in Kubernetes mode and enumerates the cluster's nodes *once, at startup*. A node that joins afterward is simply invisible to it — no error, no warning, just missing. One `kubectl rollout restart` and it appears. The failure mode is silent, which is exactly why it's easy to lose an afternoon to it.

## The shape of "onboarding a node"

So the real definition, the one I'll keep now: **onboarding a node is join + prep + three manual observability touches.** The join is the easy 10%. The prep is what makes it stay up. And the three touches are what make it show up on the dashboards you'll actually look at when something goes wrong at 5:40 AM.

The good news is the direction of travel: the DaemonSets already do the heavy lifting automatically, and the manual pieces are all small, all in git, and all candidates for a proper onboarding script. The T430 is fully welcomed now — masked, pinned, trusted, scraped, graphed, and tailing. But it taught me, again, not to trust a green checkmark I didn't earn.
