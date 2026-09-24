# hardware

Designs for the physical cart: mounts, enclosures, wiring, and boards.

| Folder | Put here |
|--------|----------|
| `mechanical/` | CAD (STEP / STL / Fusion / Onshape exports): steering-motor mount, belt drive, pedal actuator brackets, camera + GPS mounts, compute enclosure. |
| `electrical/` | Wiring diagrams, power distribution (48 V → 12 V / 5 V), e-stop loop, harness pinouts. |
| `pcb/` | KiCad projects, Gerbers, BOMs for custom boards. |
| `sensors/` | Sensor configs and calibration. `sensors/calibration/` holds camera intrinsics, extrinsics, and the ChArUco board used to produce them. |

## Bill of materials (current build)

| Subsystem | Part |
|-----------|------|
| Compute | NVIDIA Jetson AGX Thor |
| Steering | ODrive S1 + M8325s motor, 3:1 HTD 5M belt to the steering column |
| Pedals | 2× linear actuators with pot feedback, 2× BTS7960 H-bridges, Arduino Mega 2560 |
| GNSS | u-blox ZED-F9x RTK receiver + NTRIP corrections |
| Cameras | 4× USB cameras incl. ELP-USBFHD04H-L170 (170° fisheye) |
| Safety | Hardware e-stop loop, firmware heartbeat watchdog |
| Power | 48 V cart pack → dedicated 12 V and 5 V buck rails |

Subsystem write-ups: [steering](../docs/steering.md) ·
[pedal actuators](../docs/linear_actuators.md) · [e-stop](../docs/estop.md) ·
[GPS](../docs/gps.md) · [cameras](../docs/cameras.md)

When adding a design, include a short README in its folder with a photo or
render, the part it mounts to, material / print settings, and fasteners.
