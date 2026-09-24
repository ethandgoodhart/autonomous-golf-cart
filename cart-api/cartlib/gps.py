"""
cartlib.gps — RTK GPS receiver interface (u-blox ZED-F9x over USB).

Reads NMEA GGA sentences from the u-blox receiver in a background thread and
exposes the latest fix as a simple dict. This is read-only; feeding NTRIP
corrections (needed to reach an "RTK Fix") is handled separately by
``cartlib.ntrip`` so you can run the GPS reader with or without corrections.

Example
-------
    from cartlib.gps import GpsReceiver

    with GpsReceiver() as gps:
        fix = gps.wait_for_fix(timeout=5)
        print(fix["lat"], fix["lon"], fix["fix_type"])
"""

from __future__ import annotations

import threading
import time
from typing import Optional

import serial

from . import config

# NMEA fix-quality codes from the GGA sentence (field 6).
FIX_TYPES = {
    0: "No fix",
    1: "GPS",
    2: "DGPS",
    4: "RTK Fixed",
    5: "RTK Float",
}

NAV_RATE_HZ = 10
_UBX_SYNC = b"\xb5\x62"

# CFG-VALSET keys used by u-blox F9 receivers. The port-specific MSGOUT keys
# are configured for both USB (/dev/ttyACM*) and UART1 so the cart and the old
# Mac live tracker get the same GGA-only stream shape at a stable 10 Hz.
_CFG_RATE_MEAS = 0x30210001
_CFG_RATE_NAV = 0x30210002
_CFG_USBINPROT_UBX = 0x10770001
_CFG_USBINPROT_NMEA = 0x10770002
_CFG_USBINPROT_RTCM3X = 0x10770004
_CFG_USBOUTPROT_NMEA = 0x10780002
_CFG_UART1_BAUDRATE = 0x40520001

_NMEA_MSGOUT_UART1 = {
    "GGA": 0x209100BB,
    "GLL": 0x209100CA,
    "GSA": 0x209100C0,
    "GSV": 0x209100C5,
    "RMC": 0x209100AC,
    "VTG": 0x209100B1,
}
_NMEA_MSGOUT_USB = {
    "GGA": 0x209100BD,
    "GLL": 0x209100CC,
    "GSA": 0x209100C2,
    "GSV": 0x209100C7,
    "RMC": 0x209100AE,
    "VTG": 0x209100B3,
}
_UBX_MSGOUT_UART1 = {
    "NAV_PVT": 0x20910007,
}
_UBX_MSGOUT_USB = {
    "NAV_PVT": 0x20910009,
}


def _ubx_checksum(payload: bytes) -> bytes:
    ck_a = 0
    ck_b = 0
    for b in payload:
        ck_a = (ck_a + b) & 0xFF
        ck_b = (ck_b + ck_a) & 0xFF
    return bytes((ck_a, ck_b))


def _ubx_cfg_valset(keys_values: list[tuple[int, bytes]]) -> bytes:
    payload = b"\x00\x01\x00\x00"  # version=0, layer=RAM
    for key_id, value in keys_values:
        payload += key_id.to_bytes(4, "little") + value
    msg = b"\x06\x8a" + len(payload).to_bytes(2, "little") + payload
    return _UBX_SYNC + msg + _ubx_checksum(msg)


def _configure_receiver(ser: serial.Serial) -> None:
    meas_period_ms = int(1000 / NAV_RATE_HZ)
    msg_rates: list[tuple[int, bytes]] = [
        (_CFG_RATE_MEAS, meas_period_ms.to_bytes(2, "little")),
        (_CFG_RATE_NAV, (1).to_bytes(2, "little")),
        (_CFG_UART1_BAUDRATE, config.GPS_BAUD.to_bytes(4, "little")),
        (_CFG_USBINPROT_UBX, b"\x01"),
        (_CFG_USBINPROT_NMEA, b"\x01"),
        (_CFG_USBINPROT_RTCM3X, b"\x01"),
        (_CFG_USBOUTPROT_NMEA, b"\x01"),
    ]
    for outputs in (_NMEA_MSGOUT_UART1, _NMEA_MSGOUT_USB):
        for name, key in outputs.items():
            msg_rates.append((key, b"\x01" if name == "GGA" else b"\x00"))
    for outputs in (_UBX_MSGOUT_UART1, _UBX_MSGOUT_USB):
        for key in outputs.values():
            msg_rates.append((key, b"\x00"))

    ser.write(_ubx_cfg_valset(msg_rates))
    ser.flush()
    time.sleep(0.25)
    if ser.in_waiting:
        ser.read(ser.in_waiting)


