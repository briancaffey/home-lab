# HNFM → Jellyfin

Publish [hn.fm](https://hn.fm) video generations into Jellyfin as a richly-tagged
"Movies" library, served at <https://jellyfin.lan/>.

Each HN story becomes one "movie" folder (latest valid render only — so re-runs
and iteration runs never create duplicates):

```
/home/brian/media/hnfm/              (on a2 → mounted in the Jellyfin pod at /media/hnfm)
└── <Title> (YYYY)/
    ├── <Title> (YYYY).mp4           the video
    ├── <Title> (YYYY).nfo           Jellyfin/Kodi metadata (title, plot, genres, tags, date, HN id)
    ├── poster.jpg                   clean AI source image (falls back to a video frame)
    └── .hnfm.json                   provenance marker → idempotent re-runs
```

Metadata comes straight from HNFM's own output:
- **Title / author / score / source URL** ← `outputs/hn/item/<id>/item.json`
- **Plot, tagline, genres, tags, haiku** ← `outputs/hn/item/<id>/runs/<n>/processed.json`

## Usage

```bash
bash scripts/hnfm-jellyfin/sync.sh                       # convert + sync everything new
bash scripts/hnfm-jellyfin/sync.sh --force               # rebuild all (after editing the NFO template)
bash scripts/hnfm-jellyfin/sync.sh --only 48706825       # one or more HN ids
```

Requirements (on the Mac that has the hn.fm checkout): `python3`, `ffmpeg`,
`rsync`, and passwordless SSH to a2 (`brian@192.168.5.96`).

It's safe to run repeatedly: the converter skips items already current, and rsync
only ships changes — so a re-run only does work for newly generated videos.

## One-time Jellyfin library setup

Dashboard → Libraries → **Add Media Library**:
- **Content type:** Movies  ·  **Display name:** Hacker News FM
- **Folder:** `/media/hnfm`
- **Uncheck every online Metadata downloader + Image fetcher** (TheMovieDb/OMDb…)
  so Jellyfin uses only the local `.nfo` + `poster.jpg` instead of matching HN
  titles to real films.
- Keep **Enable real time monitoring** on so new drops appear automatically.

## Optional: auto-scan after sync

Set `JELLYFIN_API_KEY` and `sync.sh` will POST `/Library/Refresh` when it finishes
so new items appear immediately (otherwise they land on Jellyfin's next scheduled
scan / via real-time monitoring).

Create the key in Jellyfin: Dashboard → **API Keys** → `+`. Store it in Vaultwarden
(item "Jellyfin API key") rather than in a file, then:

```bash
export JELLYFIN_API_KEY="$(…fetch from Vaultwarden…)"
bash scripts/hnfm-jellyfin/sync.sh
```
