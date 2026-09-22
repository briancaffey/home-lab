#!/usr/bin/env bash
# Node lockup guard — a3 thermal-runaway incident, 2026-09-22 (docs/22).
#
# What happened: on kernel 6.17.0-14 two processes (a root `fuser` reading
# /proc/*/maps and a `kubectl` page-faulting) hit a kernel bug in the
# maple-tree VMA walk (mas_walk / lock_next_vma / lock_vma_under_rcu) and
# spun inside the kernel at 100% on two cores for NINE HOURS
# ("watchdog: BUG: soft lockup - CPU#12 stuck for 30629s"). The box was hot
# to the touch, held rtnl_lock so networking/SSH died, k3s (sole control
# plane) went unresponsive, and nothing rebooted it until a hard power-off.
#
# This script makes a lockup self-terminating instead of a space heater:
#   1. sysctl: soft/hard lockup => panic => reboot (60s detection, 15s panic)
#   2. Intel PCH TCO hardware watchdog (iTCO_wdt) petted by systemd every
#      2 min — if even PID 1 is dead, the chipset resets the board.
#   3. CPU microcode from the OS (a3's 14900K was on BIOS microcode 0x11d,
#      before Intel's Raptor Lake Vmin-instability fix; intel-microcode had
#      been removed).
#   4. --kernel: install the Ubuntu 24.04 HWE kernel meta so the node
#      actually receives kernel updates (a3 had a bare 6.17.0-14 with NO
#      meta-package => never updated). Reboot afterwards.
#
# Idempotent. Run ON the node:  sudo bash node-lockup-guard.sh [--kernel]
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo/root"; exit 1; }
WANT_KERNEL=0; [ "${1:-}" = "--kernel" ] && WANT_KERNEL=1

echo "== $(hostname): kernel $(uname -r), microcode $(grep -m1 microcode /proc/cpuinfo | awk '{print $3}')"

# 1. Lockups reboot the node instead of spinning forever.
cat > /etc/sysctl.d/90-lockup-guard.conf <<'SYS'
# Managed by scripts/node-lockup-guard.sh (docs/22, a3 thermal runaway).
# A lockup must reboot the node, never spin. Soft lockup is declared after
# 2*watchdog_thresh = 60s; the panic reboots after kernel.panic seconds.
kernel.softlockup_panic = 1
kernel.hardlockup_panic = 1
kernel.watchdog_thresh = 30
kernel.panic = 15
SYS
sysctl -p /etc/sysctl.d/90-lockup-guard.conf >/dev/null
echo "sysctl: softlockup_panic=$(sysctl -n kernel.softlockup_panic) watchdog_thresh=$(sysctl -n kernel.watchdog_thresh) panic=$(sysctl -n kernel.panic)"

# 2. Hardware watchdog (Intel PCH TCO). Laptops/AMD boards may lack it —
#    that's fine, the sysctl guard still works.
#    Ubuntu kernel packages deny-list every watchdog driver
#    (/lib/modprobe.d/blacklist_linux*.conf) and systemd-modules-load honours
#    the deny-list, so a modules-load.d entry never loads at boot (found the
#    hard way on a3's first reboot). An explicit `modprobe` ignores the
#    blacklist, so a tiny oneshot unit does the loading; systemd arms the
#    device as soon as it appears.
if modprobe iTCO_wdt 2>/dev/null && [ -e /dev/watchdog0 ]; then
  rm -f /etc/modules-load.d/iTCO_wdt.conf
  cat > /etc/systemd/system/hw-watchdog.service <<'UNIT'
# Managed by scripts/node-lockup-guard.sh (docs/22, a3 thermal runaway).
# Ubuntu kernel packages deny-list every watchdog driver in
# /lib/modprobe.d/blacklist_linux*.conf and systemd-modules-load honours
# that list, so load the Intel PCH TCO watchdog with an explicit modprobe.
# systemd (RuntimeWatchdogSec in system.conf.d) arms it as soon as it appears.
[Unit]
Description=Load Intel PCH TCO hardware watchdog (iTCO_wdt)
DefaultDependencies=no
After=systemd-modules-load.service
Before=sysinit.target
ConditionPathExists=/sys/bus/pci/devices

[Service]
Type=oneshot
ExecStart=/sbin/modprobe iTCO_wdt
RemainAfterExit=yes

[Install]
WantedBy=sysinit.target
UNIT
  systemctl daemon-reload
  systemctl enable --now hw-watchdog.service >/dev/null 2>&1
  mkdir -p /etc/systemd/system.conf.d
  cat > /etc/systemd/system.conf.d/10-hw-watchdog.conf <<'WDT'
# Managed by scripts/node-lockup-guard.sh (docs/22). If PID 1 cannot pet the
# chipset watchdog for 2 minutes (hard lockup / dead kernel), the hardware
# resets the box instead of leaving it spinning hot and unreachable.
[Manager]
RuntimeWatchdogSec=120
RebootWatchdogSec=10min
WDT
  systemctl daemon-reexec
  echo "hw watchdog: $(systemctl show -p RuntimeWatchdogUSec --value) on $(systemctl show -p WatchdogDevice --value)"
else
  echo "hw watchdog: no iTCO_wdt device on this board — sysctl guard only"
fi

# 3. CPU microcode via the OS loader (applied at next boot).
export DEBIAN_FRONTEND=noninteractive
if grep -qi GenuineIntel /proc/cpuinfo; then
  dpkg -s intel-microcode >/dev/null 2>&1 || apt-get install -y intel-microcode
else
  dpkg -s amd64-microcode >/dev/null 2>&1 || apt-get install -y amd64-microcode
fi
echo "microcode package: $(dpkg-query -W -f='${Package} ${Version}\n' intel-microcode amd64-microcode 2>/dev/null | paste -sd' ')"

# 4. Kernel meta-package so the node keeps getting kernel fixes.
if [ "$WANT_KERNEL" = 1 ]; then
  apt-get install -y linux-generic-hwe-24.04
  echo "kernel meta installed; newest: $(ls /boot/vmlinuz-* | sort -V | tail -1). REBOOT to activate."
elif ! dpkg-query -W -f='${Package}\n' 'linux-generic*' 'linux-image-generic*' 2>/dev/null | grep -q .; then
  echo "WARNING: no linux-generic* meta-package — this kernel never gets updates. Re-run with --kernel."
fi
echo "OK on $(hostname)"
