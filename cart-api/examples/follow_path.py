#!/usr/bin/env python3
"""
follow_path.py — autonomously follow a recorded RTK path.

!!! THIS DRIVES THE CART AUTONOMOUSLY (steering + throttle). !!!
Defaults to DRY-RUN: it computes and prints the control it *would* send but
actuates nothing, so you can watch the controller track before committing.
Add --go to actually drive. Always keep a hand on the e-stop.

Usage:
    python3 examples/follow_path.py paths/loop.json                   # dry-run preview
    python3 examples/follow_path.py paths/loop.json --go              # DRIVE (hand on e-stop)
    python3 examples/follow_path.py paths/loop.json --go --max-speed 0.15
    python3 examples/follow_path.py paths/loop.json --go --require-rtk --ntrip

--max-speed is the cart's top throttle (pot units, ~0.05-0.45). It is both the
cruise level on straights AND a hard ceiling, so the cart can never exceed it;
turns automatically back off below it.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cartlib import Cart, config
from cartlib.follow import PathFollower, FollowConfig, load_path


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path")
    ap.add_argument("--go", action="store_true", help="actually drive (default: dry-run)")
    ap.add_argument("--max-speed", type=float, default=0.12,
                    help="top throttle in pot units (~0.05-0.45); cruise level AND hard ceiling")
    ap.add_argument("--ntrip", action="store_true", help="feed RTK corrections")
    ap.add_argument("--require-rtk", action="store_true", help="refuse to drive without RTK fix")
    ap.add_argument("--lookahead", type=float, default=3.0, help="lookahead distance (m)")
    ap.add_argument("--steer-gain", type=float, default=1.6)
    args = ap.parse_args()

    waypoints = load_path(args.path)
    cfg = FollowConfig(
        cruise_gas=args.max_speed,
        gas_cap=args.max_speed,     # max-speed is also the hard throttle ceiling
        lookahead_m=args.lookahead,
        steer_gain=args.steer_gain,
        require_rtk=args.require_rtk,
    )

    print(f"Loaded {len(waypoints)} waypoints from {args.path}")
    print(f"Mode: {'### LIVE DRIVE ###' if args.go else 'dry-run (no actuation)'}")
    eff_cap = config.effective_gas_cap(cfg.gas_cap)
    print(f"max_speed={args.max_speed} (effective cap {eff_cap})  lookahead={cfg.lookahead_m}m  "
          f"steer_gain={cfg.steer_gain}  require_rtk={cfg.require_rtk}")
    if eff_cap < args.max_speed:
        print(f"  note: max-speed clamped to {eff_cap} by the global governor/limits")

    with Cart() as cart:
        ntrip = None
        if args.ntrip:
            from cartlib.ntrip import NtripClient
            ntrip = NtripClient(cart.gps).start()

        if args.go:
            print("Arming pedals + enabling steering...")
            cart.arm()
            if not cart.steering.enable():
                print("Steering failed to enter closed-loop; aborting.")
                return

        follower = PathFollower(cart, waypoints, cfg, armed=args.go)

        def show(t):
            sys.stdout.write(
                f"\r[{t['phase']:8}] fix={t['fix']} hdg={t['heading']} "
                f"a={t['alpha']} steer={t['steer_cmd']:+.1f} gas={t['gas']:.3f} "
                f"xtrack={t['xtrack_m']}m goal={t['dist_to_goal_m']}m   "
            )
            sys.stdout.flush()

        try:
            result = follower.run(on_step=show)
            print(f"\nFinished: {result} ({follower.state.reason})")
        except KeyboardInterrupt:
            print("\nABORT by operator")
            if args.go:
                cart.emergency_brake()
                cart.steering.idle()
        finally:
            if ntrip:
                ntrip.stop()


if __name__ == "__main__":
    main()
