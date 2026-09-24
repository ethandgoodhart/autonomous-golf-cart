"""
cartlib — a simple, organized Python library to control and read the FollowRTK
self-driving golf cart.

Subsystems
----------
    GpsReceiver        RTK GPS (u-blox)        -- read lat/lon/fix
    NtripClient        NTRIP corrections feed  -- drive the GPS to RTK Fixed
    PedalController    gas + brake (Arduino)   -- control + read pots
    SteeringController steering (ODrive S1)    -- control + read angle
    Cart               all of the above        -- one handle

Quick start
-----------
    from cartlib import Cart
    with Cart() as cart:
        cart.arm()
        print(cart.snapshot())
"""

from .config import (
    GAS_POT_MAX,
    BRAKE_POT_MAX,
    STEERING_MIN_DEG,
    STEERING_MAX_DEG,
    find_gps_port,
    find_arduino_port,
    find_odrive_port,
)
from .gps import GpsReceiver
from .ntrip import NtripClient
from .pedals import PedalController
from .steering import SteeringController
from .cart import Cart
from .follow import PathFollower, FollowConfig, load_path

__all__ = [
    "Cart",
    "GpsReceiver",
    "NtripClient",
    "PedalController",
    "SteeringController",
    "PathFollower",
    "FollowConfig",
    "load_path",
    "GAS_POT_MAX",
    "BRAKE_POT_MAX",
    "STEERING_MIN_DEG",
    "STEERING_MAX_DEG",
    "find_gps_port",
    "find_arduino_port",
    "find_odrive_port",
]

__version__ = "1.0.0"
