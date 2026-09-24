# Cart FSD — GPS

The cart's GPS is a low-cost u-blox NEO-6M module wired to the Arduino Mega's hardware UART. The Mega forwards NMEA sentences up to the Jetson over USB; for now we're running the **validation-only** passthrough sketch that just forwards raw NMEA to the host computer for inspection.

See [`steering.md`](./steering.md) for the cart power map and [`estop.md`](./estop.md) for the e-stop subsystems.

---

## Hardware

| Component      | Part                               | Notes                                    |
|----------------|------------------------------------|------------------------------------------|
| GPS module     | Goouuu Tech GT-U7                  | u-blox NEO-6M chipset, UVC-simple UART   |
| Protocol       | NMEA 0183 over UART                | 9600 baud default                        |
| Host MCU       | Arduino Mega 2560                  | Uses hardware UART #1 (`Serial1`)        |
| Antenna        | Included patch antenna             | Must face up toward the sky              |

Amazon listing (reference): https://www.amazon.com/Navigation-Positioning-Microcontroller-Compatible-Sensitivity/dp/B084MK8BS2

---

## Wiring

> **Validated:** NMEA sentences parse cleanly at ~6 lines/s indoors, so the wiring below is confirmed correct. Fix acquisition (needs sky view) is still an open TODO.

| Arduino Mega pin | GPS module pin | Wire color | Direction                          |
|------------------|----------------|------------|------------------------------------|
| Pin 18 (TX1)     | RXD            | Blue       | Mega → GPS (for UBX config later)  |
| Pin 19 (RX1)     | TXD            | Green      | GPS → Mega (NMEA sentences)        |
| 5 V              | VCC            | —          | Power                              |
| GND              | GND            | —          | Ground                             |

TX always crosses to RX on the other side. The wire colors refer to which Arduino pin the wire is on, not the GPS side.

---

## LEDs on the module

The GT-U7 has a single red LED with two distinct states — worth knowing before running any code:

| LED state      | Meaning                                   |
|----------------|-------------------------------------------|
| Solid on       | Powered but no fix yet (or dead antenna)  |
| Blinking (~1 Hz)| Has a satellite fix                      |
| Off            | Not powered                               |

---

## Validation sketch & script

The current firmware is a **pure passthrough** — the Mega forwards bytes in both directions between `Serial1` (GPS) and `Serial` (USB). We're not parsing NMEA on the Mega yet; the host handles that. This is intentionally minimal while we validate the chain end-to-end.

Files:

| File                                               | Purpose                                               |
|----------------------------------------------------|-------------------------------------------------------|
| `sketches/sensor_validation/sensor_validation.ino` | Arduino passthrough sketch (GPS ↔ USB).               |
| `scripts/sensor_test.py`                           | Host-side NMEA parser + fix reporter via `pynmea2`.   |

### Usage

1. Upload `sketches/sensor_validation/sensor_validation.ino` to the Mega (Arduino IDE, board = `Arduino Mega 2560`).
2. Close the IDE's Serial Monitor (or anything else holding the port).
3. From the project root:
   ```bash
   uv run python scripts/sensor_test.py
   ```

You should see something like:

```
[INFO]    Cart FSD GPS validation sketch starting...
[INFO]    Forwarding GPS (Serial1 @ 9600) -> USB (Serial @ 115200).
[GPS/GGA] NO FIX     sats= 0 lat=  0.000000 lon=  0.000000 alt=0.0m
[GPS/GGA] NO FIX     sats= 2 lat=  0.000000 lon=  0.000000 alt=0.0m
--- 5s | GPS: 29 valid @ 5.8/s ---
```

Once the antenna has sky view, the `NO FIX` transitions to `GPS FIX` and `lat` / `lon` / `alt` populate. At that point the red LED on the module also switches from solid to blinking.

### Useful flags

```bash
uv run python scripts/sensor_test.py --list                      # list serial ports
uv run python scripts/sensor_test.py --port /dev/cu.usbmodem1401 # force specific port
```

The port picker auto-selects the Arduino's VID (`0x2341`) and explicitly **refuses to pick the ODrive S1** (VID `0x1209`), so plugging both in at once is safe.

---

## NMEA sentences the GT-U7 emits

Observed on the cart during validation:

| Sentence  | Contents                                            |
|-----------|-----------------------------------------------------|
| `$GPGGA`  | Time, position, fix quality, #sats, altitude — the main one we care about |
| `$GPGSA`  | Active satellites + DOP                             |
| `$GPGSV`  | All satellites in view (can span multiple sentences)|
| `$GPGLL`  | Latitude / longitude only                           |
| `$GPRMC`  | Recommended minimum (time, speed, course, status)   |
| `$GPVTG`  | Course and speed over ground                        |

The validation script currently only pretty-prints `$GPGGA`. All sentences still count toward the "valid" total in the stats line.

---

## Cold-start behavior

A NEO-6M module with no prior almanac / ephemeris data:

- **Cold start** (first power-on, unknown location): 30 s – a few minutes to first fix.
- **Warm start**: typically 5–15 s.
- **Hot start** (recent fix, same location): often < 2 s.

If you're indoors, you'll almost certainly stay at `NO FIX sats=0` indefinitely. Either put the antenna on a windowsill with open sky or take the Mega + GPS outside on a battery pack.

---

## Production integration

The current passthrough is **disposable** — for validation only. Eventually:

- The Mega will parse NMEA locally on `Serial1` rather than shuffling raw sentences up to the Jetson.
- It will forward structured position / velocity / fix-quality fields to the Jetson over the cart's real MCU↔Jetson protocol (not yet defined).
- UBX configuration (update rate, enabled sentence types, baud) will live in a setup routine that runs once at cart startup and re-runs if the module loses config.

The passthrough sketch kept host → GPS forwarding so that UBX commands (via `u-center` or a Python UBX library) can be sent through the Mega without unplugging anything.

---

## Open TODOs

- [ ] **Confirm satellite fix outside.** Wiring is validated but a clean `$GPGGA GPS FIX sats=N lat=... lon=...` has not been captured yet. This is the last step for full end-to-end GPS validation.
- [ ] Lock the GPS update rate (default 1 Hz is fine for now, but document what the Mega will reconfigure it to).
- [ ] Decide if we want SBAS/WAAS enabled — improves accuracy by 2–3× when in range.
- [ ] Define the structured GPS message the Mega will send to the Jetson (CSV? binary? ROS topic?).
- [ ] Write production NMEA-parser firmware and move the passthrough sketch out of the main flow.
- [ ] Decide antenna mounting location on the cart — roof-line with unobstructed sky view is ideal.
