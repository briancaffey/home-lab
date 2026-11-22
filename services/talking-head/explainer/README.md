# Explainer clips

Short narrated clips that show how each round was made: the clip itself next to
the stages, models, licences, hardware and timings. Built with
[HyperFrames](https://github.com/heygen-com/hyperframes) (HTML + a GSAP timeline,
rendered to MP4 by headless Chrome). One folder per clip.

The palette and type at the top of each `index.html` are the series kit: dark
study wall, lamp-warm accent, monospace for anything measured. Reuse them.

## how-round-2

"One typed sentence, three steps", 22 s, 1920x1080.

Media is not committed. To rebuild `assets/`:

- `clip.mp4`: the round 2 render, looped to 22 s, scaled to 540x960, no audio.
- `n1.wav`, `n2.wav`, `n3.wav`: narration from Dia, cloned from the round's own
  speech (`audio_prompt` = that WAV, `audio_prompt_text` = its line). With a voice
  prompt, add about 750 to `max_new_tokens` or the line is cut short.

```bash
npx hyperframes@0.9.81 check
npx hyperframes@0.9.81 render -o renders/how-round-2.mp4
```

The render took 7 minutes on a laptop.
