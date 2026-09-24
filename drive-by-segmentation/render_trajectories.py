"""
Render path planning trajectories on BEV segmentation maps.
Uses SegFormer seg_maps.npz + map route + GPS + ego data to plan and visualize
trajectories. The map route (A→B) provides the intended path; GPS localizes
the cart on it; the planner predicts a driveable trajectory.
"""
import numpy as np
import cv2
import json
import math
import os
import time
import subprocess

from render import create_bev, create_overlay, encode_h264, CITYSCAPES_COLORS
from path_planning import (
    load_gps_route, load_ego_data, get_ego_from_gps,
    lane_aware_centerline_path,
    world_to_bev_batch, gps_to_local, gps_to_bev, map_route_to_bev,
    load_map_route, localize_on_map_route, get_map_route_ahead, GOLF_CART_L,
)

FT_TO_M = 0.3048
RANGE_FWD = 50 * FT_TO_M
RANGE_SIDE = 25 * FT_TO_M
BEV_SIZE = 500

STEERING_RATIO = 6.8  # column degrees per wheel degree

LOOKAHEAD_FT = 25.0
LOOKAHEAD_M = LOOKAHEAD_FT * FT_TO_M


class SteeringEstimator:
    """Real-time causal steering estimator.

    Uses only BEV lane-center path heading (vision-only, no IMU curvature).
    EMA smoothing accumulates temporal evidence across frames.

    Tuned via Ridge regression (5-fold CV MAE ≈ 28.0°):
      steering ≈ W_BEV × EMA(bev_heading) + intercept

    Call update_bev() when a new BEV frame is available (~2 Hz).
    Read .steering_deg for the current prediction.
    """

    BEV_EMA = 0.30          # EMA alpha for BEV heading — balances responsiveness vs noise
    W_BEV = 142.0           # regression weight: radians → steering degrees
    INTERCEPT = 9.0         # regression intercept

    def __init__(self):
        self._ema_heading = 0.0

    @property
    def steering_deg(self):
        raw = self.W_BEV * self._ema_heading + self.INTERCEPT
        return max(-270.0, min(270.0, raw))

    def update_bev(self, lane_local):
        """Feed BEV lane-center path in ego-local coords (fwd, left).

        Extracts path heading in the 0.5–3 m range ahead of the ego
        and applies causal EMA smoothing.
        """
        if lane_local is None or len(lane_local) < 4:
            return
        fwd = lane_local[:, 0]
        left = lane_local[:, 1]
        mask = (fwd > 0.5) & (fwd < 3.0)
        if mask.sum() >= 2:
            raw_heading = math.atan2(
                left[mask][-1] - left[mask][0],
                fwd[mask][-1] - fwd[mask][0],
            )
            self._ema_heading = (self.BEV_EMA * raw_heading +
                                 (1 - self.BEV_EMA) * self._ema_heading)


def load_control_data(control_path):
    controls = []
    with open(control_path) as f:
        for line in f:
            c = json.loads(line.strip())
            controls.append(c)
    return controls


def get_gt_steering_at_time(controls, t):
    for i in range(len(controls) - 1):
        if controls[i]["rel_t"] <= t <= controls[i + 1]["rel_t"]:
            alpha = (t - controls[i]["rel_t"]) / (controls[i + 1]["rel_t"] - controls[i]["rel_t"] + 1e-9)
            return controls[i]["column_deg_actual"] * (1 - alpha) + controls[i + 1]["column_deg_actual"] * alpha
    return controls[-1]["column_deg_actual"]


def lookahead_point(traj_local):
    """BEV path lookahead point for visualization."""
    if traj_local is None or len(traj_local) < 4:
        return None, 0.0

    fwd = traj_local[1:, 0]
    left = traj_local[1:, 1]

    if len(fwd) < 5:
        return None, 0.0

    coeffs = np.polyfit(fwd, left, 2)
    la_fwd_val = LOOKAHEAD_M
    la_left_val = float(np.polyval(coeffs, la_fwd_val))

    return (la_fwd_val, la_left_val), LOOKAHEAD_FT


