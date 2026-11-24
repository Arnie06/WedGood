#!/bin/sh
# Run before a local e2e session: frees the e2e port from a leftover server (a stale one would be
# reused and test old code) and warns when the machine is already too busy for stable timings.
PORT="${1:-3200}"
pids=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)
if [ -n "$pids" ]; then
  echo "preflight: stopping the leftover server on port $PORT (pid $pids)"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
fi

cores=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
load=$(uptime | sed 's/.*load averages*: *//' | awk '{gsub(",", "", $1); print $1}')
busy=$(awk -v l="$load" -v c="$cores" 'BEGIN { print (l > c) ? 1 : 0 }')
if [ "$busy" = 1 ]; then
  echo "preflight: load average $load on $cores cores. Timeouts are likely; close heavy apps or wait."
  ps -Ao pid,etime,%cpu,command -r | head -6 | cut -c1-140
fi
exit 0
