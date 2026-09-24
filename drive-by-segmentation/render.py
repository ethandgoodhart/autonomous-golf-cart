"""Local rendering of segmentation results. No GPU needed.
Run after eval_segmentation.py to generate overlay, BEV, and side-by-side videos.
Re-run this anytime you change visualization params without re-running inference.
"""
import numpy as np
import cv2
import json
import math
import os
import subprocess

CITYSCAPES_COLORS = [
    (128, 64, 128),   # road
    (244, 35, 232),   # sidewalk
    (70, 70, 70),     # building
    (102, 102, 156),  # wall
    (190, 153, 153),  # fence
    (153, 153, 153),  # pole
    (250, 170, 30),   # traffic light
    (220, 220, 0),    # traffic sign
    (107, 142, 35),   # vegetation
    (152, 251, 152),  # terrain
    (70, 130, 180),   # sky
    (220, 20, 60),    # person
    (255, 0, 0),      # rider
    (0, 0, 142),      # car
    (0, 0, 70),       # truck
    (0, 60, 100),     # bus
    (0, 80, 100),     # train
    (0, 0, 230),      # motorcycle
    (119, 11, 32),    # bicycle
]


def create_overlay(frame_rgb, seg_map, alpha=0.45):
    color_mask = np.zeros_like(frame_rgb)
    for cls_id, color in enumerate(CITYSCAPES_COLORS):
        mask = seg_map == cls_id
        color_mask[mask] = color
    return ((1 - alpha) * frame_rgb + alpha * color_mask).astype(np.uint8)


