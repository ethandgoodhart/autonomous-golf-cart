#!/usr/bin/env python3
"""Live BEV lane tracker: NTRIP corrections + serial NMEA -> WebSocket -> Leaflet map."""

import asyncio
import glob
import json
import base64
import socket
import time
import datetime
import threading
import os
import http.server
import functools
import websockets

NTRIP_HOST = "rtk.rtkdata.com"
NTRIP_PORT = 2101
MOUNTPOINT = "AUTO"
USERNAME = os.environ.get("NTRIP_RTKDATA_USER", "")
PASSWORD = os.environ.get("NTRIP_RTKDATA_PASS", "")

SERIAL_BAUD = 115200
FALLBACK_GGA = "$GPGGA,120000.00,3743.8000,N,12227.0000,W,1,12,0.8,30.0,M,-30.0,M,,*5E"
NAV_RATE_HZ = 20

WS_PORT = 8765
HTTP_PORT = 8080

points = []
clients = set()
latest_fix = {}


def ubx_checksum(payload):
    ck_a, ck_b = 0, 0
    for b in payload:
        ck_a = (ck_a + b) & 0xFF
        ck_b = (ck_b + ck_a) & 0xFF
    return bytes([ck_a, ck_b])


def ubx_cfg_valset(keys_values):
    """Build a UBX-CFG-VALSET message. keys_values is list of (key_id, value_bytes)."""
    payload = b'\x00\x01\x00\x00'  # version=0, layer=RAM, reserved
    for key_id, val in keys_values:
        payload += key_id.to_bytes(4, 'little') + val
    cls_id = b'\x06\x8a'
    length = len(payload).to_bytes(2, 'little')
    msg = cls_id + length + payload
    return b'\xb5\x62' + msg + ubx_checksum(msg)


def configure_receiver(ser):
    """Set nav rate to NAV_RATE_HZ and baud to 115200 via UBX commands."""
    import serial as pyserial

    meas_period_ms = 1000 // NAV_RATE_HZ

    # First configure at default 38400 baud
    try:
        ser.baudrate = 38400
        time.sleep(0.1)

        # Set UART1 baud to 115200: CFG-UART1-BAUDRATE = 0x40520001 (U4)
        baud_msg = ubx_cfg_valset([
            (0x40520001, (115200).to_bytes(4, 'little')),
        ])
        ser.write(baud_msg)
        time.sleep(0.5)

        # Switch local serial to 115200
        ser.baudrate = 115200
        time.sleep(0.1)

    except Exception as e:
        print(f"[CFG] Baud switch note: {e}, trying 115200 directly")
        ser.baudrate = 115200
        time.sleep(0.1)

    # Set measurement rate and disable unnecessary NMEA messages
    cfg_msg = ubx_cfg_valset([
        # CFG-RATE-MEAS = 0x30210001 (U2) — measurement period in ms
        (0x30210001, meas_period_ms.to_bytes(2, 'little')),
        # CFG-RATE-NAV = 0x30210002 (U2) — one nav solution per measurement
        (0x30210002, (1).to_bytes(2, 'little')),
        # Disable NMEA GLL on UART1: CFG-MSGOUT-NMEA_ID_GLL_UART1 = 0x209100ca (U1)
        (0x209100ca, b'\x00'),
        # Disable NMEA GSA on UART1: CFG-MSGOUT-NMEA_ID_GSA_UART1 = 0x209100bf (U1)
        (0x209100bf, b'\x00'),
        # Disable NMEA GSV on UART1: CFG-MSGOUT-NMEA_ID_GSV_UART1 = 0x209100c4 (U1)
        (0x209100c4, b'\x00'),
        # Disable NMEA RMC on UART1: CFG-MSGOUT-NMEA_ID_RMC_UART1 = 0x209100ab (U1)
        (0x209100ab, b'\x00'),
        # Disable NMEA VTG on UART1: CFG-MSGOUT-NMEA_ID_VTG_UART1 = 0x209100b0 (U1)
        (0x209100b0, b'\x00'),
        # Keep GGA on UART1 at every epoch: CFG-MSGOUT-NMEA_ID_GGA_UART1 = 0x209100bb (U1)
        (0x209100bb, b'\x01'),
    ])
    ser.write(cfg_msg)
    time.sleep(0.3)

    # Flush any pending data
    if ser.in_waiting:
        ser.read(ser.in_waiting)

    print(f"[CFG] Configured: {NAV_RATE_HZ} Hz nav rate, 115200 baud, GGA-only output")


