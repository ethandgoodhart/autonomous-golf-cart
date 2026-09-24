"""
cartlib.pedals — gas + brake control via the Arduino Mega (pedal_control.ino).

The Mega runs closed-loop-ish position control of two linear actuators (gas
and brake) and a host-heartbeat watchdog: if it hears nothing for 300 ms it
trips FAILSAFE (gas released, brake slammed on). This class therefore runs a
background heartbeat thread so that, while armed, the cart stays out of
failsafe — and it parses the Mega's STAT telemetry so you can read the live
pot positions and e-stop / failsafe state.

Host -> Mega protocol (115200 8N1, newline-terminated):
    G <value>   set gas target,   0.0 .. GAS_POT_MAX
    B <value>   set brake target, 0.0 .. BRAKE_POT_MAX
    S           stop: release both pedals (cart stays armed)
    H           heartbeat-only ping
    D           graceful disarm (release + park the watchdog)

Mega -> Host telemetry:
    STAT,g=<pot>,b=<pot>,tg=<tgt>,tb=<tgt>,hb=<age_ms>,fs=<0|1>,es=<0|1>

SAFETY: ``set_gas`` moves a *live cart*. Default construction caps gas at the
conservative ``FSD_GAS_LIMIT``. ``set_brake`` only ever stops the cart and is
always safe to call.

Example
-------
    from cartlib.pedals import PedalController

    with PedalController() as pedals:
        pedals.arm()              # starts heartbeat, leaves failsafe
        pedals.set_brake(0.3)     # engage brake (safe)
        print(pedals.telemetry)
        pedals.stop()             # release both
"""

from __future__ import annotations

import threading
import time
from typing import Optional

import serial

from . import config


class PedalController:
    def __init__(
        self,
        port: Optional[str] = None,
        baud: int = config.ARDUINO_BAUD,
        gas_cap: float = config.FSD_GAS_LIMIT,
        heartbeat_hz: float = config.PEDAL_HEARTBEAT_HZ,
        dry_run: bool = False,
    ):
        self.port = port or config.find_arduino_port()
        self.baud = baud
        # Effective gas ceiling: never exceed hardware/global, then the
        # caller's requested cap on top of that.
        self.gas_cap = config.effective_gas_cap(gas_cap)
        self.brake_cap = config.BRAKE_POT_MAX
        self.heartbeat_period = 1.0 / heartbeat_hz
        self.dry_run = dry_run

        self._ser: Optional[serial.Serial] = None
        self._lock = threading.Lock()       # serializes serial writes
        self._stop = threading.Event()
        self._hb_thread: Optional[threading.Thread] = None
        self._rx_thread: Optional[threading.Thread] = None

        self._armed = False
        self._gas_target = 0.0
        self._brake_target = 0.0
        self._telemetry: dict = {}

    # -- lifecycle ---------------------------------------------------------
    def open(self) -> "PedalController":
        if not self.dry_run:
            self._ser = serial.Serial(self.port, self.baud, timeout=0.5)
            time.sleep(0.3)
            self._ser.reset_input_buffer()
        self._stop.clear()
        self._rx_thread = threading.Thread(target=self._rx_loop, daemon=True)
        self._rx_thread.start()
        self._hb_thread = threading.Thread(target=self._hb_loop, daemon=True)
        self._hb_thread.start()
        return self

    def close(self) -> None:
        """Gracefully disarm (release pedals + park watchdog), then close."""
        try:
            self.disarm()
        except Exception:
            pass
        self._stop.set()
        for t in (self._hb_thread, self._rx_thread):
            if t:
                t.join(timeout=2)
        if self._ser and self._ser.is_open:
            self._ser.close()

    def __enter__(self) -> "PedalController":
        return self.open()

    def __exit__(self, *exc) -> None:
        self.close()

    # -- commands ----------------------------------------------------------
    def arm(self) -> None:
        """Leave failsafe so gas/brake commands take effect. Sends a ping."""
        self._armed = True
        self._send("H")

    def set_gas(self, value: float) -> float:
        """Set gas target (0.0..gas_cap). MOVES A LIVE CART. Returns clamped value."""
        value = max(0.0, min(value, self.gas_cap))
        self._gas_target = value
        if self._armed:
            self._send(f"G {value:.4f}")
        return value

    def set_brake(self, value: float) -> float:
        """Set brake target (0.0..brake_cap). Always safe. Returns clamped value."""
        value = max(0.0, min(value, self.brake_cap))
        self._brake_target = value
        if self._armed:
            self._send(f"B {value:.4f}")
        return value

    def stop(self) -> None:
        """Release both pedals; cart stays armed for further commands."""
        self._gas_target = 0.0
        self._brake_target = 0.0
        self._send("S")

    def disarm(self) -> None:
        """Graceful shutdown: release pedals and park the Mega's watchdog."""
        self._gas_target = 0.0
        self._brake_target = 0.0
        self._armed = False
        self._send("D")

    # -- reads -------------------------------------------------------------
    @property
    def telemetry(self) -> dict:
        """Latest parsed STAT line: {gas, brake, gas_target, brake_target,
        heartbeat_ms, failsafe, estop}."""
        with self._lock:
            return dict(self._telemetry)

    @property
    def armed(self) -> bool:
        return self._armed

    def wait_for_telemetry(self, timeout: float = 3.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            t = self.telemetry
            if t:
                return t
            time.sleep(0.02)
        return self.telemetry

    # -- internals ---------------------------------------------------------
    def _send(self, cmd: str) -> None:
        if self.dry_run or not self._ser:
            return
        with self._lock:
            try:
                self._ser.write((cmd + "\n").encode())
                self._ser.flush()
            except Exception:
                pass

    def _hb_loop(self) -> None:
        """Keep the Mega out of failsafe while armed by pinging steadily."""
        while not self._stop.is_set():
            if self._armed:
                self._send("H")
            time.sleep(self.heartbeat_period)

    def _rx_loop(self) -> None:
        if self.dry_run or not self._ser:
            return
        buf = ""
        while not self._stop.is_set():
            try:
                if self._ser.in_waiting:
                    buf += self._ser.read(self._ser.in_waiting).decode("ascii", "ignore")
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        self._parse_line(line.strip())
                else:
                    time.sleep(0.01)
            except Exception:
                time.sleep(0.2)

    def _parse_line(self, line: str) -> None:
        if not line.startswith("STAT,"):
            return
        fields = {}
        for kv in line[5:].split(","):
            if "=" in kv:
                k, v = kv.split("=", 1)
                fields[k] = v
        try:
            parsed = {
                "gas": float(fields["g"]),
                "brake": float(fields["b"]),
                "gas_target": float(fields["tg"]),
                "brake_target": float(fields["tb"]),
                "heartbeat_ms": int(fields["hb"]),
                "failsafe": fields.get("fs") == "1",
                "estop": fields.get("es") == "1",
                "ts": time.time(),
            }
        except (KeyError, ValueError):
            return
        with self._lock:
            self._telemetry = parsed