def create_bev(seg_map, calib, bev_size=500, return_class_map=False):
    f = calib["intrinsics"]["focal_length"]
    cx_param = calib["intrinsics"]["cx"]
    cy_param = calib["intrinsics"]["cy"]
    k1 = calib["intrinsics"]["k1"]
    k2 = calib["intrinsics"]["k2"]
    h = calib["extrinsics"]["height_m"]
    img_h, img_w = seg_map.shape[:2]

    FT_TO_M = 0.3048
    bev_range = calib.get("bev_range", {})
    range_forward_ft = bev_range.get("forward_ft", 50)
    range_side_ft = bev_range.get("side_ft", 25)
    range_forward = range_forward_ft * FT_TO_M
    range_side = range_side_ft * FT_TO_M

    pitch = math.radians(calib["extrinsics"]["pitch_deg"])
    roll = math.radians(calib["extrinsics"]["roll_deg"])
    yaw = math.radians(calib["extrinsics"]["yaw_deg"])
    cp, sp = math.cos(pitch), math.sin(pitch)
    cr, sr = math.cos(roll), math.sin(roll)
    cyw, syw = math.cos(yaw), math.sin(yaw)

    def matmul(A, B):
        C = [[0]*3 for _ in range(3)]
        for i in range(3):
            for j in range(3):
                for kk in range(3):
                    C[i][j] += A[i][kk] * B[kk][j]
        return C

    Ryaw = [[cyw, -syw, 0], [syw, cyw, 0], [0, 0, 1]]
    Rbase = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
    Rpitch = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]]
    Rroll = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]]
    R = matmul(Rroll, matmul(Rpitch, matmul(Rbase, Ryaw)))

    bev_color = np.full((bev_size, bev_size, 3), 30, dtype=np.uint8)
    in_fov = np.zeros((bev_size, bev_size), dtype=bool)

    by_arr, bx_arr = np.mgrid[0:bev_size, 0:bev_size]
    by_flat = by_arr.ravel()
    bx_flat = bx_arr.ravel()

    wx = (bx_flat / bev_size - 0.5) * 2 * range_side
    wy = (1 - by_flat / bev_size) * range_forward

    mask = wy > 0.15
    wx, wy = wx[mask], wy[mask]
    by_f, bx_f = by_flat[mask], bx_flat[mask]

    dx, dy, dz = wx, wy, np.full_like(wx, -h)

    cam_x = R[0][0]*dx + R[0][1]*dy + R[0][2]*dz
    cam_y = R[1][0]*dx + R[1][1]*dy + R[1][2]*dz
    cam_z = R[2][0]*dx + R[2][1]*dy + R[2][2]*dz

    m2 = cam_z > 0.01
    cam_x, cam_y, cam_z = cam_x[m2], cam_y[m2], cam_z[m2]
    by_f, bx_f = by_f[m2], bx_f[m2]

    r3d = np.sqrt(cam_x**2 + cam_y**2)
    theta = np.arctan2(r3d, cam_z)
    m3 = theta < math.pi * 0.47
    cam_x, cam_y, r3d, theta = cam_x[m3], cam_y[m3], r3d[m3], theta[m3]
    by_f, bx_f = by_f[m3], bx_f[m3]

    t2 = theta**2
    td = theta * (1 + k1*t2 + k2*t2*t2)
    rp = f * td

    safe = r3d > 1e-8
    u = np.where(safe, cx_param + rp * cam_x / r3d, cx_param)
    v = np.where(safe, cy_param + rp * cam_y / r3d, cy_param)

    iu = np.floor(u).astype(np.int32)
    iv = np.floor(v).astype(np.int32)
    m4 = (iu >= 0) & (iu < img_w) & (iv >= 0) & (iv < img_h)
    iu, iv = iu[m4], iv[m4]
    by_f, bx_f = by_f[m4], bx_f[m4]

    in_fov[by_f, bx_f] = True
    cls_ids = seg_map[iv, iu]

    # Class-ID map: same projection as the color image, before any overlays
    if return_class_map:
        cls_map = np.full((bev_size, bev_size), 255, dtype=np.uint8)
        cls_map[by_f, bx_f] = cls_ids

    colors = np.array(CITYSCAPES_COLORS, dtype=np.uint8)
    valid_cls = cls_ids < len(CITYSCAPES_COLORS)
    bev_color[by_f[valid_cls], bx_f[valid_cls]] = colors[cls_ids[valid_cls]]

    # FOV boundary
    fov_border = np.zeros((bev_size, bev_size), dtype=np.uint8)
    fov_border[in_fov] = 255
    dilated = cv2.dilate(fov_border, np.ones((3, 3), dtype=np.uint8))
    bev_color[(dilated > 0) & (~in_fov)] = (80, 80, 80)

    # Grid lines inside FOV
    for dist_ft in range(10, range_forward_ft + 1, 10):
        by_grid = int((1 - dist_ft * FT_TO_M / range_forward) * bev_size)
        if 0 <= by_grid < bev_size:
            row_fov = in_fov[by_grid, :]
            row = bev_color[by_grid].astype(np.int16)
            row[row_fov] = np.clip(row[row_fov] + 35, 0, 255)
            bev_color[by_grid] = row.astype(np.uint8)

    for dist_ft in range(-20, range_side_ft + 1, 10):
        bx_grid = int((dist_ft / range_side_ft * 0.5 + 0.5) * bev_size)
        if 0 <= bx_grid < bev_size:
            col_fov = in_fov[:, bx_grid]
            col = bev_color[:, bx_grid].astype(np.int16)
            col[col_fov] = np.clip(col[col_fov] + 35, 0, 255)
            bev_color[:, bx_grid] = col.astype(np.uint8)

    # Distance labels
    for dist_ft in range(10, range_forward_ft + 1, 10):
        by_grid = int((1 - dist_ft * FT_TO_M / range_forward) * bev_size)
        if 0 <= by_grid < bev_size:
            cv2.putText(bev_color, f"{dist_ft}ft", (4, by_grid - 4),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.4, (220, 220, 220), 1, cv2.LINE_AA)

    # Ego car triangle
    ex, ey = bev_size // 2, bev_size - 8
    pts = np.array([[ex, ey - 14], [ex - 7, ey], [ex + 7, ey]])
    cv2.fillPoly(bev_color, [pts], (255, 255, 255))

    if return_class_map:
        return bev_color, cls_map
    return bev_color


