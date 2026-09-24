"""
cartlib.ntrip — optional NTRIP corrections feeder for an RTK fix.

The u-blox receiver only reaches "RTK Fixed" when it's fed RTCM correction
data from an NTRIP caster. This module connects to the caster and streams
corrections into the GPS serial port in a background thread. It periodically
echoes the receiver's latest GGA back to the caster (VRS mountpoints need it).

Credentials are read from the environment (see ``_creds``). Run it
alongside a ``GpsReceiver`` pointed at the same device:

    gps = GpsReceiver().open()
    ntrip = NtripClient(gps).start()
    ...
    gps.wait_for_fix()   # should climb to "RTK Fixed" once corrections flow
"""

from __future__ import annotations

import base64
import os
import socket
import threading
import time
from typing import Optional

from .gps import GpsReceiver

FALLBACK_GGA = "$GPGGA,120000.00,3725.5900,N,12209.8400,W,1,12,0.8,30.0,M,-30.0,M,,*5E"

def _creds(prefix: str) -> dict:
    """Caster credentials come from the environment, never from source:
    NTRIP_<PROVIDER>_USER / NTRIP_<PROVIDER>_PASS (e.g. NTRIP_RTKDATA_USER)."""
    return {
        "username": os.environ.get(f"NTRIP_{prefix}_USER", ""),
        "password": os.environ.get(f"NTRIP_{prefix}_PASS", ""),
    }


# Selectable correction sources. The web UI can switch between these live; the
# key is what the browser sends, ``label`` is what it shows.
PROVIDERS = {
    "pointone": {
        "label": "Point One",
        "host": "virtualrtk.pointonenav.com", "port": 2101, "mountpoint": "AUTO",
        **_creds("POINTONE"),
    },
    "rtkdata": {
        "label": "RTKData",
        "host": "rtk.rtkdata.com", "port": 2101, "mountpoint": "AUTO",
        **_creds("RTKDATA"),
    },
    # CRTN (California Real Time Network, SOPAC/Scripps). Unlike the VRS casters
    # above, CRTN serves individual physical base stations — no AUTO/VRS — so we
    # pin the nearest one. SLAC (at Stanford, ~2 mi from the cart) on the Zone 3
    # server. See http://sopac-csrc.ucsd.edu/index.php/crtn-connecting/
    "crtn": {
        "label": "CRTN",
        "host": "132.239.152.4", "port": 2103, "mountpoint": "SLAC_RTCM3",
        **_creds("CRTN"),
    },
}
DEFAULT_PROVIDER = "rtkdata"

# Back-compat module-level defaults (some callers/tests import these).
NTRIP_HOST = PROVIDERS[DEFAULT_PROVIDER]["host"]
NTRIP_PORT = PROVIDERS[DEFAULT_PROVIDER]["port"]
MOUNTPOINT = PROVIDERS[DEFAULT_PROVIDER]["mountpoint"]
USERNAME = PROVIDERS[DEFAULT_PROVIDER]["username"]
PASSWORD = PROVIDERS[DEFAULT_PROVIDER]["password"]


