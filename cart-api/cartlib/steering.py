"""
cartlib.steering — steering control via the ODrive S1 (ASCII protocol).

The ODrive S1 drives the steering column through a 3:1 HTD-5M belt. We talk to
it over its USB-CDC ASCII protocol (``/dev/ttyACM*``) with nothing but
pyserial — no need for the heavyweight ``odrive`` / ``fibre`` packages.

ASCII protocol reference (subset we use):
    r <property>            read a property, e.g.  r axis0.pos_estimate
    w <property> <value>    write a property, e.g. w axis0.requested_state 8
    f <axis>                feedback -> "<pos> <vel>"
    sc                      clear errors

Angle convention: ``set_angle`` takes a steering-column angle in degrees
relative to the position captured at ``connect()`` (i.e. wherever the wheel
was when the library started = 0°). Positive/negative map straight through the
belt ratio to motor turns. Targets are clamped to the soft limits.

SAFETY: enabling closed-loop control energizes the steering motor and moving
the wheel against a loaded rack draws current. Defaults use gentle
trapezoidal limits. Call ``idle()`` (or just close the context) to de-energize.

Example
-------
    from cartlib.steering import SteeringController

    with SteeringController() as steer:
        print(steer.bus_voltage(), "V")
        steer.enable()           # closed-loop, motor energized
        steer.set_angle(15)      # +15 deg at the column
        steer.idle()             # de-energize
"""

from __future__ import annotations

import threading
import time
from typing import Optional

import serial

from . import config

# ODrive enums (values are stable across fw, used directly in ASCII writes).
AXIS_STATE_IDLE = 1
AXIS_STATE_CLOSED_LOOP = 8
CONTROL_MODE_POSITION = 3
INPUT_MODE_TRAP_TRAJ = 5


class SteeringController:
    def __init__(
        self,
        port: Optional[str] = None,
        baud: int = config.ODRIVE_BAUD,
        min_deg: float = config.STEERING_MIN_DEG,
        max_deg: float = config.STEERING_MAX_DEG,
    ):
        self.port = port or config.find_odrive_port()
        self.baud = baud
        self.min_deg = min_deg
        self.max_deg = max_deg
        self._ser: Optional[serial.Serial] = None
        self._lock = threading.Lock()
        self.start_pos = 0.0      # motor turns at connect() = our 0 deg
        self._enabled = False
        self.target_deg = 0.0

    # -- lifecycle ---------------------------------------------------------
    def connect(self) -> "SteeringController":
        self._ser = serial.Serial(self.port, self.baud, timeout=0.4)
        time.sleep(0.3)
        self._ser.reset_input_buffer()
        # Verify we're really talking to an ODrive before doing anything.
        vbus = self.bus_voltage()
        if vbus is None:
            raise RuntimeError(f"No ODrive ASCII response on {self.port}")
        self.start_pos = self.position_turns()
        return self

    def close(self) -> None:
        try:
            self.idle()
        except Exception:
            pass
        if self._ser and self._ser.is_open:
            self._ser.close()

    def __enter__(self) -> "SteeringController":
        return self.connect()

    def __exit__(self, *exc) -> None:
        self.close()

    # -- low-level ASCII ---------------------------------------------------
    def _query(self, cmd: str, read_reply: bool = True) -> str:
        with self._lock:
            self._ser.reset_input_buffer()
            self._ser.write((cmd + "\n").encode())
            self._ser.flush()
            if not read_reply:
                return ""
            time.sleep(0.05)
            return self._ser.read(256).decode("ascii", "ignore").strip()

    def _read_float(self, prop: str) -> Optional[float]:
        reply = self._query(f"r {prop}")
        try:
            return float(reply.split()[0])
        except (ValueError, IndexError):
            return None

    def _write(self, prop: str, value) -> None:
        self._query(f"w {prop} {value}", read_reply=False)

    # -- reads -------------------------------------------------------------
    def bus_voltage(self) -> Optional[float]:
        return self._read_float("vbus_voltage")

    def position_turns(self) -> float:
        v = self._read_float("axis0.pos_estimate")
        return v if v is not None else 0.0

    def angle_deg(self) -> float:
        """Current steering-column angle (deg) relative to connect()."""
        return config.motor_turns_to_steering_deg(self.position_turns() - self.start_pos)

    def current_state(self) -> Optional[int]:
        v = self._read_float("axis0.current_state")
        return int(v) if v is not None else None

    def active_errors(self) -> Optional[int]:
        v = self._read_float("axis0.active_errors")
        return int(v) if v is not None else None

    def status(self) -> dict:
        return {
            "bus_voltage": self.bus_voltage(),
            "angle_deg": round(self.angle_deg(), 2),
            "target_deg": round(self.target_deg, 2),
            "position_turns": round(self.position_turns(), 4),
            "current_state": self.current_state(),
            "active_errors": self.active_errors(),
            "enabled": self._enabled,
        }

    # -- control -----------------------------------------------------------
    def clear_errors(self) -> None:
        self._query("sc", read_reply=False)

    def enable(self) -> bool:
        """Enter closed-loop position control with gentle trap-traj limits."""
        self.clear_errors()
        # Position control via trapezoidal trajectory for smooth motion.
        self._write("axis0.controller.config.control_mode", CONTROL_MODE_POSITION)
        self._write("axis0.controller.config.input_mode", INPUT_MODE_TRAP_TRAJ)
        self._write("axis0.trap_traj.config.vel_limit", config.STEERING_TRAP_VEL)
        self._write("axis0.trap_traj.config.accel_limit", config.STEERING_TRAP_ACCEL)
        self._write("axis0.trap_traj.config.decel_limit", config.STEERING_TRAP_DECEL)
        # Hold current position so enabling doesn't jerk the wheel.
        self._write("axis0.controller.input_pos", self.position_turns())
        self._write("axis0.requested_state", AXIS_STATE_CLOSED_LOOP)
        time.sleep(0.3)
        ok = self.current_state() == AXIS_STATE_CLOSED_LOOP
        self._enabled = ok
        return ok

    def idle(self) -> None:
        """De-energize the motor (IDLE state)."""
        self._write("axis0.requested_state", AXIS_STATE_IDLE)
        self._enabled = False

    def set_angle(self, column_deg: float) -> float:
        """Command a steering-column angle (deg, relative to connect()).

        Clamps to soft limits. Requires ``enable()`` first. Returns the
        clamped target in degrees.
        """
        if not self._enabled:
            raise RuntimeError("Steering not enabled — call enable() first")
        column_deg = max(self.min_deg, min(column_deg, self.max_deg))
        self.target_deg = column_deg
        target_turns = self.start_pos + config.steering_deg_to_motor_turns(column_deg)
        self._write("axis0.controller.input_pos", target_turns)
        return column_deg

    def wait_until_settled(self, target_deg: float, tol_deg: float = 1.0,
                           timeout: float = 5.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if abs(self.angle_deg() - target_deg) <= tol_deg:
                return True
            time.sleep(0.05)
        return False
