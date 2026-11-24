#!/bin/sh
# Serves the app for Playwright on the port given as $1.
# Rebuilds only when source changed since the last e2e build (marker: .next/e2e-built), because a
# full `next build` on every run is the slowest part of a local run. The build must happen here,
# not in a separate `pnpm build`, since the e2e environment (NEXT_PUBLIC_* values) is baked in.
# CI always starts clean, so it always builds.
set -e
PORT="${1:-3200}"
MARKER=".next/e2e-built"

stale=1
if [ -z "$CI" ] && [ -f "$MARKER" ]; then
  changed=$(find src next.config.ts postcss.config.mjs package.json pnpm-lock.yaml tsconfig.json \
    -newer "$MARKER" -type f 2>/dev/null | head -1)
  [ -z "$changed" ] && stale=0
fi

if [ "$stale" = 1 ]; then
  rm -f "$MARKER"
  next build
  touch "$MARKER"
else
  echo "e2e: reusing the existing build (no source changes since the last one)"
fi
exec next start -p "$PORT"
