#!/usr/bin/env python3
"""
actuation_demo.py — prove the cart API can actually *move* the actuators.

!!! THIS MOVES REAL HARDWARE ON A LIVE CART. !!!
Only run with the cart safely supported / wheels clear and a hand on the
e-stop. Each demo is opt-in via a flag; nothing runs without one.

  --brake      pulse the brake actuator (engage ~50%, hold 1.5s, release).
               SAFE-ish: braking only ever slows/holds the cart.
  --steer      wiggle steering +/- a few degrees and return to center.
               Energizes the steering motor; keep clear of the wheel.
  --gas        BRIEF gas blip (very small, time-limited). DRIVES THE CART.
               Refuses unless you also pass --i-understand-this-drives.

Examples:
    python3 examples/actuation_demo.py --brake
    python3 examples/actuation_demo.py --steer
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cartlib import Cart, config


def demo_brake(cart):
    print("[brake] arming + engaging brake to 0.30 ...")
    cart.arm()
    time.sleep(0.2)
    cart.pedals.set_brake(0.30)
    for _ in range(15):
        t = cart.pedals.telemetry
        print(f"  brake_pot={t.get('brake', 0):.3f} target={t.get('brake_target', 0):.3f}")
        time.sleep(0.1)
    print("[brake] releasing")
    cart.pedals.stop()
    time.sleep(0.5)


def demo_steer(cart):
    print("[steer] enabling closed-loop control ...")
    if not cart.steering.enable():
        print("  FAILED to enter closed-loop; aborting.")
        return
    try:
        for angle in (8, -8, 0):
            print(f"  -> {angle:+d} deg")
            cart.steering.set_angle(angle)
            cart.steering.wait_until_settled(angle, tol_deg=1.5, timeout=4)
            print(f"     actual={cart.steering.angle_deg():+.1f} deg")
            time.sleep(0.3)
    finally:
        print("[steer] idling motor")
        cart.steering.idle()


def demo_gas(cart):
    print("[gas] BRIEF blip to 0.10 for 0.6s (DRIVES THE CART) ...")
    cart.arm()
    time.sleep(0.2)
    cart.pedals.set_gas(0.10)
    time.sleep(0.6)
    cart.pedals.stop()
    print("[gas] released")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--brake", action="store_true")
    ap.add_argument("--steer", action="store_true")
    ap.add_argument("--gas", action="store_true")
    ap.add_argument("--i-understand-this-drives", action="store_true")
    args = ap.parse_args()

    if not (args.brake or args.steer or args.gas):
        ap.print_help()
        return
    if args.gas and not args.i_understand_this_drives:
        print("Refusing --gas without --i-understand-this-drives. "
              "The gas actuator DRIVES the cart.")
        return

    print("!!! LIVE HARDWARE. Hand on the e-stop. Ctrl-C aborts. !!!")
    with Cart() as cart:
        try:
            if args.brake:
                demo_brake(cart)
            if args.steer:
                demo_steer(cart)
            if args.gas:
                demo_gas(cart)
        except KeyboardInterrupt:
            print("\nABORT — releasing pedals + idling steering")
            cart.emergency_brake()
            if cart.steering:
                cart.steering.idle()
            time.sleep(0.5)
            cart.stop()


if __name__ == "__main__":
    main()
