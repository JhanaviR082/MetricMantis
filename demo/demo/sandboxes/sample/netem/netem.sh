#!/bin/sh
# Fixed egress netem for one verified container network namespace.
# Delay and loss come from server-validated integers. This script accepts no shell command.
set -eu
iface=eth0
delay=${MM_DELAY_MS:-0}
loss=${MM_LOSS_PERCENT:-0}
case "$delay" in
  ''|*[!0-9]*) echo "invalid delay" >&2; exit 1 ;;
esac
case "$loss" in
  ''|*[!0-9]*) echo "invalid loss" >&2; exit 1 ;;
esac
if [ "$delay" -gt 500 ] || [ "$loss" -gt 20 ]; then
  echo "fault is outside the server limit" >&2
  exit 1
fi
if [ "$delay" -gt 0 ]; then
  tc qdisc replace dev "$iface" root netem delay "${delay}ms"
elif [ "$loss" -gt 0 ]; then
  tc qdisc replace dev "$iface" root netem loss "${loss}%"
else
  echo "no fault requested" >&2
  exit 1
fi
tc qdisc show dev "$iface"
cleanup() {
  tc qdisc del dev "$iface" root 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT
while true; do
  sleep 1
done
