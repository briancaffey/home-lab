---
title: "An App With One Hostname Is an App With One Bug"
authors: brian
tags: [hn.fm, tailscale, networking, lessons]
description: "Putting hn.fm on the tailnet took a two-minute Ingress and then broke three ways at once. None of the fixes were in the cluster — they were all places the app had quietly assumed it lived at exactly one address."
draft: true
---

The quick honest take: I gave [hn.fm](/media/hnfm) — my Hacker News-to-video app — a second front door this week, a tailnet hostname next to its `hnfm.lan` address, so I can watch the day's renders from anywhere without opening a port. The Kubernetes side was trivial: one more Tailscale Ingress mirroring the same path table, one more tile in Homepage's "Tailnet" group. Then the page loaded on the new name and did absolutely nothing. That failure is the interesting part, because every cause was in *my* code, and every one of them was the same mistake wearing a different costume.

<!-- truncate -->

## Three symptoms, one disease

**The frontend called the wrong house.** The Nuxt app had an absolute API base — `NUXT_PUBLIC_API_BASE=https://hnfm.lan` — baked in at build time. A browser on the tailnet name rendered the shell, then went looking for the API on the LAN name, which it couldn't reach. Perfectly correct behaviour for an app that believes it has one address.

**CORS agreed with it.** The backend allowed exactly one origin: `https://hnfm.lan`. Even if the frontend had guessed the right API host, a browser on the tailnet name would have been refused.

**The media URLs were signed for the wrong host.** This one I didn't see coming. Media is served from a MinIO bucket via presigned URLs, and a presigned URL is signed for a specific `Host`. A link signed for `hnfm.lan`, fetched via the tailnet name, comes back as `SignatureDoesNotMatch`. The video *is* there; the signature just says you asked for it from the wrong door.

Three unrelated-looking failures — a frontend env var, a CORS list, an S3 signature — and one root cause: **the app assumed it had exactly one hostname.**

## Every fix was in the app

Nothing in the cluster changed after the Ingress. All of it landed in the hn.fm repo:

- **Empty API base.** `NUXT_PUBLIC_API_BASE` is now blank, so the browser calls `/api` on whichever host served the page. Same-origin, which also makes the CORS question disappear entirely.
- **A tiny server-side proxy.** Server-side rendering can't use a relative URL — there's no page origin yet. So a Nitro catch-all route forwards `/api` to the web Service inside the cluster (`http://hnfm-web:8000`). The browser and the SSR pass now take different routes to the same backend, and neither needs to know a public hostname.
- **Sign for the door they knocked on.** The media endpoints now build presigned URLs for the origin the request *arrived on* — `X-Forwarded-Host` and `X-Forwarded-Proto`, falling back to `Host` — whenever the public media URL shares the API's host. Ask from the LAN name, get a link signed for the LAN name; ask from the tailnet, get one signed for the tailnet.

After that, the same deployment answers correctly on both names, and the Tailscale Ingress file in `clusters/home/tailscale/` is just a faithful mirror of the chart's path table with a loud comment saying "if a path is added there, add it here."

## The rule I'm keeping

I write a lot of small services for this lab, and I'm now treating "one hostname" as a smell during review. The three things to look for are the three things that bit me:

1. **Absolute public URLs in environment variables.** If a build-time or runtime variable contains a hostname a *browser* will use, that's a second-hostname bug waiting to happen. Prefer relative URLs; derive the origin from the request.
2. **Single-origin CORS.** Usually a symptom of the first problem. Same-origin design mostly removes the need.
3. **Host-bound signatures.** Presigned S3 URLs, signed cookies, anything with the host in the HMAC. Sign for the host the request came from, not the one you configured on day one.

None of this is novel — it's the ordinary twelve-factor advice about not hardcoding environment — but I'd only ever heard it as *deployment* hygiene. This was the first time I felt it as a *networking* constraint: the moment a service gets a second name, every hidden assumption about the first one becomes a bug. The tailnet ACL is still the gate for hn.fm (it has no login of its own, and the tailnet is default-deny), so the security posture didn't move. The app just stopped believing it lived at one address, which is what an app on a cluster should have believed all along.
