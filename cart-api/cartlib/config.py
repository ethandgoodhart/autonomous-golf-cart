"""
cartlib.config — single source of truth for device ports and cart limits.

The mechanical / software limits here are mirrored from the production cart
firmware (``PRODUCTION/limits.py`` and ``sketches/common/cart_limits.h``).
Keep them in sync if the hardware envelope ever changes.

Device discovery prefers the stable ``/dev/serial/by-id/`` symlinks so the
library doesn't care whether the GPS, ODrive, and Arduino enumerate as
ttyACM0/1/2 in some other order after a reboot or re-plug.
"""

from __future__ import annotations

import glob
import os

# --------------------------------------------------------------------------
# Serial port discovery
# --------------------------------------------------------------------------
# Each device is matched by a substring of its /dev/serial/by-id/ name.
# These come straight from `ls /dev/serial/by-id/` on the cart:
#   usb-Linux_..._CDC_Composite_Gadget-if02                  -> GPS bridge
#   usb-u-blox_AG_-_www.u-blox.com_u-blox_GNSS_receiver-if00  -> GPS
#   usb-ODrive_Robotics_ODrive_S1_0062747288A9-if00           -> steering
#   usb-Arduino__www.arduino.cc__0042_1453130...-if00         -> pedals
_BY_ID_DIR = "/dev/serial/by-id"

GPS_ID_HINTS = ("CDC_Composite_Gadget", "u-blox", "GNSS")
ODRIVE_ID_HINTS = ("ODrive",)
ARDUINO_ID_HINTS = ("Arduino",)

# Fallback raw ports if the by-id symlinks are unavailable for some reason.
# GPS should normally be found by the stable u-blox /dev/serial/by-id link.
# Set FOLLOWRTK_GPS_PORT=/dev/tty... only for intentionally custom wiring.
GPS_FALLBACK = None
GPS_BRIDGE = "/dev/gps-bridge"
ODRIVE_FALLBACK = "/dev/ttyACM1"
ARDUINO_FALLBACK = "/dev/ttyACM2"

# --------------------------------------------------------------------------
# Baud rates
# --------------------------------------------------------------------------
GPS_BAUD = int(os.getenv("FOLLOWRTK_GPS_BAUD", "38400"))  # Pi bridge/u-blox UART baud
ARDUINO_BAUD = 115200   # pedal_control.ino — 115200 8N1, newline terminated
ODRIVE_BAUD = 115200    # ODrive USB-CDC ASCII protocol (baud is nominal over CDC)

# --------------------------------------------------------------------------
# Pedal actuator limits (normalized pot units, 0.0 = released)
#   mirrored from PRODUCTION/limits.py
# --------------------------------------------------------------------------
GAS_POT_MIN = 0.00
GAS_POT_MAX = 0.68      # full throttle (actuator mechanical hard stop)
BRAKE_POT_MIN = 0.00
BRAKE_POT_MAX = 0.45    # full brake (actuator mechanical limit)

# Layered gas authority caps (see PRODUCTION/limits.py for the rationale).
GLOBAL_SPEED_LIMIT = 0.45   # top-level governor, applies to everyone
FSD_GAS_LIMIT = 0.36        # autonomy cap — 0.36 pot ≈ 12 mph (under 0.45 governor)

# Production open-loop speed calibration. The linear 5-8 mph regime is about
# 0.24 gas pot at 8 mph, but low-speed commands need a floor to overcome
# rolling resistance; otherwise 1-4 mph barely moves the actuator/cart.
GAS_CALIBRATION_MPH = 8.0
GAS_CALIBRATION_POT = 0.24
GAS_PER_MPH = GAS_CALIBRATION_POT / GAS_CALIBRATION_MPH
ROLLING_GAS_FLOOR = 0.18

# The Arduino trips FAILSAFE if it hears nothing for 300 ms. Send a heartbeat
# comfortably faster than that.
PEDAL_HEARTBEAT_HZ = 20
PEDAL_HEARTBEAT_TIMEOUT_MS = 300

