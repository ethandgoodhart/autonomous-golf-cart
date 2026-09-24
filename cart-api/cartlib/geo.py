"""
cartlib.geo — minimal geodesy helpers for GPS path following.

Ported from drivelive/src/lib/geo.ts so the cart-side math matches the
annotation tool. All angles in degrees, distances in metres. We use a local
flat-earth (equirectangular) projection for cross-track / lookahead math,
which is plenty accurate over the ~tens-of-metres scales a cart path spans.
"""

from __future__ import annotations

import math
from typing import NamedTuple, Sequence, Tuple

EARTH_R = 6371000.0  # metres

LatLon = Tuple[float, float]  # (lat, lon)


def haversine_m(a: LatLon, b: LatLon) -> float:
    """Great-circle distance between two (lat, lon) points, in metres."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return EARTH_R * 2 * math.atan2(math.sqrt(h), math.sqrt(1 - h))


def bearing_deg(a: LatLon, b: LatLon) -> float:
    """Initial compass bearing from a to b, degrees in [0, 360)."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def angle_diff_deg(target: float, source: float) -> float:
    """Smallest signed difference target-source, wrapped to (-180, 180]."""
    d = (target - source + 180.0) % 360.0 - 180.0
    return d + 360.0 if d <= -180.0 else d


def local_xy(origin: LatLon, p: LatLon) -> Tuple[float, float]:
    """Project p to local east(x)/north(y) metres about origin."""
    dlat = math.radians(p[0] - origin[0])
    dlon = math.radians(p[1] - origin[1])
    x = dlon * math.cos(math.radians(origin[0])) * EARTH_R
    y = dlat * EARTH_R
    return x, y


def from_local_xy(origin: LatLon, x: float, y: float) -> LatLon:
    """Inverse of local_xy for short local offsets."""
    lat = origin[0] + math.degrees(y / EARTH_R)
    lon = origin[1] + math.degrees(x / (math.cos(math.radians(origin[0])) * EARTH_R))
    return lat, lon


def nearest_index(path: Sequence[LatLon], pos: LatLon) -> int:
    """Index of the path vertex closest to pos."""
    best_i, best_d = 0, float("inf")
    for i, p in enumerate(path):
        d = haversine_m(pos, p)
        if d < best_d:
            best_i, best_d = i, d
    return best_i


class PathSnap(NamedTuple):
    point: LatLon
    segment_index: int
    fraction: float
    distance_m: float
    signed_distance_m: float
    along_m: float


def nearest_point_on_path(path: Sequence[LatLon], pos: LatLon) -> PathSnap:
    """Nearest point on a polyline, including signed cross-track distance.

    signed_distance_m is positive when the cart is left of the path direction
    for the nearest segment, negative when right of it.
    """
    if len(path) < 2:
        return PathSnap(path[0], 0, 0.0, haversine_m(pos, path[0]), 0.0, 0.0)

    best: PathSnap | None = None
    along_before = 0.0
    for i in range(len(path) - 1):
        a, b = path[i], path[i + 1]
        bx, by = local_xy(a, b)
        px, py = local_xy(a, pos)
        len_sq = bx * bx + by * by
        seg_len = math.sqrt(len_sq)
        if seg_len == 0:
            continue

        t = max(0.0, min(1.0, (px * bx + py * by) / len_sq))
        proj_x = bx * t
        proj_y = by * t
        dx = px - proj_x
        dy = py - proj_y
        distance = math.sqrt(dx * dx + dy * dy)
        cross = bx * py - by * px
        signed = distance if cross > 0 else -distance
        snap = PathSnap(
            point=from_local_xy(a, proj_x, proj_y),
            segment_index=i,
            fraction=t,
            distance_m=distance,
            signed_distance_m=signed,
            along_m=along_before + seg_len * t,
        )
        if best is None or snap.distance_m < best.distance_m:
            best = snap
        along_before += seg_len

    if best is not None:
        return best
    return PathSnap(path[0], 0, 0.0, haversine_m(pos, path[0]), 0.0, 0.0)


def point_at_distance(path: Sequence[LatLon], distance_m: float) -> Tuple[LatLon, int]:
    """Point at path arc-length distance_m from the first vertex."""
    if len(path) < 2:
        return path[0], 0

    acc = 0.0
    for i in range(len(path) - 1):
        seg_len = haversine_m(path[i], path[i + 1])
        if seg_len <= 0:
            continue
        if acc + seg_len >= distance_m:
            t = max(0.0, min(1.0, (distance_m - acc) / seg_len))
            return (
                (
                    path[i][0] + (path[i + 1][0] - path[i][0]) * t,
                    path[i][1] + (path[i + 1][1] - path[i][1]) * t,
                ),
                i + 1,
            )
        acc += seg_len
    return path[-1], len(path) - 1


def lookahead_point(path: Sequence[LatLon], pos: LatLon, lookahead_m: float
                    ) -> Tuple[LatLon, int]:
    """Return the path point ~lookahead_m ahead of the nearest path point.

    Uses nearest point on segment rather than nearest vertex so bends and long
    route segments do not make the controller chase stale vertices.
    """
    snap = nearest_point_on_path(path, pos)
    return point_at_distance(path, snap.along_m + lookahead_m)