class NtripClient:
    def __init__(self, gps: GpsReceiver, provider: str = DEFAULT_PROVIDER):
        self.gps = gps
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.connected = False
        # Guards the active-provider config + current socket so switch() can
        # change source and tear down the live connection from another thread.
        self._cfg_lock = threading.Lock()
        self._sock: Optional[socket.socket] = None
        self._switch = threading.Event()
        self._last_error: Optional[str] = None
        self.provider = provider
        cfg = PROVIDERS.get(provider, PROVIDERS[DEFAULT_PROVIDER])
        self.host, self.port, self.mountpoint = cfg["host"], cfg["port"], cfg["mountpoint"]
        self.username, self.password = cfg["username"], cfg["password"]

    def switch(self, provider: str) -> bool:
        """Switch the active correction source live. Returns False for an unknown
        provider or a no-op (already selected). Drops the current connection so
        the run loop immediately reconnects to the new caster."""
        if provider not in PROVIDERS:
            return False
        cfg = PROVIDERS[provider]
        sock = None
        with self._cfg_lock:
            if provider == self.provider:
                self._switch.set()
                sock = self._sock
                if sock is None:
                    return False
                try:
                    sock.close()
                except Exception:
                    pass
                return True
            self.provider = provider
            self.host, self.port, self.mountpoint = cfg["host"], cfg["port"], cfg["mountpoint"]
            self.username, self.password = cfg["username"], cfg["password"]
            self.connected = False
            self._last_error = None
            self._switch.set()
            sock = self._sock
        if sock is not None:
            try:
                sock.close()   # break the recv loop so we reconnect now
            except Exception:
                pass
        return True

    def status(self) -> dict:
        """Snapshot for the UI: which source is active and whether it's flowing."""
        with self._cfg_lock:
            return {
                "provider": self.provider,
                "label": PROVIDERS.get(self.provider, {}).get("label", self.provider),
                "connected": self.connected,
                "last_error": self._last_error,
            }

    def start(self) -> "NtripClient":
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        with self._cfg_lock:
            sock = self._sock
        if sock:
            try:
                sock.close()
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=2)

    def _gga(self) -> str:
        return self.gps.last_gga_raw or FALLBACK_GGA

    def _wait_for_real_gga(self, timeout: float = 5.0) -> None:
        """Give the receiver a moment to emit a real GGA before we connect, so
        VRS casters build the virtual base at our true position (not FALLBACK)."""
        deadline = time.time() + timeout
        while time.time() < deadline and not self.gps.last_gga_raw:
            if self._stop.is_set() or self._switch.is_set():
                return
            time.sleep(0.1)

    def _sleep_interruptible(self, seconds: float) -> None:
        deadline = time.time() + seconds
        while time.time() < deadline and not self._stop.is_set() and not self._switch.is_set():
            remaining = max(0.0, deadline - time.time())
            time.sleep(min(0.1, remaining))

    def _run(self) -> None:
        # How often we echo our position back to the caster. VRS/AUTO mountpoints
        # only START streaming once they have our GGA, and keep streaming the
        # right virtual base as we move, so send it briskly — once a second.
        GGA_INTERVAL = 1.0
        while not self._stop.is_set():
            sock = None
            try:
                self._wait_for_real_gga()
                # Snapshot the active provider for this connection. switch() may
                # change these mid-stream; we pick the new ones on reconnect.
                self._switch.clear()
                with self._cfg_lock:
                    host, port, mountpoint = self.host, self.port, self.mountpoint
                    username, password = self.username, self.password
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                with self._cfg_lock:
                    self._sock = sock
                    self.connected = False
                    self._last_error = None
                sock.settimeout(10)
                sock.connect((host, port))
                creds = base64.b64encode(f"{username}:{password}".encode()).decode()
                req = (
                    f"GET /{mountpoint} HTTP/1.1\r\n"
                    f"Host: {host}\r\n"
                    f"Ntrip-Version: Ntrip/2.0\r\n"
                    f"User-Agent: NTRIP cartlib/1.0\r\n"
                    f"Authorization: Basic {creds}\r\n"
                    f"Accept: */*\r\n\r\n"
                )
                sock.sendall(req.encode())
                sock.sendall((self._gga() + "\r\n").encode())

                resp = b""
                while b"\r\n\r\n" not in resp:
                    chunk = sock.recv(1024)
                    if not chunk:
                        break
                    resp += chunk
                header, _, remainder = resp.partition(b"\r\n\r\n")
                if b"200" not in header:
                    with self._cfg_lock:
                        self.connected = False
                        self._last_error = header.decode("ascii", "ignore").splitlines()[0] if header else "empty NTRIP response"
                    self._sleep_interruptible(5)
                    continue
                with self._cfg_lock:
                    self.connected = True
                    self._last_error = None
                if remainder:
                    self.gps.write_corrections(remainder)

                # Short recv timeout so a silent stream still lets us re-send GGA
                # on schedule — the caster won't start streaming until it does.
                sock.settimeout(1)
                last_gga = time.time()
                while not self._stop.is_set() and not self._switch.is_set():
                    if time.time() - last_gga >= GGA_INTERVAL:
                        last_gga = time.time()
                        try:
                            sock.sendall((self._gga() + "\r\n").encode())
                        except OSError:
                            break
                    try:
                        data = sock.recv(4096)
                        if not data:
                            break
                        self.gps.write_corrections(data)
                    except socket.timeout:
                        continue
                    except OSError:
                        break   # socket closed by switch()
            except Exception as e:
                with self._cfg_lock:
                    self.connected = False
                    if not self._stop.is_set() and not self._switch.is_set():
                        self._last_error = str(e)
            finally:
                with self._cfg_lock:
                    self._sock = None
                    self.connected = False
                if sock:
                    try:
                        sock.close()
                    except Exception:
                        pass
            # A live switch reconnects immediately; otherwise back off briefly so
            # we don't hammer a flaky caster on repeated drops.
            if not self._switch.is_set():
                self._sleep_interruptible(3)
