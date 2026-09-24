"""Live steering prediction from video or camera.

Usage:
  python live.py                           # replay training video
  python live.py --source 0               # webcam
  python live.py --source path/to/vid.mp4  # custom video
  python live.py --model b2               # use SegFormer-B2 (heavier, better)
"""
import argparse
import json
import math
import os
import time

import cv2
import numpy as np
import torch
from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor
from PIL import Image

from render import create_bev, create_overlay, CITYSCAPES_COLORS
from path_planning import lane_aware_centerline_path, map_route_to_bev
from render_trajectories import (
    SteeringEstimator, lookahead_point, draw_trajectory,
    draw_steering_wheel, draw_gps_position, FT_TO_M,
    RANGE_FWD, RANGE_SIDE, BEV_SIZE,
)

MODEL_VARIANTS = {
    "b0": "nvidia/segformer-b0-finetuned-cityscapes-1024-1024",
    "b2": "nvidia/segformer-b2-finetuned-cityscapes-1024-1024",
    "b5": "nvidia/segformer-b5-finetuned-cityscapes-1024-1024",
}

ROAD_COLOR = np.array(CITYSCAPES_COLORS[0], dtype=np.uint8)
GRID_COLOR = np.clip(np.array(CITYSCAPES_COLORS[0], dtype=np.int16) + 35, 0, 255).astype(np.uint8)
GRID2_COLOR = np.clip(np.array(CITYSCAPES_COLORS[0], dtype=np.int16) + 70, 0, 255).astype(np.uint8)


def load_segformer(variant, device):
    name = MODEL_VARIANTS[variant]
    print(f"Loading {name} on {device}...")
    t0 = time.time()
    proc = SegformerImageProcessor.from_pretrained(name)
    model = SegformerForSemanticSegmentation.from_pretrained(name).to(device).eval()
    params = sum(p.numel() for p in model.parameters()) / 1e6
    print(f"  Loaded in {time.time()-t0:.1f}s ({params:.1f}M params)")
    return proc, model


def segment_frame(frame_rgb, proc, model, device):
    pil = Image.fromarray(frame_rgb)
    inputs = proc(images=pil, return_tensors="pt").to(device)
    with torch.no_grad():
        out = model(**inputs)
    seg = proc.post_process_semantic_segmentation(
        out, target_sizes=[frame_rgb.shape[:2]]
    )[0].cpu().numpy().astype(np.uint8)
    return seg


