#!/usr/bin/env bash
# golive.sh — bring up the whole live stack with one command:
#   * the cart WebSocket bridge  (../cart-api/cart serve  -> ws://localhost:8765)
#   * the drivelive web UI        (Next.js dev server   -> http://localhost:3001)
#
# The bridge runs in the FOREGROUND so you see live GPS/follow telemetry and can
# Ctrl-C to shut everything down. The web UI runs in the background; its log is
# tailed to web-ui.log next to this script.
#
# Any args are passed straight to the bridge, e.g.:
#   ./golive.sh                 full cart (gps + steering + pedals), no RTK
#   ./golive.sh --ntrip         also feed RTK corrections
#   ./golive.sh --gps-only      just show the cart on the map (no actuation)
#
# Mapbox token: set MAPBOX_TOKEN (or NEXT_PUBLIC_MAPBOX_TOKEN) in your env, or
# put NEXT_PUBLIC_MAPBOX_TOKEN=pk.xxx in drivelive/.env.local beforehand.
set -euo pipefail
cd "$(dirname "$0")"

WEB_DIR="drivelive"
WEB_LOG="$PWD/web-ui.log"
ENV_LOCAL="$WEB_DIR/.env.local"

# --- ensure the web UI has a Mapbox token ---------------------------------
TOKEN="${NEXT_PUBLIC_MAPBOX_TOKEN:-${MAPBOX_TOKEN:-}}"
if [ -n "$TOKEN" ]; then
  echo "NEXT_PUBLIC_MAPBOX_TOKEN=$TOKEN" > "$ENV_LOCAL"
elif ! grep -q 'NEXT_PUBLIC_MAPBOX_TOKEN=pk\.' "$ENV_LOCAL" 2>/dev/null; then
  echo "ERROR: no Mapbox token. Either:" >&2
  echo "  export MAPBOX_TOKEN=pk.your_token   (then re-run), or" >&2
  echo "  echo 'NEXT_PUBLIC_MAPBOX_TOKEN=pk.your_token' > $ENV_LOCAL" >&2
  exit 1
fi

# --- ensure web deps are installed ----------------------------------------
if [ ! -d "$WEB_DIR/node_modules" ]; then
  echo "[golive] installing web dependencies (first run)..."
  ( cd "$WEB_DIR" && npm install )
fi

# --- start the web UI in the background ------------------------------------
echo "[golive] starting drivelive web UI -> http://localhost:3001  (log: $WEB_LOG)"
( cd "$WEB_DIR" && npm run dev ) > "$WEB_LOG" 2>&1 &
WEB_PID=$!

# --- optionally bring up a Cloudflare tunnel -------------------------------
# Set CART_TUNNEL to a named cloudflared tunnel (config in
# ~/.cloudflared/config.yml) to expose the live cart feed publicly.
TUNNEL_PID=""
if [ -n "${CART_TUNNEL:-}" ]; then
  TUNNEL_LOG="$PWD/tunnel-live.log"
  echo "[golive] starting Cloudflare tunnel '$CART_TUNNEL'  (log: $TUNNEL_LOG)"
  cloudflared tunnel run "$CART_TUNNEL" > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
fi

cleanup() {
  echo
  echo "[golive] shutting down..."
  kill "$WEB_PID" $TUNNEL_PID 2>/dev/null || true
  wait "$WEB_PID" $TUNNEL_PID 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Give Next a moment, then surface any immediate startup failure.
sleep 2
if ! kill -0 "$WEB_PID" 2>/dev/null; then
  echo "[golive] web UI failed to start; last log lines:" >&2
  tail -20 "$WEB_LOG" >&2 || true
  exit 1
fi

echo "[golive] open http://localhost:3001 in your browser."
echo "[golive] starting cart bridge (Ctrl-C here stops everything)..."
echo "------------------------------------------------------------"

# --- run the bridge in the foreground (Ctrl-C falls through to cleanup) ----
../cart-api/cart serve "$@"
