#!/bin/bash
# Starts the whole signal98 stack with one command.
# Order matters: the desktop on :3001 is the backend (ingest + JEV judging),
# the playground on :3000 is the trigger panel that fires into it.
set -u

PLAYGROUND_DIR="$HOME/signal98/playground"
DESKTOP_DIR="$HOME/signal98/desktop"

cleanup() {
  echo ""
  echo "→ stopping signal98…"
  kill 0 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# Free both ports first: a previous run (or a zombie from one) may still hold
# them, and a stale server would silently keep serving old code.
for p in 3000 3001; do
  pid=$(lsof -ti tcp:$p 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "→ port $p is taken (process $pid) — stopping it…"
    kill "$pid" 2>/dev/null || true
    sleep 1
  fi
done

# win98 desktop (backend: ingest + judging) → :3001 — starts FIRST
if [ ! -d "$DESKTOP_DIR" ]; then
  echo "✗ win98 desktop not found at $DESKTOP_DIR"
  exit 1
fi
if [ ! -d "$DESKTOP_DIR/node_modules" ]; then
  echo "→ installing desktop dependencies (first run)…"
  (cd "$DESKTOP_DIR" && npm install)
fi
echo "→ starting win98 desktop → http://localhost:3001"
(cd "$DESKTOP_DIR" && npm run dev) &

# wait until the desktop backend answers before starting the playground
for i in $(seq 1 30); do
  if curl -sf http://localhost:3001/api/feed >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# playground (trigger panel) → :3000
if [ ! -d "$PLAYGROUND_DIR" ]; then
  echo "✗ playground not found at $PLAYGROUND_DIR"
  exit 1
fi
if [ ! -d "$PLAYGROUND_DIR/node_modules" ]; then
  echo "→ installing playground dependencies (first run)…"
  (cd "$PLAYGROUND_DIR" && npm install)
fi
echo "→ starting playground → http://localhost:3000"
(cd "$PLAYGROUND_DIR" && npm run dev) &

echo ""
echo "  ✓ signal98 stack up — Ctrl+C to stop both"
echo "    playground → http://localhost:3000 (set off errors)"
echo "    win98 desktop → http://localhost:3001 (Raw Feed window watches them land)"
wait
