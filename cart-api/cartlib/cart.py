"""
cartlib.cart — one object that ties the whole cart together.

``Cart`` wires up the RTK GPS, the gas/brake pedals, and the steering ODrive
behind a single context-managed handle. Each subsystem is optional so you can
spin up just what you need (e.g. GPS-only logging, or pedals without steering).

Example
-------
    from cartlib import Cart

    with Cart() as cart:
        cart.arm()                       # GPS already streaming; pedals armed
        print(cart.snapshot())           # gps + pedals + steering state
        cart.steering.enable()
        cart.steering.set_angle(10)
        cart.pedals.set_brake(0.2)
        cart.stop()                      # release pedals
"""

from __future__ import annotations

from typing import Optional

from .gps import GpsReceiver
from .pedals import PedalController
from .steering import SteeringController


class Cart:
    def __init__(
        self,
        use_gps: bool = True,
        use_pedals: bool = True,
        use_steering: bool = True,
        gas_cap: Optional[float] = None,
        dry_run: bool = False,
    ):
        self.gps: Optional[GpsReceiver] = None
        self.pedals: Optional[PedalController] = None
        self.steering: Optional[SteeringController] = None

        if use_gps:
            self.gps = GpsReceiver()
        if use_pedals:
            kw = {"dry_run": dry_run}
            if gas_cap is not None:
                kw["gas_cap"] = gas_cap
            self.pedals = PedalController(**kw)
        if use_steering:
            self.steering = SteeringController()

    # -- lifecycle ---------------------------------------------------------
    def open(self) -> "Cart":
        if self.gps:
            self.gps.open()
        if self.pedals:
            self.pedals.open()
        if self.steering:
            self.steering.connect()
        return self

    def close(self) -> None:
        # Stop motion first, then tear down connections.
        if self.pedals:
            self.pedals.close()
        if self.steering:
            self.steering.close()
        if self.gps:
            self.gps.close()

    def __enter__(self) -> "Cart":
        return self.open()

    def __exit__(self, *exc) -> None:
        self.close()

    # -- convenience -------------------------------------------------------
    def arm(self) -> None:
        """Arm the pedals (leave Mega failsafe). Steering is armed separately
        via ``cart.steering.enable()`` so the motor isn't energized by default."""
        if self.pedals:
            self.pedals.arm()

    def stop(self) -> None:
        """Release both pedals (cart stays armed)."""
        if self.pedals:
            self.pedals.stop()

    def emergency_brake(self, value: Optional[float] = None) -> None:
        """Release gas and slam the brake."""
        if self.pedals:
            self.pedals.set_gas(0.0)
            from . import config
            self.pedals.set_brake(value if value is not None else config.BRAKE_POT_MAX)

    def snapshot(self) -> dict:
        """One dict with the live state of every connected subsystem."""
        return {
            "gps": self.gps.latest if self.gps else None,
            "pedals": self.pedals.telemetry if self.pedals else None,
            "steering": self.steering.status() if self.steering else None,
        }
