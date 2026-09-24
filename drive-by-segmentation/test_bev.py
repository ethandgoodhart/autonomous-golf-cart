import numpy as np
import cv2
import json
import sys
sys.path.insert(0, ".")
from eval_segmentation import create_bev, create_overlay, CITYSCAPES_COLORS

with open("camera_calibration.json") as f:
    calib = json.load(f)

frame = cv2.imread("/tmp/test_frame.jpg")
h, w = frame.shape[:2]

# Manual segmentation: road in lower portion, vegetation on sides, sky on top
seg = np.full((h, w), 2, dtype=np.uint8)  # building
seg[:int(h*0.35), :] = 10  # sky top
# Road: center-bottom area
for row in range(int(h*0.45), h):
    t = (row - h*0.45) / (h*0.55)
    road_left = int(w * (0.15 - t * 0.15))
    road_right = int(w * (0.85 + t * 0.15))
    seg[row, road_left:road_right] = 0  # road
# Vegetation strips on sides
seg[int(h*0.3):int(h*0.55), :int(w*0.35)] = 8
seg[int(h*0.3):int(h*0.55), int(w*0.65):] = 8
# Sidewalk edges
for row in range(int(h*0.5), h):
    t = (row - h*0.5) / (h*0.5)
    seg[row, max(0, int(w*(0.12-t*0.12))):int(w*(0.18-t*0.08))] = 1
    seg[row, int(w*(0.82+t*0.08)):min(w, int(w*(0.88+t*0.12)))] = 1

bev_color, _ = create_bev(seg, calib)

# Create overlay
frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
overlay = create_overlay(frame_rgb, seg, alpha=0.45)

# Side by side
overlay_bgr = cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR)
bev_bgr = cv2.cvtColor(bev_color, cv2.COLOR_RGB2BGR)
bev_resized = cv2.resize(bev_bgr, (480, 480))
canvas = np.zeros((480, 640 + 480, 3), dtype=np.uint8)
canvas[:, :640] = overlay_bgr
canvas[:, 640:] = bev_resized
cv2.imwrite("/tmp/bev_v2.jpg", canvas)
cv2.imwrite("/tmp/bev_v2_only.jpg", bev_bgr)
print("Saved /tmp/bev_v2.jpg and /tmp/bev_v2_only.jpg")