def _parse_gga(line: str) -> Optional[dict]:
    """Parse a $--GGA sentence into a fix dict, or None if it isn't a fix."""
    start = line.find("$")
    if start > 0:
        line = line[start:]
    parts = line.split(",")
    if len(parts) < 10 or not parts[2]:
        return None
    try:
        lat_raw = float(parts[2])
        lat = int(lat_raw / 100) + (lat_raw % 100) / 60.0
        if parts[3] == "S":
            lat = -lat
        lon_raw = float(parts[4])
        lon = int(lon_raw / 100) + (lon_raw % 100) / 60.0
        if parts[5] == "W":
            lon = -lon
        fix_code = int(parts[6])
        return {
            "lat": round(lat, 8),
            "lon": round(lon, 8),
            "fix_code": fix_code,
            "fix_type": FIX_TYPES.get(fix_code, f"code {fix_code}"),
            "sats": int(parts[7]) if parts[7] else 0,
            "hdop": float(parts[8]) if parts[8] else 0.0,
            "alt": float(parts[9]) if parts[9] else 0.0,
            "ts": time.time(),
        }
    except (ValueError, IndexError):
        return None


class GpsReceiver:
    """Background NMEA reader for the u-blox RTK receiver."""

    def __init__(self, port: Optional[str] = None, baud: int = config.GPS_BAUD):
        self._requested_port = port
        self.port = port
        self.baud = baud
        self._ser: Optional[serial.Serial] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._io_lock = threading.RLock()
        self._latest: Optional[dict] = None
        self._fix_count = 0
        # Allow callers/NTRIP to grab the raw serial handle to send GGA back.
        self.last_gga_raw: Optional[str] = None

    # -- lifecycle ---------------------------------------------------------
    def open(self) -> "GpsReceiver":
        self._open_serial_locked()
        self._stop.clear()
        self._thread = threading.Thread(target=self._reader, daemon=True)
        self._thread.start()
        # Publish the live fix to the production Cloudflare tunnel in the
        # background (caddy.ethandgoodhart.com -> 127.0.0.1:5050).
        from .livepub import start_live_publisher
        start_live_publisher(lambda: self.latest)
        return self

    def close(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        with self._io_lock:
            if self._ser and self._ser.is_open:
                self._ser.close()
            self._ser = None

    def __enter__(self) -> "GpsReceiver":
        return self.open()

    def __exit__(self, *exc) -> None:
        self.close()

    # -- reads -------------------------------------------------------------
    @property
    def latest(self) -> Optional[dict]:
        """Most recent fix dict, or None if nothing parsed yet."""
        with self._lock:
            return dict(self._latest) if self._latest else None

    @property
    def fix_count(self) -> int:
        """Number of parsed GGA fixes since the receiver was opened."""
        with self._lock:
            return self._fix_count

    def wait_for_fix(self, timeout: float = 10.0, require_position: bool = True):
        """Block until a fix is available (optionally with a valid position)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            fix = self.latest
            if fix and (not require_position or fix["fix_code"] > 0):
                return fix
            time.sleep(0.05)
        return self.latest

    def write_corrections(self, data: bytes) -> None:
        """Write RTCM correction bytes to the receiver, reopening the USB serial
        port once if the device briefly disconnected/re-enumerated."""
        if not data:
            return
        try:
            with self._io_lock:
                if not self._ser or not self._ser.is_open:
                    self._open_serial_locked()
                self._ser.write(data)
        except Exception as first_error:
            with self._io_lock:
                self._close_serial_locked()
                try:
                    self._open_serial_locked()
                    self._ser.write(data)
                except Exception as second_error:
                    self._close_serial_locked()
                    raise RuntimeError(
                        f"GPS serial write failed after reconnect: {second_error}"
                    ) from first_error

    # -- internals ---------------------------------------------------------
    def _open_serial_locked(self) -> None:
        self.port = self._requested_port or config.find_gps_port()
        self._ser = serial.Serial(self.port, self.baud, timeout=1)
        _configure_receiver(self._ser)

    def _close_serial_locked(self) -> None:
        if self._ser:
            try:
                if self._ser.is_open:
                    self._ser.close()
            except Exception:
                pass
        self._ser = None

    def _reader(self) -> None:
        buf = ""
        while not self._stop.is_set():
            try:
                with self._io_lock:
                    if not self._ser or not self._ser.is_open:
                        self._open_serial_locked()
                    waiting = self._ser.in_waiting
                    data = self._ser.read(waiting) if waiting else b""
                if data:
                    buf += data.decode("ascii", "ignore")
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        line = line.strip()
                        if "GGA" in line[:12]:
                            self.last_gga_raw = line
                            fix = _parse_gga(line)
                            if fix:
                                with self._lock:
                                    self._latest = fix
                                    self._fix_count += 1
                else:
                    time.sleep(0.005)
            except Exception:
                with self._io_lock:
                    self._close_serial_locked()
                time.sleep(0.2)
