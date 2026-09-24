# Cart FSD — Cameras

The cart has four **UVC-class USB 2.0 cameras** — two front-facing (one narrow, one wide) and one wide on each side. All four are standard UVC devices, so no drivers: macOS uses AVFoundation, Linux uses V4L2, and OpenCV opens both the same way.

For the live 4-camera viewer, see [`scripts/camera_view.py`](https://github.com/ethandgoodhart/PRODUCTION/blob/main/scripts/camera_view.py).

---

## Hardware

| Slot         | Part (ELP family)                         | Sensor        | Lens                                  | Amazon       |
|--------------|-------------------------------------------|---------------|---------------------------------------|--------------|
| Front narrow | ELP-USBFHD01M-FV                          | OV2710 1080p  | **2.8–12 mm varifocal** (30–115° FOV) | [B01N8QBO2G](https://www.amazon.com/dp/B01N8QBO2G) |
| Front wide   | ELP fisheye family (USBFHD01M-BL180-ish)  | OV2710 1080p  | ~170° fisheye (~139° HFOV)            | [B01E8OC3EO](https://www.amazon.com/dp/B01E8OC3EO) |
| Left wide    | same as Front wide                         | OV2710 1080p  | ~170° fisheye                         | same listing  |
| Right wide   | same as Front wide                         | OV2710 1080p  | ~170° fisheye                         | same listing  |

All four speak MJPEG at 30 fps @ 1080p, 60 fps @ 720p, 120 fps @ 480p. YUY2 is supported but drops to ~5–6 fps at 1080p — OpenCV's default is YUY2, so `scripts/camera_view.py` forces `MJPG` on open.

---

## Bandwidth planning

Four 1080p MJPEG streams will saturate a single USB 2.0 controller. Rules of thumb:

- **640×480 MJPEG fits comfortably** on one controller — this is the default in `camera_view.py`.
- **720p usually fits** if the cameras are on separate hubs / controllers.
- **1080p on all four simultaneously** needs them spread across independent USB controllers on the Jetson (the AGX Thor has several). If a tile blanks or locks, that's the first thing to check.

---

## Logical naming

USB enumeration order is **not stable** — the OS-level index a camera gets can shift across reboots or when cables are reseated. The current approach:

1. Run `camera_view.py`. It opens cameras in the order the OS enumerated them and overlays the physical name in the top-left of each tile (`front wide`, `front narrow`, `left`, `right`).
2. If a label doesn't match what that camera is actually pointing at, either re-plug USB cables until the enumeration matches, or reorder `LABELS` in `scripts/camera_view.py` to reflect reality on this machine.

Current validated mapping on the dev laptop:

| OS index | Label          | Hardware                              |
|----------|----------------|---------------------------------------|
| 0        | `front wide`   | fisheye, ~139° HFOV                   |
| 1        | `left`         | fisheye, ~139° HFOV                   |
| 2        | `front narrow` | varifocal 2.8–12 mm, 30–115° FOV      |
| 3        | `right`        | fisheye, ~139° HFOV                   |

Once this mapping is stable per machine, we'll pin it in `cart/cameras/config.py` once the `cart/` package lands (see [`architecture.md`](./architecture.md#planned)). Longer-term, a udev rule on Linux (by USB path) or a unique-name match on macOS gives us enumeration-order-independent mapping.

---

## Usage

```bash
uv run python scripts/camera_view.py                        # auto-find 4
uv run python scripts/camera_view.py --list                 # scan + print
uv run python scripts/camera_view.py --indices 0 1 2 3      # pin indices
uv run python scripts/camera_view.py --width 320 --height 240   # low-bw fallback
uv run python scripts/camera_view.py --indices 2 --no-fourcc    # isolate + let OpenCV pick format
```

Controls while the window is focused:

| Key     | Action                                                        |
|---------|---------------------------------------------------------------|
| `s`     | Save the grid to `./camera_snapshots/cams_<timestamp>.png`    |
| `q` / Esc | Quit                                                        |

The script forces AVFoundation on macOS and V4L2 on Linux explicitly — OpenCV's default backend pick is inconsistent.

---

## Known issues

### `front narrow` (idx 2) shows one frame, then "no frame"

Bench session, four cameras on one USB 2.0 controller:

- `front wide`, `left`, and `right` stream fine.
- `front narrow` (idx 2) produces a frame or two on open, then `cap.read()` starts returning `(False, None)` and the tile flips to the "no frame" placeholder.

Hypotheses, in order of likelihood:

1. **USB 2.0 bandwidth contention.** Four 640×480 MJPEG streams on one controller is close to the limit. The other three cameras grab their slots first and starve the narrow one. Fix: spread across USB controllers (or use a powered USB 3.0 hub), which is already a TODO below.
2. **MJPG negotiation mismatch.** The narrow camera is the varifocal unit; it may enumerate differently and not like being forced into `MJPG`. Try `--no-fourcc` to let OpenCV pick.
3. **Cable / power.** A long / thin USB cable or an underpowered hub will pass the `VideoCapture` open but fail once the stream actually starts. Swap the cable into a port that's known-good for another camera.

Diagnostic order:

```bash
uv run python scripts/camera_view.py --indices 2                # narrow alone, default
uv run python scripts/camera_view.py --indices 2 --no-fourcc    # narrow alone, YUY2/whatever
uv run python scripts/camera_view.py --indices 2 --width 320 --height 240
```

If any of those hold a steady frame, the issue is bandwidth/format, not the camera. If none do, swap the USB cable and try again before suspecting the sensor.

---

## Open TODOs

- [x] Label each physical camera (name + FOV → OS index), commit the mapping.
- [ ] Set the varifocal zoom on the front-narrow camera to a fixed, documented FOV and tape it.
- [ ] udev rule (Linux) / named-device match (macOS) to make the mapping survive reboots.
- [ ] `cart.cameras.CameraRig` class that opens cameras by logical slot name, not OS index.
- [ ] Per-camera intrinsics calibration (especially for the fisheyes) before anything that cares about geometry is built on top.
- [ ] Pick + wire in a powered USB 3.0 hub so all four cameras can run at 720p+ without bandwidth contention (see Known issues).
