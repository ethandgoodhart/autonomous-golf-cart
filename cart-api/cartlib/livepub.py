"""
cartlib.livepub — publish the cart's live GPS fix to the production Cloudflare
tunnel.

The old production tunnel (``caddy.ethandgoodhart.com``, see
``~/.cloudflared/config.yml``) forwards to ``http://127.0.0.1:5050``. So all we
have to do is run a tiny HTTP server on that port that hands back the latest
fix. Whenever the RTK GPS reader is running, open the tunnel in a browser and
you'll see the golf cart's live coordinates.

Usage (already wired into ``GpsReceiver.open``)::

    from cartlib.livepub import start_live_publisher
    start_live_publisher(lambda: gps.latest)
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional

LIVE_HOST = "127.0.0.1"
LIVE_PORT = 5050  # matches ~/.cloudflared/config.yml ingress service

_PAGE = """<!doctype html><meta charset=utf-8><title>Cart live location</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;margin:2rem;font-size:1.2rem}
a{color:#06c}.muted{color:#888}</style>
<h1>\U0001F6FA Cart live location</h1>
<pre id=out class=muted>waiting for fix…</pre>
<p><a id=map href=# target=_blank>open in Google Maps</a></p>
<script>
async function tick(){
  try{
    const f = await (await fetch('coords.json',{cache:'no-store'})).json();
    if(f && f.lat!=null){
      document.getElementById('out').className='';
      document.getElementById('out').textContent =
        `lat ${f.lat}\\nlon ${f.lon}\\nfix ${f.fix_type} • ${f.sats} sats • hdop ${f.hdop}`;
      document.getElementById('map').href =
        `https://maps.google.com/?q=${f.lat},${f.lon}`;
    }else{
      document.getElementById('out').textContent='no fix yet…';
    }
  }catch(e){ document.getElementById('out').textContent='cart offline'; }
}
tick(); setInterval(tick, 1000);
</script>
"""

_server: Optional[ThreadingHTTPServer] = None
_command_handler: Optional[Callable[[str, dict], dict]] = None
_pending_destination: Optional[tuple] = None  # (lat, lon)


def set_command_handler(handler: Callable[[str, dict], dict]) -> None:
    """Register a callback for remote commands (called from server.py)."""
    global _command_handler
    _command_handler = handler


def start_live_publisher(get_fix: Callable[[], Optional[dict]]) -> None:
    """Start (once) a background HTTP server that serves the latest fix."""
    global _server
    if _server is not None:
        return

    class Handler(BaseHTTPRequestHandler):
        def _send(self, body: bytes, ctype: str) -> None:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, obj: dict) -> None:
            self._send(json.dumps(obj).encode(), "application/json")

        def _read_body(self) -> dict:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                return json.loads(raw)
            except (ValueError, TypeError):
                return {}

        def do_GET(self) -> None:
            if self.path.startswith("/coords.json"):
                self._send(json.dumps(get_fix() or {}).encode(), "application/json")
            elif self.path.startswith("/api/status"):
                if _command_handler:
                    self._send_json(_command_handler("status", {}))
                else:
                    self._send_json({"ok": False, "reason": "not ready"})
            else:
                self._send(_PAGE.encode(), "text/html; charset=utf-8")

        def do_POST(self) -> None:
            global _pending_destination
            data = self._read_body()

            if self.path == "/api/destination":
                lat = data.get("lat")
                lon = data.get("lon")
                if lat is not None and lon is not None:
                    _pending_destination = (float(lat), float(lon))
                    print(f"[livepub] destination set: {_pending_destination}")
                    # Push the pin to the drivelive UI right away so the operator
                    # sees the destination + planned purple route before starting.
                    if _command_handler:
                        _command_handler("destination", {"destination": _pending_destination})
                    self._send_json({"ok": True, "lat": lat, "lon": lon})
                else:
                    self._send_json({"ok": False, "reason": "need lat and lon"})

            elif self.path == "/api/start":
                if data.get("lat") is not None and data.get("lon") is not None:
                    _pending_destination = (float(data["lat"]), float(data["lon"]))
                if _pending_destination is None:
                    self._send_json({"ok": False, "reason": "no destination set"})
                elif _command_handler:
                    result = _command_handler("start", {"destination": _pending_destination})
                    self._send_json(result)
                else:
                    self._send_json({"ok": False, "reason": "cart not ready"})

            elif self.path == "/api/stop":
                emergency = bool(data.get("emergency", False))
                if _command_handler:
                    result = _command_handler("stop", {"emergency": emergency})
                    self._send_json(result)
                else:
                    self._send_json({"ok": False, "reason": "cart not ready"})

            else:
                self.send_error(404)

        def log_message(self, *args) -> None:  # keep the console quiet
            pass

    try:
        _server = ThreadingHTTPServer((LIVE_HOST, LIVE_PORT), Handler)
    except OSError:
        # Port already taken (publisher running elsewhere) — not fatal.
        return
    threading.Thread(target=_server.serve_forever, daemon=True).start()
