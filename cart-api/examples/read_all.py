#!/usr/bin/env python3
"""
read_all.py — live dashboard of every cart subsystem (read-only, no motion).

Streams GPS fix, gas/brake pot positions, and steering angle to the terminal
at a few Hz. Press Ctrl-C to quit. Run from the cart_api/ directory:

    python3 examples/read_all.py
    python3 examples/read_all.py --ntrip      # also feed RTK corrections
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cartlib import Cart
from cartlib.ntrip import NtripClient


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ntrip", action="store_true", help="feed NTRIP RTK corrections")
    args = ap.parse_args()

    with Cart() as cart:
        ntrip = NtripClient(cart.gps).start() if args.ntrip else None
        try:
            while True:
                snap = cart.snapshot()
                g = snap["gps"]
                p = snap["pedals"]
                s = snap["steering"]

                gps_s = (f"{g['fix_type']:>9} sats={g['sats']:2d} "
                         f"{g['lat']:.6f},{g['lon']:.6f}") if g else "  no fix "
                ped_s = (f"gas={p['gas']:.3f} brake={p['brake']:.3f} "
                         f"fs={int(p['failsafe'])} es={int(p['estop'])}") if p else "no telem"
                str_s = (f"{s['angle_deg']:+6.1f}deg vbus={s['bus_voltage']:.1f}V "
                         f"st={s['current_state']}") if s else "no odrive"
                ntrip_s = (" RTK:on" if (ntrip and ntrip.connected) else "")

                sys.stdout.write(
                    f"\rGPS[{gps_s}]  PEDALS[{ped_s}]  STEER[{str_s}]{ntrip_s}   "
                )
                sys.stdout.flush()
                time.sleep(0.25)
        except KeyboardInterrupt:
            print("\nbye")
        finally:
            if ntrip:
                ntrip.stop()


if __name__ == "__main__":
    main()
