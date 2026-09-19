#!/bin/bash
# Starts the whole signal98 stack with one command.
#   1. builds the SDK's script-tag bundle (served by the desktop as /s98.js)
#   2. desktop on :3001 — backend (ingest, JEV classification, alerts, ghost) + Win98 monitor
#   3. playground on :3000 — a demo shop wrapped with the SDK, for breaking things on purpose
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_DIR="$ROOT/sdk"
DESKTOP_DIR="$ROOT/desktop"
PLAYGROUND_DIR="$ROOT/playground"

cleanup() {
  echo ""
  echo "→ stopping signal98…"
  kill 0 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# Free both ports first: a stale server would silently keep serving old code.
# ONLY processes started from this checkout are stopped. Ports 3000/3001 are popular; whatever
# else is listening there belongs to another project and is none of this script's business.
for p in 3000 3001; do
  for pid in $(lsof -ti tcp:$p -sTCP:LISTEN 2>/dev/null || true); do
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    case "$cwd" in
      "$ROOT"|"$ROOT"/*)
        echo "→ port $p is held by an earlier signal98 run (pid $pid) — stopping it…"
        kill "$pid" 2>/dev/null || true
        for _ in 1 2 3 4 5 6; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
        ;;
      *)
        echo "✗ port $p is in use by another program (pid $pid, running in ${cwd:-an unknown directory})."
        echo "  signal98 will not stop it. Free the port yourself, then run this again."
        exit 1
        ;;
    esac
  done
done

install_if_needed() {
  if [ ! -d "$1/node_modules" ]; then
    echo "→ installing $(basename "$1") dependencies (first run)…"
    (cd "$1" && npm install --no-audit --no-fund) || exit 1
  fi
}

install_if_needed "$SDK_DIR"
echo "→ building the SDK bundle → desktop/public/s98.js"
(cd "$SDK_DIR" && npm run build --silent) || { echo "✗ SDK build failed"; exit 1; }

install_if_needed "$DESKTOP_DIR"
echo "→ starting win98 desktop → http://localhost:3001"
(cd "$DESKTOP_DIR" && npm run dev) &

# wait until the backend answers before starting the playground
for i in $(seq 1 60); do
  curl -sf http://localhost:3001/api/overview >/dev/null 2>&1 && break
  sleep 1
done

install_if_needed "$PLAYGROUND_DIR"
echo "→ starting playground → http://localhost:3000"
(cd "$PLAYGROUND_DIR" && npm run dev) &

echo ""
echo "  ✓ signal98 stack up — Ctrl+C to stop"
echo "    monitor    → http://localhost:3001   (Live Feed, Issues, the ghost)"
echo "    demo shop  → http://localhost:3000   (break things here)"
if [ ! -f "$DESKTOP_DIR/.env.local" ] || ! grep -q '^TYPESAFE_API_KEY=.' "$DESKTOP_DIR/.env.local" 2>/dev/null; then
  echo "    ! no TYPESAFE_API_KEY in desktop/.env.local — a labelled heuristic is judging instead of JEV"
fi
wait
