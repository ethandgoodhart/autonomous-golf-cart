/*
 * Cart FSD Sensor Validation Sketch — GPS only
 *
 * Forwards GT-U7 GPS (Serial1 @ 9600) to USB Serial @ 115200 so Python can
 * parse NMEA sentences. IMU support is intentionally removed until the
 * replacement BerryIMU arrives.
 *
 * Wiring:
 *   GPS VCC -> Mega 5V
 *   GPS GND -> Mega GND
 *   GPS RXD -> Mega pin 18 (TX1)   [blue wire]
 *   GPS TXD -> Mega pin 19 (RX1)   [green wire]
 *
 * Output over USB serial:
 *   $GP... / $GN...    (raw NMEA lines from GPS)
 *   INFO,<text>        (sketch status messages)
 */

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600);
  delay(200);
  Serial.println("INFO,Cart FSD GPS validation sketch starting...");
  Serial.println("INFO,Forwarding GPS (Serial1 @ 9600) -> USB (Serial @ 115200).");
}

void loop() {
  // Bidirectional passthrough. Host -> GPS is kept so we can send UBX
  // configuration commands to the u-blox later if needed (e.g. u-center).
  while (Serial1.available()) {
    Serial.write(Serial1.read());
  }
  while (Serial.available()) {
    Serial1.write(Serial.read());
  }
}
