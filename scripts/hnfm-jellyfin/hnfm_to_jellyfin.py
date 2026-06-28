#!/usr/bin/env python3
"""Convert HNFM outputs into a Jellyfin 'Movies' library (NFO + poster per item).

Layout produced (one folder per HN story, latest valid render = dedup):
  <out>/<Title> (YYYY)/
      <Title> (YYYY).mp4      the video
      <Title> (YYYY).nfo      Kodi/Jellyfin movie metadata
      poster.jpg              clean AI source image (fallback: video frame)
      .hnfm.json              provenance marker -> idempotent re-runs

Usage:
  hnfm_to_jellyfin.py <outputs/hn/item> <out_root> [--force] [--only ID,ID]
"""
from __future__ import annotations
import json, re, sys, subprocess, argparse, shutil, glob
from pathlib import Path
from datetime import datetime, timezone
from xml.sax.saxutils import escape

def pick_run(item_dir: Path, run=None):
    cands = []
    for d in sorted((item_dir / "runs").glob("*"),
                    key=lambda p: int(p.name) if p.name.isdigit() else -1):
        if not d.name.isdigit():
            continue
        vid = d / "segments/1/video/segment.mp4"
        if vid.exists() and vid.stat().st_size > 100_000:
            cands.append((int(d.name), d, vid))
    if not cands:
        return None
    if run is not None:
        return next(((n, d, v) for n, d, v in cands if n == run), None)
    return cands[-1]

def find_poster_src(run_dir: Path):
    # prefer the opening shot's clean (caption-free) generated image
    first = run_dir / "segments/1/images/1/image.png"
    if first.exists():
        return first
    imgs = sorted(run_dir.glob("segments/*/images/*/image.png"),
                  key=lambda p: (int(p.parent.name) if p.parent.name.isdigit() else 999))
    return imgs[0] if imgs else None

def sanitize(name: str) -> str:
    name = name.replace("&", "and")
    name = re.sub(r'[/\\:*?"<>|]', "", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:120].rstrip(". ")

def build_nfo(item, proc, year, premiered):
    title = item.get("title") or f"HN item {item.get('id')}"
    tags = proc.get("tags") or []
    emoji = "".join(proc.get("emoji") or [])
    haiku = (proc.get("haiku") or "").strip()
    short = (proc.get("short_description") or "").strip()
    summary = (proc.get("summary") or "").strip()
    by = item.get("by", "?"); score = item.get("score", "?")
    src = item.get("url") or proc.get("source_url") or ""
    hn_url = f"https://news.ycombinator.com/item?id={item.get('id')}"
    parts = [p for p in (short, summary if summary != short else "",
                         ("— Haiku —\n" + haiku) if haiku else "") if p]
    parts.append(f"Source: {src}\nHacker News: {hn_url} (score {score}, by {by})")
    plot = "\n\n".join(parts)
    genres = "".join(f"  <genre>{escape(t)}</genre>\n" for t in tags)
    tagxml = "".join(f"  <tag>{escape(t)}</tag>\n" for t in list(tags) + ["Hacker News FM", f"by {by}"])
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>{escape(title)} {emoji}</title>
  <originaltitle>{escape(title)}</originaltitle>
  <sorttitle>{escape(premiered)} {escape(title)}</sorttitle>
  <tagline>{escape(short[:200])}</tagline>
  <plot>{escape(plot)}</plot>
  <outline>{escape(short)}</outline>
  <year>{year}</year>
  <premiered>{premiered}</premiered>
  <releasedate>{premiered}</releasedate>
  <studio>Hacker News FM</studio>
{genres}{tagxml}  <uniqueid type="hackernews" default="true">{item.get('id')}</uniqueid>
  <lockdata>false</lockdata>
</movie>
"""

def convert(item_dir: Path, out_root: Path, force=False):
    item = json.load(open(item_dir / "item.json"))
    iid = item.get("id")
    picked = pick_run(item_dir, None)
    if not picked:
        return ("skip-novideo", None)
    runno, run_dir, vid = picked
    vmtime = int(vid.stat().st_mtime)

    proc = json.load(open(run_dir / "processed.json"))
    try:
        dt = datetime.fromisoformat(proc.get("created_at") or "")
    except Exception:
        dt = datetime.fromtimestamp(item.get("time", 0), tz=timezone.utc)
    year, premiered = f"{dt.year:04d}", dt.strftime("%Y-%m-%d")

    folder = out_root / f"{sanitize(item.get('title') or f'HN {iid}')} ({year})"
    marker = folder / ".hnfm.json"
    if marker.exists() and not force:
        m = json.loads(marker.read_text())
        if m.get("item_id") == iid and m.get("run") == runno and m.get("video_mtime") == vmtime:
            return ("skip-current", folder)

    folder.mkdir(parents=True, exist_ok=True)
    base = folder.name
    dst = folder / f"{base}.mp4"
    if dst.exists(): dst.unlink()
    shutil.copy2(vid, dst)
    (folder / f"{base}.nfo").write_text(build_nfo(item, proc, year, premiered))

    poster = folder / "poster.jpg"
    src_img = find_poster_src(run_dir)
    made = False
    if src_img:
        r = subprocess.run(["ffmpeg","-y","-loglevel","error","-i",str(src_img),
                            "-q:v","2", str(poster)], check=False)
        made = poster.exists() and poster.stat().st_size > 0
    if not made:  # fallback: frame ~35% into the video
        dur = 6.0
        try:
            pr = subprocess.run(["ffprobe","-v","quiet","-show_entries","format=duration",
                                 "-of","csv=p=0", str(vid)], capture_output=True, text=True)
            dur = float(pr.stdout.strip() or 6.0)
        except Exception: pass
        subprocess.run(["ffmpeg","-y","-loglevel","error","-ss",f"{max(0.5,dur*0.35)}",
                        "-i",str(vid),"-frames:v","1","-q:v","2", str(poster)], check=False)

    marker.write_text(json.dumps({"item_id": iid, "run": runno,
                                  "video_mtime": vmtime, "poster_from": str(src_img) if src_img else "frame"}))
    return ("built", folder)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("item_root")
    ap.add_argument("out_root")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", default="", help="comma-separated HN ids")
    args = ap.parse_args()
    only = {x.strip() for x in args.only.split(",") if x.strip()}
    out_root = Path(args.out_root)
    dirs = [Path(d) for d in glob.glob(str(Path(args.item_root) / "*")) if (Path(d) / "item.json").exists()]
    counts = {}
    for d in sorted(dirs):
        if only and d.name not in only:
            continue
        try:
            status, _ = convert(d, out_root, args.force)
        except Exception as e:
            status = "error"; print(f"  ERROR {d.name}: {e}", file=sys.stderr)
        counts[status] = counts.get(status, 0) + 1
    print("summary:", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))

if __name__ == "__main__":
    main()
