# Drive by RTK

Centimeter-level waypoint following. Draw lanes on a map, pick a route, and
the cart drives it using an **RTK-corrected u-blox ZED-F9x** fix and a
pure-pursuit path follower from [`cart-api`](../../cart-api).

## Layout

| Path | What it does |
|------|--------------|
| `golive.sh` | One command: cart WebSocket bridge (`ws://localhost:8765`) + drivelive UI (`http://localhost:3001`). |
| `drivelive/` | Next.js + Mapbox operator UI: live GPS, route graph, click-to-drive, NTRIP toggle, follow telemetry. |
| `lane-annotator/` | Express + Mapbox tool for drawing lane centerlines on campus (`npm start` → `:3000`). |
| `maps/` | Annotated lane maps (Stanford campus). |
| `rtk-sensor-live/` | Standalone NTRIP + NMEA → WebSocket → Leaflet live tracker. |
| `sample-drives/` | Recorded `last_drive.json` traces from real runs, for replay and tuning. |

## Quick start

```bash
# Mapbox token for the UI
export MAPBOX_TOKEN=pk.your_token

# NTRIP caster credentials (for RTK Fixed); see cart-api/cartlib/ntrip.py
export NTRIP_RTKDATA_USER=...  NTRIP_RTKDATA_PASS=...

./golive.sh --ntrip          # full cart
./golive.sh --gps-only       # just show the cart on the map
```

Open `http://localhost:3001`, pick a route, and press **Drive Route**. Keep a
hand on the hardware e-stop.

Set `CART_TUNNEL=<cloudflared tunnel name>` to also expose the live feed
through a Cloudflare tunnel.

### Record and replay paths from the CLI

```bash
../../cart-api/cart record paths/my_loop.json --ntrip   # drive manually, record
../../cart-api/cart follow paths/my_loop.json           # dry run
../../cart-api/cart drive  paths/my_loop.json --max-speed 0.12
```
