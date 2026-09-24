#!/usr/bin/env python3
"""
record_path.py — drive the cart manually and record its RTK track to a JSON
path file you can later replay with follow_path.py.

Read-only w.r.t. the cart (it never actuates) — just logs GPS. Drive the cart
however you like (PS5 script, push it, etc.); this samples a waypoint whenever
you've moved at least --spacing metres.

Usage:
    python3 examples/record_path.py paths/loop.json
    python3 examples/record_path.py paths/loop.json --spacing 0.75 --ntrip
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cartlib.gps import GpsReceiver
from cartlib import geo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("outfile")
    ap.add_argument("--spacing", type=float, default=0.75, help="metres between samples")
    ap.add_argument("--ntrip", action="store_true", help="feed RTK corrections")
    args = ap.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(args.outfile)), exist_ok=True)
    pts = []

    with GpsReceiver() as gps:
        ntrip = None
        if args.ntrip:
            from cartlib.ntrip import NtripClient
            ntrip = NtripClient(gps).start()
        print("Waiting for GPS fix...")
        gps.wait_for_fix(timeout=8)
        print(f"Recording every {args.spacing} m. Drive the cart. Ctrl-C to save.")
        last = None
        try:
            while True:
                fix = gps.latest
                if fix and fix["fix_code"] > 0:
                    p = (fix["lat"], fix["lon"])
                    if last is None or geo.haversine_m(last, p) >= args.spacing:
                        pts.append({"lat": p[0], "lon": p[1], "fix": fix["fix_type"]})
                        last = p
                        print(f"  [{len(pts):4d}] {p[0]:.7f},{p[1]:.7f}  {fix['fix_type']}")
                time.sleep(0.1)
        except KeyboardInterrupt:
            pass
        finally:
            if ntrip:
                ntrip.stop()

    with open(args.outfile, "w") as f:
        json.dump({"points": pts}, f, indent=2)
    print(f"\nSaved {len(pts)} waypoints -> {args.outfile}")


if __name__ == "__main__":
    main()