def find_serial_port():
    matches = glob.glob("/dev/cu.usbmodem*")
    if matches:
        return matches[0]
    return None


def parse_gga(line):
    parts = line.split(",")
    if len(parts) < 10 or not parts[2]:
        return None
    try:
        lat_raw = float(parts[2])
        lat = int(lat_raw / 100) + (lat_raw % 100) / 60
        if parts[3] == "S":
            lat = -lat
        lon_raw = float(parts[4])
        lon = int(lon_raw / 100) + (lon_raw % 100) / 60
        if parts[5] == "W":
            lon = -lon
        fix_names = {"0": "No fix", "1": "GPS", "2": "DGPS", "4": "RTK Fix", "5": "RTK Float"}

        now = time.time()
        iso_str = datetime.datetime.fromtimestamp(now).isoformat(timespec="milliseconds")

        utc_time_str = ""
        if parts[1]:
            t = parts[1]
            utc_time_str = f"{t[0:2]}:{t[2:4]}:{t[4:]}"

        return {
            "lat": round(lat, 8),
            "lon": round(lon, 8),
            "fix": fix_names.get(parts[6], parts[6]),
            "fix_code": int(parts[6]),
            "sats": int(parts[7]),
            "hdop": float(parts[8]),
            "alt": float(parts[9]) if parts[9] else 0,
            "ts": now,
            "datetime": iso_str,
            "utc_time": utc_time_str,
        }
    except (ValueError, IndexError):
        return None


def ntrip_thread(ser):
    """Connect to NTRIP and forward corrections to serial."""
    while True:
        try:
            print("[NTRIP] Connecting...")
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(10)
            sock.connect((NTRIP_HOST, NTRIP_PORT))

            creds = base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()
            req = (
                f"GET /{MOUNTPOINT} HTTP/1.1\r\n"
                f"Host: {NTRIP_HOST}\r\n"
                f"Ntrip-Version: Ntrip/2.0\r\n"
                f"User-Agent: NTRIP PythonClient/1.0\r\n"
                f"Authorization: Basic {creds}\r\n"
                f"Accept: */*\r\n\r\n"
            )
            sock.sendall(req.encode())

            # Send GGA
            try:
                if ser.in_waiting:
                    data = ser.read(ser.in_waiting)
                    lines = data.decode("ascii", errors="ignore").split("\n")
                    gga = None
                    for l in reversed(lines):
                        if ("$GNGGA" in l or "$GPGGA" in l) and ",,,," not in l:
                            gga = l.strip()
                            break
                    if gga:
                        sock.sendall((gga + "\r\n").encode())
                    else:
                        sock.sendall((FALLBACK_GGA + "\r\n").encode())
                else:
                    sock.sendall((FALLBACK_GGA + "\r\n").encode())
            except Exception:
                sock.sendall((FALLBACK_GGA + "\r\n").encode())

            resp = b""
            while b"\r\n\r\n" not in resp:
                resp += sock.recv(1024)
            header, remainder = resp.split(b"\r\n\r\n", 1)
            print(f"[NTRIP] {header.decode().splitlines()[0]}")

            if b"200" not in header:
                print("[NTRIP] Auth failed, retrying in 5s...")
                sock.close()
                time.sleep(5)
                continue

            if remainder:
                try:
                    ser.write(remainder)
                except Exception:
                    pass

            sock.settimeout(5)
            last_gga_time = time.time()
            while True:
                try:
                    data = sock.recv(4096)
                    if not data:
                        break
                    try:
                        ser.write(data)
                    except Exception as e:
                        print(f"[NTRIP] Serial write error: {e}")
                        break

                    if time.time() - last_gga_time > 10:
                        last_gga_time = time.time()
                        try:
                            if ser.in_waiting:
                                raw = ser.read(ser.in_waiting)
                                lines = raw.decode("ascii", errors="ignore").split("\n")
                                for l in reversed(lines):
                                    if "$GNGGA" in l or "$GPGGA" in l:
                                        sock.sendall((l.strip() + "\r\n").encode())
                                        break
                        except Exception:
                            pass
                except socket.timeout:
                    continue

        except Exception as e:
            print(f"[NTRIP] Error: {e}, retrying in 3s...")
        finally:
            try:
                sock.close()
            except Exception:
                pass
        time.sleep(3)


