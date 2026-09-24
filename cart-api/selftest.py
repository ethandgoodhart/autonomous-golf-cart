#!/usr/bin/env python3
"""
selftest.py — safe, read-only verification that the cart API can see every
subsystem: RTK GPS, the Arduino (gas + brake pots / e-stop), and the ODrive
steering controller.

This does NOT move the cart. It only opens each device and reads live state.
Exit code 0 means all requested subsystems were detected and readable.

Usage:
    python3 selftest.py            # check GPS + pedals + steering
    python3 selftest.py --gps      # only check a subset
    python3 selftest.py --pedals --steering
"""

import argparse
import sys
import time

# Allow running straight from the cart_api/ dir without installing.
sys.path.insert(0, __file__.rsplit("/", 1)[0])

from cartlib import config
from cartlib.gps import GpsReceiver
from cartlib.pedals import PedalController
from cartlib.steering import SteeringController

GREEN, RED, YELLOW, RESET = "\033[92m", "\033[91m", "\033[93m", "\033[0m"


def ok(msg):
    print(f"  {GREEN}PASS{RESET}  {msg}")


def warn(msg):
    print(f"  {YELLOW}WARN{RESET}  {msg}")


def fail(msg):
    print(f"  {RED}FAIL{RESET}  {msg}")


def check_gps() -> bool:
    print(f"\n[GPS] u-blox RTK receiver  ({config.find_gps_port()})")
    try:
        with GpsReceiver() as gps:
            fix = gps.wait_for_fix(timeout=6)
            if not fix:
                fail("no NMEA fix parsed within 6 s")
                return False
            ok(f"fix={fix['fix_type']} sats={fix['sats']} hdop={fix['hdop']} "
               f"lat={fix['lat']:.6f} lon={fix['lon']:.6f}")
            if fix["fix_code"] >= 4:
                ok("RTK fix active")
            else:
                warn(f"not RTK yet (fix={fix['fix_type']}); start NtripClient "
                     "for corrections to reach RTK Fixed")
            return True
    except Exception as e:
        fail(f"{type(e).__name__}: {e}")
        return False


def check_pedals() -> bool:
    print(f"\n[PEDALS] Arduino Mega (gas + brake)  ({config.find_arduino_port()})")
    try:
        with PedalController() as pedals:   # does NOT arm -> no actuation
            tel = pedals.wait_for_telemetry(timeout=4)
            if not tel:
                fail("no STAT telemetry received within 4 s")
                return False
            ok(f"gas_pot={tel['gas']:.3f}  brake_pot={tel['brake']:.3f}")
            ok(f"failsafe={tel['failsafe']}  estop={tel['estop']}  "
               f"heartbeat_age={tel['heartbeat_ms']}ms")
            ok(f"caps: gas<= {pedals.gas_cap:.2f}  brake<= {pedals.brake_cap:.2f}")
            if tel["estop"]:
                warn("E-STOP is currently ENGAGED")
            return True
    except Exception as e:
        fail(f"{type(e).__name__}: {e}")
        return False


def check_steering() -> bool:
    print(f"\n[STEERING] ODrive S1  ({config.find_odrive_port()})")
    try:
        with SteeringController() as steer:   # connect only -> motor stays IDLE
            st = steer.status()
            if st["bus_voltage"] is None:
                fail("no ASCII response from ODrive")
                return False
            ok(f"bus_voltage={st['bus_voltage']:.1f} V")
            ok(f"angle={st['angle_deg']:.2f} deg  pos={st['position_turns']:.4f} turns")
            state_names = {1: "IDLE", 8: "CLOSED_LOOP"}
            ok(f"axis state={state_names.get(st['current_state'], st['current_state'])}  "
               f"active_errors={st['active_errors']}")
            if st["active_errors"]:
                warn("ODrive has active errors (clear with steer.clear_errors())")
            return True
    except Exception as e:
        fail(f"{type(e).__name__}: {e}")
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gps", action="store_true")
    ap.add_argument("--pedals", action="store_true")
    ap.add_argument("--steering", action="store_true")
    args = ap.parse_args()

    # No flags => check everything.
    do_all = not (args.gps or args.pedals or args.steering)

    print("=" * 60)
    print(" FollowRTK cart API — read-only self-test (no motion)")
    print("=" * 60)

    results = {}
    if do_all or args.gps:
        results["GPS"] = check_gps()
    if do_all or args.pedals:
        results["Pedals"] = check_pedals()
    if do_all or args.steering:
        results["Steering"] = check_steering()

    print("\n" + "=" * 60)
    print(" SUMMARY")
    for name, passed in results.items():
        tag = f"{GREEN}OK{RESET}" if passed else f"{RED}FAILED{RESET}"
        print(f"   {name:10} {tag}")
    print("=" * 60)

    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    main()