def encode_h264(frames, path, fps=2):
    if not frames:
        return
    h, w = frames[0].shape[:2]
    tmp = path + ".tmp.mp4"
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(tmp, fourcc, fps, (w, h))
    for f in frames:
        writer.write(f)
    writer.release()
    subprocess.run(
        ["ffmpeg", "-y", "-i", tmp, "-c:v", "libx264",
         "-pix_fmt", "yuv420p", "-crf", "18", path],
        capture_output=True,
    )
    os.remove(tmp)


def make_side_by_side(overlay_path, bev_path, output_path):
    filter_str = (
        "[0:v]drawtext=text='Segmentation Overlay':"
        "fontsize=22:fontcolor=white:borderw=2:bordercolor=black:"
        "x=10:y=10[left];"
        "[1:v]scale=480:480[bev_scaled];"
        "[bev_scaled]drawtext=text='BEV (Top-Down)':"
        "fontsize=22:fontcolor=white:borderw=2:bordercolor=black:"
        "x=10:y=10[right];"
        "[left][right]hstack=inputs=2[out]"
    )
    subprocess.run(
        ["ffmpeg", "-y",
         "-i", overlay_path, "-i", bev_path,
         "-filter_complex", filter_str,
         "-map", "[out]",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
         output_path],
        capture_output=True,
    )


def main():
    base = os.path.dirname(os.path.abspath(__file__))
    video_path = os.path.join(base, "Caddy-Training-Data-2026-05-03_16-08-00", "front-wide.mp4")
    calib_path = os.path.join(base, "camera_calibration.json")
    output_dir = os.path.join(base, "eval_output")

    with open(calib_path) as f:
        calib = json.load(f)

    cap = cv2.VideoCapture(video_path)

    for model_name in ["segformer", "mask2former", "ddrnet"]:
        model_dir = os.path.join(output_dir, model_name)
        seg_path = os.path.join(model_dir, "seg_maps.npz")
        if not os.path.exists(seg_path):
            print(f"Skipping {model_name} - no seg_maps.npz (run eval_segmentation.py first)")
            continue

        print(f"\nRendering {model_name}...")
        data = np.load(seg_path)
        seg_maps = data["seg_maps"]
        frame_indices = data["frame_indices"]

        overlay_frames = []
        bev_frames = []

        for i, frame_idx in enumerate(frame_indices):
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = cap.read()
            if not ret:
                continue

            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            seg_map = seg_maps[i]

            overlay = create_overlay(frame_rgb, seg_map)
            overlay_frames.append(cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR))

            bev = create_bev(seg_map, calib)
            bev_frames.append(cv2.cvtColor(bev, cv2.COLOR_RGB2BGR))

            if (i + 1) % 50 == 0:
                print(f"  Rendered {i + 1}/{len(frame_indices)} frames")

        # Save videos
        overlay_path = os.path.join(model_dir, "overlay.mp4")
        bev_path = os.path.join(model_dir, "bev.mp4")
        sbs_path = os.path.join(model_dir, "side_by_side.mp4")

        print(f"  Encoding videos...")
        encode_h264(overlay_frames, overlay_path)
        encode_h264(bev_frames, bev_path)
        make_side_by_side(overlay_path, bev_path, sbs_path)

        # Save sample JPGs
        sample_indices = [0, len(overlay_frames)//4, len(overlay_frames)//2, 3*len(overlay_frames)//4]
        for j, si in enumerate(sample_indices):
            if si < len(overlay_frames):
                cv2.imwrite(os.path.join(model_dir, f"sample_{j}_overlay.jpg"),
                           overlay_frames[si], [cv2.IMWRITE_JPEG_QUALITY, 90])
                cv2.imwrite(os.path.join(model_dir, f"sample_{j}_bev.jpg"),
                           bev_frames[si], [cv2.IMWRITE_JPEG_QUALITY, 90])

        print(f"  {model_name}: saved overlay.mp4, bev.mp4, side_by_side.mp4 + {len(sample_indices)} sample pairs")

    cap.release()
    print(f"\nDone! All outputs in {output_dir}/")


if __name__ == "__main__":
    main()
