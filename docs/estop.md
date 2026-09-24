# Cart FSD — E-Stop Subsystems

The cart has **two independent e-stops**. They exist at different layers and are not interchangeable.

| Layer     | Mechanism                               | What it kills                    | Recovery                 |
|-----------|-----------------------------------------|----------------------------------|--------------------------|
| Hardware  | Physical button cuts 48 V from battery  | Everything (ODrive, actuators, Jetson) | Reset button, re-power  |
| Software  | NC button → Arduino Mega pin 2 (INT0)   | Whatever the firmware/Jetson choose to react to | Release button, clear state |

The **hardware e-stop is the real emergency stop.** The software e-stop is a passenger-accessible "please stop gracefully" signal.

---

## Hardware E-stop

A mushroom-head e-stop switch in series with the main 48 V battery feed. When pressed, the entire cart loses power — steering ODrive, both linear actuators, the Arduino Mega, and the Jetson. Nothing on the cart is actively held after that, including steering.

This is the control of last resort. It is physical, independent of any software, and always available.

---

## Software E-stop

A normally-closed (NC) pushbutton wired into the Arduino Mega 2560. The Arduino monitors it via a hardware interrupt on pin 2 (INT0). The intended use is a passenger-reachable button that triggers a *graceful* stop of the cart — brake forward, gas retract, steering disarmed — without yanking power from everything.

### Wiring

| Pin / Terminal | Connects to                 |
|----------------|-----------------------------|
| Arduino pin 2  | One NC terminal of e-stop   |
| Arduino GND    | Other NC terminal of e-stop |

Pin 2 is configured as `INPUT_PULLUP`. With the NC contacts:

| Button state         | Contacts | Pin reads | Meaning           |
|----------------------|----------|-----------|-------------------|
| Released (normal)    | Closed   | `LOW`     | Normal operation  |
| Pressed              | Open     | `HIGH`    | E-stop requested  |
| Broken wire / unplugged | —     | `HIGH`    | E-stop (fail-safe)|

Using NC contacts means a cut wire, bad crimp, or unplugged connector all read as "e-stop pressed." This is the correct fail-safe direction.

### Behavior the firmware will eventually drive

**Not yet defined.** Open TODOs:

- [ ] On software-e-stop, what does the Arduino do with the gas/brake actuators? (Likely: gas → retract, brake → forward, both at a chosen PWM.)
- [ ] How does the Arduino signal the Jetson to put steering in `IDLE`? (Serial message, GPIO line, ROS topic?)
- [ ] What does "clear / reset" look like from the software e-stop state? (Release button + explicit user confirmation?)

### Arduino test sketch

This is the current test firmware — it doesn't actuate anything, it just prints state changes and a 1 Hz heartbeat so you can confirm the button, ISR, and debounce all work.

```cpp
/*
 * E-Stop Button State Test
 *
 * Hardware:
 *   - Arduino Mega 2560
 *   - NC (normally closed) E-stop button
 *   - Pin 2  -> one NC terminal
 *   - GND    -> other NC terminal
 *
 * Logic (with INPUT_PULLUP + NC contacts):
 *   Button released (contacts CLOSED) -> pin pulled to GND -> reads LOW  -> NORMAL
 *   Button pressed  (contacts OPEN)   -> pin floats to 5V  -> reads HIGH -> E-STOP
 *   Broken wire / loose connector also reads HIGH -> fail-safe
 */

const uint8_t ESTOP_PIN = 2;

// Interrupt flag — volatile because it's modified in an ISR
volatile bool estopTriggered = false;
volatile unsigned long lastInterruptMs = 0;
const unsigned long DEBOUNCE_MS = 50;

// State tracking for loop-based edge detection
bool lastState = false;  // false = normal, true = estop

void estopISR() {
  unsigned long now = millis();
  if (now - lastInterruptMs > DEBOUNCE_MS) {
    estopTriggered = true;
    lastInterruptMs = now;
  }
}

void setup() {
  Serial.begin(115200);
  while (!Serial) { ; }

  pinMode(ESTOP_PIN, INPUT_PULLUP);

  // INT0 on pin 2, fires on rising edge (button press opens NC -> pin goes HIGH)
  attachInterrupt(digitalPinToInterrupt(ESTOP_PIN), estopISR, RISING);

  Serial.println(F("=== E-Stop Button Test ==="));
  Serial.print(F("Monitoring pin "));
  Serial.println(ESTOP_PIN);
  Serial.println(F("LOW  = normal (button released, NC closed)"));
  Serial.println(F("HIGH = E-STOP (button pressed or wire broken)"));
  Serial.println();

  // Print initial state
  bool initial = digitalRead(ESTOP_PIN);
  Serial.print(F("Initial state: "));
  Serial.println(initial ? F("E-STOP (HIGH)") : F("NORMAL (LOW)"));
  Serial.println();
}

void loop() {
  bool currentState = digitalRead(ESTOP_PIN);  // HIGH = estop, LOW = normal

  // Print on state change (edge-triggered)
  if (currentState != lastState) {
    Serial.print(F("[t="));
    Serial.print(millis());
    Serial.print(F("ms] State changed: "));
    Serial.println(currentState ? F("E-STOP PRESSED") : F("released / reset"));
    lastState = currentState;
  }

  // Handle interrupt-triggered e-stop
  if (estopTriggered) {
    noInterrupts();
    estopTriggered = false;
    interrupts();
    Serial.println(F(">>> ISR fired: E-STOP detected (rising edge) <<<"));
  }

  // Periodic heartbeat so you can see the loop is alive
  static unsigned long lastPrint = 0;
  if (millis() - lastPrint > 1000) {
    Serial.print(F("[heartbeat] pin "));
    Serial.print(ESTOP_PIN);
    Serial.print(F(" = "));
    Serial.print(currentState ? F("HIGH") : F("LOW"));
    Serial.print(F("  ("));
    Serial.print(currentState ? F("E-STOP") : F("normal"));
    Serial.println(F(")"));
    lastPrint = millis();
  }

  delay(10);
}
```

### Why the ISR *and* the polled edge check?

Both are intentional:

- The **ISR** (`RISING` edge on INT0) catches the press even if `loop()` is blocked for longer than a serial print or a `delay()`. Debounced at 50 ms.
- The **polled edge check** in `loop()` prints *state changes* in both directions (pressed **and** released), which the rising-edge-only ISR won't see.

In the real firmware, the ISR flag is what matters — it's the thing that gates motion. The polled print is just for observability during bench testing.
