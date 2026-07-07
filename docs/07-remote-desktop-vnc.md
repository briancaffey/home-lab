# 07 — Remote desktop (VNC)

Reliable GUI access to every node from a laptop, for the things that must be done
in a desktop UI. Each node runs a **persistent TigerVNC + Xfce virtual desktop**
managed by **systemd** (`tigervncserver@:N`), so it auto-starts on boot and your
session resumes exactly where you left off on reconnect — independent of the
physical monitor, Wayland, or who's logged in.

> This is host-level, **not** k3s. Setup script: `scripts/vnc-setup.sh`.

## Connect (from VNC Viewer on the Mac)

Prefer the **Tailscale** address — VNC traffic is unencrypted, but the Tailscale
(WireGuard) tunnel encrypts it end-to-end, so it's safe even off-LAN. The LAN
address is plaintext (fine on the trusted home LAN only).

| node  | Tailscale (encrypted) | LAN          | display |
|-------|-----------------------|--------------|---------|
| a1    | `a1.<tailnet>.ts.net:5901`    | `a1:5901`    | :1 |
| a2    | `a2.<tailnet>.ts.net:5902`    | `a2:5902`    | :2 (physical X11 desktop owns :1) |
| a3    | `a3.<tailnet>.ts.net:5901` | `a3:5901`    | :1 |
| spark | `spark.<tailnet>.ts.net:5901`  | `spark:5901` | :1 |

(VNC Viewer warns about an unencrypted connection — expected; dismiss it when
using the Tailscale addresses; MagicDNS names resolve to the tailnet 100.x IPs.)

## Set up / re-do a node

Run on the node (needs sudo; the script is idempotent and auto-picks a free
display):

```bash
scp scripts/vnc-setup.sh <node>:/tmp/ && ssh -t <node> 'sudo bash /tmp/vnc-setup.sh'
```

It installs TigerVNC + Xfce, removes the old failed `x11vnc` service, writes
`~/.vnc/config` (`session=xfce`, `localhost=no` so it listens on all interfaces),
maps the display in `/etc/tigervnc/vncserver.users`, and enables
`tigervncserver@:N`. First run prompts for a VNC password (≤ 8 chars, RFB limit).

## How it works / why this design

- **Virtual desktop, not screen-mirror.** Ubuntu 24.04's GDM defaults to
  **Wayland**, which `x11vnc` (the old approach) cannot capture — that's why the
  previous `x11vnc.service` setups failed/looped. A standalone TigerVNC virtual
  desktop sidesteps Wayland entirely and is deterministic.
- **Persistent:** disconnect/reconnect resumes the same session. A node reboot
  starts a fresh desktop (systemd auto-starts it).
- **Free-display auto-pick:** if a physical desktop already owns `:1` (a2), the
  script falls through to `:2` → port 5902.

## Reachability requires the tailnet ACL grant

The tailnet is **default-deny**. Reaching a node over its `100.x` IP (VNC, SSH,
NodePort) needs an `autogroup:member → autogroup:member` grant in the Tailscale
ACL (already in place). Note: `tailscale ping <node>` can succeed while TCP is
still ACL-blocked — verify a port with `nc -vz <tailnet-ip> <port>`. SSH to the
nodes uses LAN IPs (`~/.ssh/config`), so SSH working ≠ tailnet reachable.

## Common tasks

- **Change the VNC password:** `ssh <node>` then `vncpasswd`.
- **Change resolution:** re-run with `VNC_GEOMETRY=2560x1440 sudo -E bash /tmp/vnc-setup.sh`.
- **spark:** must be logged into Tailscale (`sudo tailscale up`) for the tailnet
  address; LAN works regardless.
- **a1:** flaky USB WiFi — run the (few-hundred-MB) install only when the link is
  stable.

## Known leftovers

- a2 has an unidentified listener on `:59405` (pre-existing); harmless to this
  setup. tightvnc is also still installed on a2 (unused) alongside TigerVNC.
- Mirroring a *running* login session (vs the virtual desktop) only works for
  X11 sessions, so only a2 (logged-in X11) is a candidate — not done by default.