def build_display(overlay_bgr, bev_frame_rgb, steer_deg, fps, lane_ms, seg_ms):
    h_target = 480
    ov = cv2.resize(overlay_bgr, (640, h_target))
    bv = cv2.resize(cv2.cvtColor(bev_frame_rgb, cv2.COLOR_RGB2BGR), (h_target, h_target))

    total_w = 640 + h_target
    wheel_r = 60
    panel_h = wheel_r * 2 + 50
    canvas = np.zeros((h_target + panel_h, total_w, 3), dtype=np.uint8)
    canvas[:h_target, :640] = ov
    canvas[:h_target, 640:] = bv

    cv2.putText(canvas, "Segmentation Overlay", (10, 25),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(canvas, "BEV + Trajectory", (650, 25),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)

    cv2.line(canvas, (0, h_target), (total_w, h_target), (60, 60, 60), 1)

    wheel_y = h_target + wheel_r + 8
    draw_steering_wheel(canvas, total_w // 2, wheel_y, wheel_r,
                        steer_deg, "Predicted", (255, 255, 0))

    info = f"{fps:.1f} fps  |  seg: {seg_ms:.0f}ms  plan: {lane_ms:.0f}ms  steer: {steer_deg:+.0f} deg"
    cv2.putText(canvas, info, (10, h_target + panel_h - 8),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (180, 180, 180), 1, cv2.LINE_AA)

    return canvas


def main():
    parser = argparse.ArgumentParser(description="Live steering prediction")
    parser.add_argument("--source", default=None,
                        help="Video path, camera index, or omit for training video")
    parser.add_argument("--model", default="b0", choices=MODEL_VARIANTS.keys(),
                        help="SegFormer variant (default: b0)")
    parser.add_argument("--device", default=None,
                        help="torch device (auto-detected if omitted)")
    parser.add_argument("--skip", type=int, default=1,
                        help="Process every Nth frame (default: 1 = all)")
    args = parser.parse_args()

    base = os.path.dirname(os.path.abspath(__file__))

    if args.device:
        device = args.device
    elif torch.backends.mps.is_available():
        device = "mps"
    elif torch.cuda.is_available():
        device = "cuda"
    else:
        device = "cpu"

    with open(os.path.join(base, "camera_calibration.json")) as f:
        calib = json.load(f)

    import render_trajectories as rt
    bev_range = calib.get("bev_range", {})
    rt.RANGE_FWD = bev_range.get("forward_ft", 50) * FT_TO_M
    rt.RANGE_SIDE = bev_range.get("side_ft", 25) * FT_TO_M
    range_fwd = rt.RANGE_FWD
    range_side = rt.RANGE_SIDE
    bev_size = rt.BEV_SIZE
    road_width_ft = calib.get("road_width_ft", 20.0)

    # Determine video source
    if args.source is None:
        src = os.path.join(base, "Caddy-Training-Data-2026-05-03_16-08-00", "front-wide.mp4")
    elif args.source.isdigit():
        src = int(args.source)
    else:
        src = args.source

    # Load model
    proc, model = load_segformer(args.model, device)

    # Steering estimator
    steer_est = SteeringEstimator()

    # Try loading map route for BEV overlay (optional)
    map_route = None
    mr_bx = mr_by = np.array([])
    try:
        from path_planning import load_gps_route, load_map_route
        data_dir = os.path.join(base, "Caddy-Training-Data-2026-05-03_16-08-00")
        gps_route, ref_lat, ref_lon = load_gps_route(os.path.join(data_dir, "gps.json"))
        map_route = load_map_route(os.path.join(data_dir, "map_route.json"), ref_lat, ref_lon)
        print(f"Loaded map route ({len(map_route)} pts)")
    except Exception:
        print("No map route available — running without GPS/map overlay")

    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        print(f"ERROR: cannot open {src}")
        return

    vid_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"Source: {w}x{h} @ {vid_fps:.0f}fps, {total_frames} frames")
    print(f"Device: {device}  Model: SegFormer-{args.model.upper()}  Skip: {args.skip}")
    print("Press Q to quit, SPACE to pause\n")

    frame_count = 0
    t_start = time.time()
    paused = False
    fps_ema = 0.0

    while True:
        if not paused:
            ret, frame_bgr = cap.read()
            if not ret:
                if isinstance(src, str):
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                break
            frame_count += 1
            if frame_count % args.skip != 0:
                continue

            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            t_frame_start = time.perf_counter()

            # Segmentation
            t0 = time.perf_counter()
            seg_map = segment_frame(frame_rgb, proc, model, device)
            if device == "mps":
                torch.mps.synchronize()
            seg_ms = (time.perf_counter() - t0) * 1000

            # BEV
            bev_base = create_bev(seg_map, calib, bev_size)
            road_mask = (np.all(bev_base == ROAD_COLOR, axis=-1) |
                         np.all(bev_base == GRID_COLOR, axis=-1) |
                         np.all(bev_base == GRID2_COLOR, axis=-1))

            # Path planning
            t0 = time.perf_counter()
            if map_route is not None:
                vid_t = cap.get(cv2.CAP_PROP_POS_FRAMES) / vid_fps
                from path_planning import get_ego_from_gps
                ego_x, ego_y, ego_yaw, _ = get_ego_from_gps(gps_route, vid_t)
                mr_bx, mr_by = map_route_to_bev(
                    map_route, ego_x, ego_y, ego_yaw, bev_size, range_fwd, range_side
                )

            lane_traj, lane_local = lane_aware_centerline_path(
                road_mask, bev_size=bev_size, range_fwd=range_fwd, range_side=range_side,
                road_mask=road_mask, gps_bx=mr_bx, gps_by=mr_by,
                road_width_ft=road_width_ft
            )
            lane_ms = (time.perf_counter() - t0) * 1000

            # Steering
            steer_est.update_bev(lane_local)
            steer_deg = steer_est.steering_deg

            total_ms = (time.perf_counter() - t_frame_start) * 1000
            cur_fps = 1000.0 / max(total_ms, 1)
            fps_ema = 0.3 * cur_fps + 0.7 * fps_ema if fps_ema > 0 else cur_fps

            # Draw BEV overlay
            bev_frame = bev_base.copy()
            draw_trajectory(bev_frame, lane_traj, (255, 255, 0), 3)
            la_point, la_ft = lookahead_point(lane_local)
            if la_point is not None:
                la_bx = int((la_point[1] / range_side * 0.5 + 0.5) * bev_size)
                la_by = int((1 - la_point[0] / range_fwd) * bev_size)
                ego_bx, ego_by = bev_size // 2, bev_size - 1
                if 0 <= la_bx < bev_size and 0 <= la_by < bev_size:
                    cv2.line(bev_frame, (ego_bx, ego_by), (la_bx, la_by),
                             (0, 255, 255), 2, cv2.LINE_AA)
                    cv2.circle(bev_frame, (la_bx, la_by), 6, (0, 255, 255), -1, cv2.LINE_AA)
            draw_gps_position(bev_frame, 0, 0, 0)

            # Overlay
            overlay = create_overlay(frame_rgb, seg_map)
            overlay_bgr = cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR)

            # Compose display
            display = build_display(overlay_bgr, bev_frame, steer_deg,
                                    fps_ema, lane_ms, seg_ms)
            cv2.imshow("Drive-By Segmentation — Live", display)

        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        elif key == ord(" "):
            paused = not paused

    cap.release()
    cv2.destroyAllWindows()
    elapsed = time.time() - t_start
    print(f"\nProcessed {frame_count} frames in {elapsed:.1f}s ({frame_count/elapsed:.1f} fps)")


if __name__ == "__main__":
    main()