# --------------------------------------------------------------------------
# Steering limits (ODrive S1 + M8325s through 3:1 HTD-5M belt)
#   mirrored from PRODUCTION/limits.py
# --------------------------------------------------------------------------
STEERING_BELT_RATIO = 3.0   # 3 motor turns = 1 steering-column turn
# Steering-column soft limits. The cart rack physically supports ~±320°.
STEERING_MIN_DEG = -320.0
STEERING_MAX_DEG = 320.0

# Scales the steering "straighten" (heading) term only — NOT the map needle,
# which now leans by the wheel angle 1:1. The controller treats full lock
# (~±320° column) as a ~75° heading deviation so the centering term stays gentle
# instead of saturating. Bump it to make `straighten` bite harder, drop it for
# softer centering.
HEADING_FULL_LOCK_DEG = 75.0


def steer_cmd_to_heading_offset(column_deg: float) -> float:
    """Wheel angle -> scaled heading deviation for the steering centering term."""
    return column_deg * (HEADING_FULL_LOCK_DEG / STEERING_MAX_DEG)

# Conservative trapezoidal-trajectory limits for library-driven steering
# (motor-side units). Production sweeps faster; these are gentle defaults.
STEERING_TRAP_VEL = 4.0     # turns/s
STEERING_TRAP_ACCEL = 8.0   # turns/s^2
STEERING_TRAP_DECEL = 8.0   # turns/s^2


def steering_deg_to_motor_turns(column_deg: float) -> float:
    """Steering-column angle (deg) -> motor turns."""
    return (column_deg / 360.0) * STEERING_BELT_RATIO


def motor_turns_to_steering_deg(motor_turns: float) -> float:
    """Motor turns -> steering-column angle (deg)."""
    return (motor_turns / STEERING_BELT_RATIO) * 360.0


def effective_gas_cap(mode_limit: float) -> float:
    """Resolve the effective gas cap, clamped by hardware + global governor."""
    return min(GAS_POT_MAX, GLOBAL_SPEED_LIMIT, mode_limit)


def gas_for_mph(speed_mph: float) -> float:
    """Open-loop pedal pot target for a requested constant speed in mph."""
    if speed_mph <= 0.0:
        return 0.0
    return effective_gas_cap(max(speed_mph * GAS_PER_MPH, ROLLING_GAS_FLOOR))


def mph_from_gas(gas: float) -> float:
    """Best-effort inverse of the linear part of ``gas_for_mph``."""
    return max(0.0, gas / GAS_PER_MPH)


# --------------------------------------------------------------------------
# Port resolution
# --------------------------------------------------------------------------
def _resolve_by_id(hints, fallback, *, allow_any_acm: bool = True):
    """Return the first /dev/serial/by-id link whose name matches a hint.

    Resolves the symlink to its real /dev/ttyACMx target. Falls back to the
    given raw port if nothing matches (e.g. by-id dir missing).
    """
    try:
        entries = os.listdir(_BY_ID_DIR)
    except OSError:
        entries = []
    for name in sorted(entries):
        if any(hint in name for hint in hints):
            return os.path.realpath(os.path.join(_BY_ID_DIR, name))
    if fallback and os.path.exists(fallback):
        return fallback
    if not allow_any_acm:
        hint_text = " or ".join(hints)
        raise RuntimeError(
            f"no serial device matching {hint_text!r} in {_BY_ID_DIR}; "
            "check the GPS USB connection or set FOLLOWRTK_GPS_PORT"
        )
    # Last resort for non-GPS devices: any ttyACM at all.
    acm = sorted(glob.glob("/dev/ttyACM*"))
    return acm[0] if acm else fallback


def find_gps_port() -> str:
    override = os.getenv("FOLLOWRTK_GPS_PORT")
    if override:
        return override
    if os.path.exists(GPS_BRIDGE):
        return GPS_BRIDGE
    return _resolve_by_id(GPS_ID_HINTS, GPS_FALLBACK, allow_any_acm=False)


def find_odrive_port() -> str:
    return _resolve_by_id(ODRIVE_ID_HINTS, ODRIVE_FALLBACK)


def find_arduino_port() -> str:
    return _resolve_by_id(ARDUINO_ID_HINTS, ARDUINO_FALLBACK)
