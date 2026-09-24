#!/usr/bin/env python3
"""
upload.py — compile + flash an Arduino sketch to the cart's Mega, no IDE.

Uses ``arduino-cli`` under the hood (what the IDE's green arrow calls).
The Arduino IDE is not involved — this is meant for CI, headless dev on
the Jetson, and keyboard-driven workflows on a laptop.

Prerequisites (one-time, on macOS):

    brew install arduino-cli
    arduino-cli core update-index
    arduino-cli core install arduino:avr

This script will also install ``arduino:avr`` on demand if it's missing.

Usage:

    python firmware/upload.py                          # list sketches
    python firmware/upload.py pedal_control            # compile + upload
    python firmware/upload.py pedal_control --monitor  # also open serial monitor
    python firmware/upload.py pedal_control --port /dev/tty.usbmodem1401

Sketches are auto-discovered from ``sketches/<name>/<name>.ino``. The
``sketches/common`` header directory is (correctly) ignored because it
has no matching ``.ino`` file.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent  # firmware/
SKETCHES_DIR = PROJECT_ROOT / "sketches"

# Arduino Mega 2560 FQBN (`arduino-cli board listall mega` confirmed this
# is the canonical name for both Mega and Mega 2560 boards).
DEFAULT_FQBN = "arduino:avr:mega"
DEFAULT_BAUD = 115200

# USB VIDs we've seen on the cart's Mega / clones, and the ODrive's VIDs
# we want to explicitly skip so we never try to flash Arduino firmware to
# an ODrive by accident.
ARDUINO_VIDS = {0x2341, 0x2A03, 0x1A86, 0x0403, 0x10C4}
ODRIVE_VIDS = {0x1209, 0x0483}


def have_arduino_cli() -> str | None:
    """Return the path to ``arduino-cli`` if it's on $PATH, else None."""
    return shutil.which("arduino-cli")


def list_sketches() -> list[Path]:
    """Every ``sketches/<name>/`` directory that contains a matching ``<name>.ino``."""
    if not SKETCHES_DIR.exists():
        return []
    found: list[Path] = []
    for sub in sorted(SKETCHES_DIR.iterdir()):
        if not sub.is_dir():
            continue
        if (sub / f"{sub.name}.ino").exists():
            found.append(sub)
    return found


def find_mega_port() -> str | None:
    """Best-effort Mega port auto-detect — avoids the ODrive by VID.

    Mirrors the heuristic used in ``scripts/ps5_drive.py`` /
    ``scripts/sensor_test.py`` so every script that talks to the Mega
    picks the same device on a given host.
    """
    try:
        import serial.tools.list_ports  # type: ignore
    except ImportError:
        print("[upload] pyserial not available — can't auto-detect. Pass --port.")
        return None

    ports = [
        p for p in serial.tools.list_ports.comports()
        if any(tag in p.device for tag in ("usbmodem", "ttyACM", "ttyUSB", "usbserial"))
    ]
    arduino = [p for p in ports if p.vid in ARDUINO_VIDS]
    if arduino:
        return arduino[0].device
    non_odrive = [p for p in ports if p.vid not in ODRIVE_VIDS]
    if non_odrive:
        # On macOS the Mega's usbmodem name is consistently shorter than
        # the ODrive's, so this is a safe fallback when VID match fails.
        return min(non_odrive, key=lambda p: len(p.device)).device
    return None


def run(cmd: list[str], *, check: bool = True) -> int:
    """Echo the command (so the user can copy/paste it) and run it."""
    printable = " ".join(cmd)
    print(f"$ {printable}")
    return subprocess.run(cmd, check=check).returncode