def serial_reader_thread(ser, loop):
    """Read NMEA from serial and broadcast parsed positions."""
    global latest_fix
    buffer = ""
    while True:
        try:
            if ser.in_waiting:
                raw = ser.read(ser.in_waiting)
                buffer += raw.decode("ascii", errors="ignore")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if line.startswith("$GNGGA") or line.startswith("$GPGGA"):
                        fix = parse_gga(line)
                        if fix:
                            latest_fix = fix
                            points.append(fix)
                            msg = json.dumps({"type": "position", "data": fix})
                            asyncio.run_coroutine_threadsafe(broadcast(msg), loop)
            else:
                time.sleep(0.05)
        except Exception as e:
            print(f"[Serial] Error: {e}")
            time.sleep(1)
            # Try to reconnect
            port = find_serial_port()
            if port:
                try:
                    import serial as pyserial
                    ser.close()
                    new_ser = pyserial.Serial(port, SERIAL_BAUD, timeout=1)
                    ser.__dict__.update(new_ser.__dict__)
                    print(f"[Serial] Reconnected on {port}")
                except Exception:
                    pass


async def broadcast(msg):
    if clients:
        await asyncio.gather(*[c.send(msg) for c in clients], return_exceptions=True)


async def ws_handler(websocket):
    clients.add(websocket)
    print(f"[WS] Client connected ({len(clients)} total)")
    try:
        # Send existing points
        if points:
            await websocket.send(json.dumps({"type": "history", "data": points}))
        async for message in websocket:
            msg = json.loads(message)
            if msg.get("type") == "save":
                filename = msg.get("filename", "lane_points.json")
                filepath = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", filename)
                with open(filepath, "w") as f:
                    json.dump(points, f, indent=2)
                await websocket.send(json.dumps({"type": "saved", "path": filepath, "count": len(points)}))
                print(f"[Save] {len(points)} points saved to {filepath}")
            elif msg.get("type") == "clear":
                points.clear()
                await broadcast(json.dumps({"type": "cleared"}))
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        clients.discard(websocket)
        print(f"[WS] Client disconnected ({len(clients)} total)")


def run_http_server():
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler,
        directory=os.path.dirname(os.path.abspath(__file__))
    )
    httpd = http.server.HTTPServer(("", HTTP_PORT), handler)
    print(f"[HTTP] Serving on http://localhost:{HTTP_PORT}/lane_tracker.html")
    httpd.serve_forever()


def simulate_reader_thread(loop):
    """Generate fake GPS data for testing without hardware."""
    import math
    global latest_fix
    lat, lon = 37.4265, -122.1644
    step = 0
    print("[SIM] Simulating GPS data (no hardware connected)")
    while True:
        step += 1
        lat_jitter = math.sin(step * 0.05) * 0.00002
        lon_jitter = math.cos(step * 0.07) * 0.00002
        now = time.time()
        fix = {
            "lat": round(lat + lat_jitter + step * 0.000001, 8),
            "lon": round(lon + lon_jitter, 8),
            "fix": "RTK Fix",
            "fix_code": 4,
            "sats": 14,
            "hdop": 0.6,
            "alt": 23.0,
            "ts": now,
            "datetime": datetime.datetime.fromtimestamp(now).isoformat(timespec="milliseconds"),
            "utc_time": datetime.datetime.utcfromtimestamp(now).strftime("%H:%M:%S.%f")[:12],
        }
        latest_fix = fix
        points.append(fix)
        msg = json.dumps({"type": "position", "data": fix})
        asyncio.run_coroutine_threadsafe(broadcast(msg), loop)
        time.sleep(1)


async def main():
    import sys
    simulate = "--simulate" in sys.argv or "--sim" in sys.argv

    loop = asyncio.get_event_loop()

    # Start HTTP server
    http_thread = threading.Thread(target=run_http_server, daemon=True)
    http_thread.start()

    if simulate:
        reader = threading.Thread(target=simulate_reader_thread, args=(loop,), daemon=True)
        reader.start()
    else:
        import serial as pyserial

        port = find_serial_port()
        if not port:
            print("No USB serial device found. Plug in the ZED-F9R or use --simulate.")
            return

        print(f"[Serial] Opening {port}...")
        ser = pyserial.Serial(port, 38400, timeout=1)
        time.sleep(0.5)

        configure_receiver(ser)

        # Start NTRIP
        ntrip = threading.Thread(target=ntrip_thread, args=(ser,), daemon=True)
        ntrip.start()

        # Start serial reader
        reader = threading.Thread(target=serial_reader_thread, args=(ser, loop), daemon=True)
        reader.start()

    # Start WebSocket server
    print(f"[WS] WebSocket on ws://localhost:{WS_PORT}")
    async with websockets.serve(ws_handler, "", WS_PORT):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