def draw_steering_wheel(img, cx, cy, radius, angle_deg, label, color, bg_color=(30, 30, 30)):
    """Draw a steering wheel rotated by angle_deg with label underneath."""
    size = radius * 2 + 40
    wheel_img = np.full((size, size, 3), bg_color[0], dtype=np.uint8)
    wcx, wcy = size // 2, size // 2

    angle_rad = math.radians(angle_deg)

    # Outer ring
    cv2.circle(wheel_img, (wcx, wcy), radius, color, 3, cv2.LINE_AA)
    # Inner ring
    cv2.circle(wheel_img, (wcx, wcy), radius - 12, color, 2, cv2.LINE_AA)

    # Three spokes at 120° apart, rotated by steering angle
    for spoke_angle in [0, 120, 240]:
        a = angle_rad + math.radians(spoke_angle)
        sx = int(wcx + (radius - 12) * math.cos(a))
        sy = int(wcy + (radius - 12) * math.sin(a))
        ix = int(wcx + 10 * math.cos(a))
        iy = int(wcy + 10 * math.sin(a))
        cv2.line(wheel_img, (ix, iy), (sx, sy), color, 2, cv2.LINE_AA)

    # Center hub
    cv2.circle(wheel_img, (wcx, wcy), 8, color, -1, cv2.LINE_AA)

    # Top marker (reference notch) — always at 12 o'clock
    cv2.circle(wheel_img, (wcx, wcy - radius + 6), 5, (255, 255, 255), -1, cv2.LINE_AA)

    # Rotated position marker — shows where the top marker has moved
    marker_x = int(wcx + (radius - 6) * math.sin(angle_rad))
    marker_y = int(wcy - (radius - 6) * math.cos(angle_rad))
    cv2.circle(wheel_img, (marker_x, marker_y), 5, color, -1, cv2.LINE_AA)

    # Place onto target image
    x1 = cx - size // 2
    y1 = cy - size // 2
    h, w = img.shape[:2]
    # Clip to image bounds
    sx1 = max(0, -x1)
    sy1 = max(0, -y1)
    dx1 = max(0, x1)
    dy1 = max(0, y1)
    sx2 = min(size, w - x1)
    sy2 = min(size, h - y1)
    if sx2 > sx1 and sy2 > sy1:
        img[dy1:dy1 + sy2 - sy1, dx1:dx1 + sx2 - sx1] = wheel_img[sy1:sy2, sx1:sx2]

    # Label underneath
    text = f"{label}: {angle_deg:+.1f} deg"
    text_size = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)[0]
    tx = cx - text_size[0] // 2
    ty = cy + radius + 28
    if 0 <= tx < w and 0 <= ty < h:
        cv2.putText(img, text, (tx, ty),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv2.LINE_AA)


def draw_trajectory(bev_img, traj_bev, color, thickness=3, label=None):
    """Draw a trajectory line on a BEV image."""
    if traj_bev is None or len(traj_bev) < 2:
        return
    pts = traj_bev.copy()
    valid = (pts[:, 0] >= 0) & (pts[:, 0] < BEV_SIZE) & (pts[:, 1] >= 0) & (pts[:, 1] < BEV_SIZE)
    if valid.sum() < 2:
        return

    for i in range(len(pts) - 1):
        if valid[i] and valid[i + 1]:
            cv2.line(bev_img,
                     (int(pts[i, 0]), int(pts[i, 1])),
                     (int(pts[i + 1, 0]), int(pts[i + 1, 1])),
                     color, thickness, cv2.LINE_AA)

    for i in range(0, len(pts), 5):
        if valid[i]:
            cv2.circle(bev_img, (int(pts[i, 0]), int(pts[i, 1])), 3, color, -1, cv2.LINE_AA)

    if label:
        for i in range(len(pts)):
            if valid[i]:
                cv2.putText(bev_img, label, (int(pts[i, 0]) + 6, int(pts[i, 1]) - 6),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.35, color, 1, cv2.LINE_AA)
                break


def draw_gps_route(bev_img, gps_route, ego_x, ego_y, ego_yaw, ref_lat, ref_lon):
    """Draw the raw GPS recording on BEV as a thin dotted line."""
    wx = gps_route[:, 1]
    wy = gps_route[:, 2]

    dx = wx - ego_x
    dy = wy - ego_y
    c, s = np.cos(-ego_yaw), np.sin(-ego_yaw)
    local_fwd = dx * c - dy * s
    local_left = dx * s + dy * c

    bx = ((local_left / RANGE_SIDE * 0.5 + 0.5) * BEV_SIZE).astype(int)
    by = ((1 - local_fwd / RANGE_FWD) * BEV_SIZE).astype(int)

    valid = (bx >= 0) & (bx < BEV_SIZE) & (by >= 0) & (by < BEV_SIZE)
    valid &= (local_fwd > 0) & (local_fwd < RANGE_FWD)

    for i in range(len(bx) - 1):
        if valid[i] and valid[i + 1] and i % 3 == 0:
            cv2.line(bev_img, (bx[i], by[i]), (bx[i + 1], by[i + 1]),
                     (200, 200, 200), 1, cv2.LINE_AA)