def ensure_avr_core(cli: str) -> None:
    """If ``arduino:avr`` isn't installed, install it. Cheap no-op when it is."""
    result = subprocess.run(
        [cli, "core", "list"], capture_output=True, text=True, check=True,
    )
    if "arduino:avr" in result.stdout:
        return
    print("[upload] arduino:avr core missing — installing (one-time)...")
    run([cli, "core", "update-index"])
    run([cli, "core", "install", "arduino:avr"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "sketch", nargs="?",
        help="Name of the sketch folder under sketches/ (e.g. pedal_control).",
    )
    parser.add_argument(
        "--port", default=None,
        help="Serial device to flash. Auto-detects the Mega when omitted.",
    )
    parser.add_argument(
        "--fqbn", default=DEFAULT_FQBN,
        help=f"Board FQBN (default {DEFAULT_FQBN}).",
    )
    parser.add_argument(
        "--monitor", action="store_true",
        help=f"After upload, open `arduino-cli monitor` on the same port @ {DEFAULT_BAUD} baud.",
    )
    parser.add_argument(
        "--compile-only", action="store_true",
        help="Compile the sketch but don't actually upload.",
    )
    parser.add_argument(
        "--list", action="store_true",
        help="List available sketches and exit.",
    )
    return parser.parse_args()


def print_sketch_list(sketches: list[Path]) -> None:
    if not sketches:
        print("No sketches found under sketches/*/. Add one and retry.")
        return
    print("Available sketches:")
    for s in sketches:
        print(f"  {s.name}")


def main() -> int:
    args = parse_args()

    cli = have_arduino_cli()
    if cli is None:
        print("ERROR: arduino-cli is not installed or not on $PATH.")
        print("  macOS:   brew install arduino-cli")
        print("  Linux:   see https://arduino.github.io/arduino-cli/installation/")
        return 1

    sketches = list_sketches()

    if args.list or args.sketch is None:
        print_sketch_list(sketches)
        if args.sketch is None and not args.list:
            print("\nUsage: python firmware/upload.py <sketch>")
            return 2
        return 0

    matching = [s for s in sketches if s.name == args.sketch]
    if not matching:
        names = [s.name for s in sketches] or ["(none)"]
        print(f"ERROR: no sketch named '{args.sketch}'. Available: {names}")
        return 1
    sketch_dir = matching[0]

    ensure_avr_core(cli)

    # Sketches share headers under ``sketches/common/`` (e.g. cart_limits.h,
    # mirrored against limits.py). ``arduino-cli compile`` copies the
    # sketch to a temp build dir before compiling, so relative ``../common``
    # includes don't resolve. Add the common dir to the compiler's -I
    # search path so plain ``#include "cart_limits.h"`` works from any
    # sketch, anywhere, whether invoked by this script or by the IDE with
    # a symlinked library.
    common_dir = SKETCHES_DIR / "common"
    build_property = f"compiler.cpp.extra_flags=-I{common_dir}"

    # Compile first; a failure here stops us from bricking anything with
    # a half-uploaded image.
    rc = run(
        [cli, "compile", "--fqbn", args.fqbn,
         "--build-property", build_property, str(sketch_dir)],
        check=False,
    )
    if rc != 0:
        print(f"[upload] compile failed (exit {rc}) — not uploading.")
        return rc

    if args.compile_only:
        print(f"[upload] {sketch_dir.name} compiled clean (compile-only, not uploading).")
        return 0

    port = args.port or find_mega_port()
    if port is None:
        print("ERROR: couldn't auto-detect the Mega. Pass --port /dev/tty.X.")
        print("  (scripts/sensor_test.py --list shows everything attached.)")
        return 1
    print(f"[upload] target: {sketch_dir.name}  fqbn: {args.fqbn}  port: {port}")

    rc = run(
        [cli, "upload", "-p", port, "--fqbn", args.fqbn, str(sketch_dir)],
        check=False,
    )
    if rc != 0:
        print(f"[upload] upload failed (exit {rc}).")
        return rc

    print(f"[upload] OK — flashed {sketch_dir.name} to {port}")

    if args.monitor:
        print(f"[upload] opening serial monitor on {port} @ {DEFAULT_BAUD} (Ctrl+C to exit)")
        # check=False so Ctrl+C in the monitor doesn't bubble up as an error.
        run(
            [cli, "monitor", "-p", port, "-c", f"baudrate={DEFAULT_BAUD}"],
            check=False,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