def draw_map_route(bev_img, map_route, ego_x, ego_y, ego_yaw):
    """Draw the planned map route (A→B) on BEV as a thick cyan dashed line."""
    dx = map_route[:, 0] - ego_x
    dy = map_route[:, 1] - ego_y
    c, s = np.cos(-ego_yaw), np.sin(-ego_yaw)
    local_fwd = dx * c - dy * s
    local_left = dx * s + dy * c

    bx = ((local_left / RANGE_SIDE * 0.5 + 0.5) * BEV_SIZE).astype(int)
    by = ((1 - local_fwd / RANGE_FWD) * BEV_SIZE).astype(int)

    valid = (bx >= 0) & (bx < BEV_SIZE) & (by >= 0) & (by < BEV_SIZE)
    valid &= (local_fwd > 0) & (local_fwd < RANGE_FWD)

    color = (0, 220, 255)  # cyan/yellow
    for i in range(len(bx) - 1):
        if valid[i] and valid[i + 1]:
            if (i // 2) % 2 == 0:
                cv2.line(bev_img, (bx[i], by[i]), (bx[i + 1], by[i + 1]),
                         color, 2, cv2.LINE_AA)

    for i in range(0, len(bx), 3):
        if valid[i]:
            cv2.circle(bev_img, (bx[i], by[i]), 4, color, -1, cv2.LINE_AA)

    # Label
    for i in range(len(bx)):
        if valid[i]:
            cv2.putText(bev_img, "Map Route", (int(bx[i]) + 8, int(by[i]) - 8),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1, cv2.LINE_AA)
            break


def draw_gps_position(bev_img, ego_x, ego_y, ego_yaw):
    """Draw the current GPS position as a prominent dot at BEV ego origin."""
    bx = BEV_SIZE // 2
    by = BEV_SIZE - 1
    color = (50, 150, 255)  # orange
    cv2.circle(bev_img, (bx, by), 8, color, -1, cv2.LINE_AA)
    cv2.circle(bev_img, (bx, by), 10, (255, 255, 255), 1, cv2.LINE_AA)
    # Heading arrow
    arrow_len = 20
    ax = int(bx + arrow_len * math.sin(0))
    ay = int(by - arrow_len * math.cos(0))
    cv2.arrowedLine(bev_img, (bx, by), (ax, ay), color, 2, cv2.LINE_AA, tipLength=0.4)
    cv2.putText(bev_img, "GPS", (bx + 14, by + 4),
               cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1, cv2.LINE_AA)


def main():
    base = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(base, "Caddy-Training-Data-2026-05-03_16-08-00")
    video_path = os.path.join(data_dir, "front-wide.mp4")
    calib_path = os.path.join(base, "camera_calibration.json")
    gps_path = os.path.join(data_dir, "gps.json")
    ego_path = os.path.join(data_dir, "ego.jsonl")
    seg_dir = os.path.join(base, "eval_output", "segformer")
    output_dir = os.path.join(base, "eval_output", "trajectories")
    os.makedirs(output_dir, exist_ok=True)

    with open(calib_path) as f:
        calib = json.load(f)

    global RANGE_FWD, RANGE_SIDE
    bev_range = calib.get("bev_range", {})
    RANGE_FWD = bev_range.get("forward_ft", 50) * FT_TO_M
    RANGE_SIDE = bev_range.get("side_ft", 25) * FT_TO_M

    control_path = os.path.join(data_dir, "control.jsonl")

    map_route_path = os.path.join(data_dir, "map_route.json")

    gps_route, ref_lat, ref_lon = load_gps_route(gps_path)
    map_route = load_map_route(map_route_path, ref_lat, ref_lon)
    _ = load_ego_data(ego_path)  # available if needed
    controls = load_control_data(control_path)
    print(f"Loaded map route: {len(map_route)} waypoints")

    seg_data = np.load(os.path.join(seg_dir, "seg_maps.npz"))
    seg_maps = seg_data["seg_maps"]
    frame_indices = seg_data["frame_indices"]

    cap = cv2.VideoCapture(video_path)
    fps_video = 30

    combined_frames = []
    overlay_frames = []
    pred_steers = []
    gt_steers = []

    total = len(frame_indices)
    max_time = frame_indices[-1] / fps_video if total > 0 else 0
    print(f"Planning trajectories for {total} frames (SegFormer, {max_time:.0f}s)...")

    # Causal steering estimator — vision-only, processes frames one at a time
    steer_est = SteeringEstimator()

    smoothed_gt = 0.0

    for i, frame_idx in enumerate(frame_indices):
        t = frame_idx / fps_video
        seg_map = seg_maps[i]

        ego_x, ego_y, ego_yaw, ego_speed = get_ego_from_gps(gps_route, t)

        map_idx, map_dist = localize_on_map_route(map_route, ego_x, ego_y)
        map_ahead = get_map_route_ahead(map_route, map_idx)

        # Render the BEV — this is the exact image shown in the video
        bev_base = create_bev(seg_map, calib, BEV_SIZE)

        # Extract road mask directly from the rendered BEV pixel colors
        road_color = np.array(CITYSCAPES_COLORS[0], dtype=np.uint8)
        grid_color = np.clip(np.array(CITYSCAPES_COLORS[0], dtype=np.int16) + 35, 0, 255).astype(np.uint8)
        grid2_color = np.clip(np.array(CITYSCAPES_COLORS[0], dtype=np.int16) + 70, 0, 255).astype(np.uint8)
        road_mask = (np.all(bev_base == road_color, axis=-1) |
                     np.all(bev_base == grid_color, axis=-1) |
                     np.all(bev_base == grid2_color, axis=-1))

        mr_bx, mr_by = map_route_to_bev(map_route, ego_x, ego_y, ego_yaw, BEV_SIZE, RANGE_FWD, RANGE_SIDE)

        # Lane-aware centerline planner
        t0 = time.time()
        road_width_ft = calib.get("road_width_ft", 20.0)
        lane_traj, lane_local = lane_aware_centerline_path(
            road_mask, bev_size=BEV_SIZE, range_fwd=RANGE_FWD, range_side=RANGE_SIDE,
            road_mask=road_mask, gps_bx=mr_bx, gps_by=mr_by,
            road_width_ft=road_width_ft
        )
        lane_ms = (time.time() - t0) * 1000

        # Feed BEV path into steering estimator for anticipatory correction
        steer_est.update_bev(lane_local)
        pred_steers.append(steer_est.steering_deg)

        raw_gt = get_gt_steering_at_time(controls, t)
        smoothed_gt = 0.3 * raw_gt + 0.7 * smoothed_gt
        gt_steers.append(smoothed_gt)

        la_point, la_ft = lookahead_point(lane_local)

        # ── BEV + trajectory + lookahead ──
        bev_frame = bev_base.copy()
        draw_map_route(bev_frame, map_route, ego_x, ego_y, ego_yaw)
        draw_trajectory(bev_frame, lane_traj, (255, 255, 0), 3, "Lane Center")

        # Draw lookahead point and line from ego
        if la_point is not None:
            la_bx = int((la_point[1] / RANGE_SIDE * 0.5 + 0.5) * BEV_SIZE)
            la_by = int((1 - la_point[0] / RANGE_FWD) * BEV_SIZE)
            ego_bx, ego_by = BEV_SIZE // 2, BEV_SIZE - 1
            if 0 <= la_bx < BEV_SIZE and 0 <= la_by < BEV_SIZE:
                cv2.line(bev_frame, (ego_bx, ego_by), (la_bx, la_by),
                         (0, 255, 255), 2, cv2.LINE_AA)
                cv2.circle(bev_frame, (la_bx, la_by), 8, (0, 255, 255), 2, cv2.LINE_AA)
                cv2.circle(bev_frame, (la_bx, la_by), 3, (0, 255, 255), -1, cv2.LINE_AA)
                cv2.putText(bev_frame, f"LA {la_ft:.0f}ft",
                            (la_bx + 10, la_by - 10),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 255, 255), 1, cv2.LINE_AA)

        draw_gps_position(bev_frame, ego_x, ego_y, ego_yaw)
        combined_frames.append(cv2.cvtColor(bev_frame, cv2.COLOR_RGB2BGR))

        # Overlay camera frame
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if ret:
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            overlay = create_overlay(frame_rgb, seg_map)
            overlay_frames.append(cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR))
        else:
            overlay_frames.append(np.zeros((480, 640, 3), dtype=np.uint8))

        if (i + 1) % 25 == 0 or i == 0:
            print(f"  [{i+1}/{total}] Lane: {lane_ms:.0f}ms"
                  f"  speed={ego_speed:.1f}m/s  map_idx={map_idx}/{len(map_route)}"
                  f"  map_dist={map_dist:.1f}m")

    cap.release()

    # Compute per-frame repeat counts to fill 30fps output
    repeats = []
    for idx in range(len(frame_indices)):
        if idx + 1 < len(frame_indices):
            repeats.append(int(frame_indices[idx + 1] - frame_indices[idx]))
        else:
            repeats.append(repeats[-1] if repeats else 15)

    # Encode videos
    print("\nEncoding videos...")

    def expand_30fps(frames):
        out = []
        for i, f in enumerate(frames):
            r = repeats[i] if i < len(repeats) else 15
            for _ in range(r):
                out.append(f)
        return out

    encode_h264(expand_30fps(combined_frames), os.path.join(output_dir, "bev_lane_center.mp4"), fps=30)

    if overlay_frames:
        encode_h264(expand_30fps(overlay_frames), os.path.join(output_dir, "overlay.mp4"), fps=30)

    # Side-by-side: overlay + BEV + steering wheels
    sbs_frames = []
    wheel_radius = 70
    wheel_panel_h = wheel_radius * 2 + 60
    h_target = 480
    for i in range(min(len(overlay_frames), len(combined_frames))):
        ov = overlay_frames[i]
        cb = combined_frames[i]

        ov_resized = cv2.resize(ov, (640, h_target))
        cb_resized = cv2.resize(cb, (h_target, h_target))

        total_w = 640 + h_target
        canvas = np.zeros((h_target + wheel_panel_h, total_w, 3), dtype=np.uint8)
        canvas[:h_target, :640] = ov_resized
        canvas[:h_target, 640:] = cb_resized

        cv2.putText(canvas, "Segmentation Overlay", (10, 25),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(canvas, "BEV + Trajectory", (650, 25),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)

        # Legend
        lx = 650
        ly = 50
        legend_items = [
            ("Map Route (A->B)", (0, 220, 255)),
            ("Lane Center Pred", (255, 255, 0)),
            ("Lookahead (speed-scaled)", (0, 255, 255)),
            ("GPS Position", (50, 150, 255)),
        ]
        for label, color in legend_items:
            cv2.circle(canvas, (lx, ly), 5, color, -1, cv2.LINE_AA)
            cv2.putText(canvas, label, (lx + 12, ly + 4),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.35, color, 1, cv2.LINE_AA)
            ly += 18

        # Divider line
        cv2.line(canvas, (0, h_target), (total_w, h_target), (60, 60, 60), 1)

        # Steering wheels
        wheel_y = h_target + wheel_radius + 12
        pred_wx = total_w // 4
        gt_wx = 3 * total_w // 4

        pred_col_deg = pred_steers[i] if i < len(pred_steers) else 0
        gt_col_deg = gt_steers[i] if i < len(gt_steers) else 0

        draw_steering_wheel(canvas, pred_wx, wheel_y, wheel_radius,
                           pred_col_deg, "Predicted", (255, 255, 0))
        draw_steering_wheel(canvas, gt_wx, wheel_y, wheel_radius,
                           gt_col_deg, "Ground Truth", (255, 255, 255))

        sbs_frames.append(canvas)

    encode_h264(expand_30fps(sbs_frames), os.path.join(output_dir, "side_by_side.mp4"), fps=30)

    # Save sample images
    for j, si in enumerate([0, total // 4, total // 2, 3 * total // 4]):
        if si < len(combined_frames):
            cv2.imwrite(os.path.join(output_dir, f"sample_{j}_combined.jpg"),
                       combined_frames[si], [cv2.IMWRITE_JPEG_QUALITY, 90])

    print(f"\nDone! Saved to {output_dir}/")
    print(f"  bev_lane_center.mp4, side_by_side.mp4")
    print(f"  {min(4, len(combined_frames))} sample images")


if __name__ == "__main__":
    main()
