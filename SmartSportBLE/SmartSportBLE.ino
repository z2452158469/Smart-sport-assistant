// ESP32 DevKit/WROOM + ST7735 128x160 + MPU6050 + MAX30102
#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <MAX30105.h>  // SparkFun library also supports MAX30102
#include <heartRate.h>
#include <math.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

constexpr int SDA_PIN = 21, SCL_PIN = 22;
constexpr int TFT_SCLK = 2, TFT_MOSI = 4;
constexpr int TFT_CS = 14, TFT_DC = 13, TFT_RST = 12;
constexpr int BUTTON_PIN = 36; // Button to GND; external 10k pull-up to 3V3 required
constexpr uint32_t FINGER_IR_THRESHOLD = 50000; // Adjust for your module
constexpr float STANDARD_GRAVITY = 9.80665f;
// Preliminary Z calibration from stationary readings +7.4 / -12.7 m/s^2.
constexpr float ACCEL_Z_OFFSET = -2.65f; // m/s^2
constexpr float ACCEL_Z_SCALE = STANDARD_GRAVITY / 10.05f;
constexpr uint8_t RATE_COUNT = 4;

Adafruit_ST7735 tft(TFT_CS, TFT_DC, TFT_RST);
Adafruit_MPU6050 mpu;
MAX30105 pulse;
bool mpuOK = false, pulseOK = false, fingerPresent = false, useG = false;
float ax = 0, ay = 0, az = 0, bpm = 0;
float gx = 0, gy = 0, gz = 0, sensorTemperature = 0;
constexpr char BLE_SERVICE_UUID[] = "5a4f0001-9b7d-4f3a-8c2e-6d1b0a9f3456";
constexpr char BLE_DATA_UUID[] = "5a4f0002-9b7d-4f3a-8c2e-6d1b0a9f3456";
BLECharacteristic *dataCharacteristic = nullptr;
volatile bool bleConnected = false;
volatile bool restartAdvertising = false;
uint16_t telemetrySequence = 0;
uint32_t lastTelemetry = 0;
bool sendMotionNext = false;
float rates[RATE_COUNT] = {};
uint8_t rateIndex = 0, rateUsed = 0;
uint32_t ir = 0, lastBeat = 0, fingerSince = 0;
uint32_t lastSample = 0, lastAccel = 0, lastScreen = 0;
bool haveBeat = false;
uint32_t imuSequence = 0, lastActivity = 0;
char activityName[20] = "UNKNOWN";
float activityConfidence = 0;

void receiveActivity() {
  static char line[80];
  static uint8_t used = 0;
  static bool overflow = false;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[used] = '\0';
      char name[20]; float confidence;
      if (!overflow && sscanf(line, "ACT,%19[^,],%f", name, &confidence) == 2
          && isfinite(confidence) && confidence >= 0 && confidence <= 1) {
        if (!strcmp(name,"JUMPING_JACK") || !strcmp(name,"SQUAT") || !strcmp(name,"RUNNING")
            || !strcmp(name,"IDLE") || !strcmp(name,"OTHER") || !strcmp(name,"UNKNOWN")) {
          strncpy(activityName, name, sizeof(activityName)-1);
          activityConfidence = confidence; lastActivity = millis();
        }
      }
      used = 0; overflow = false;
    } else if (used < sizeof(line)-1 && !overflow) line[used++] = c;
    else overflow = true;
  }
}

void sendSerialSample(uint32_t timestamp) {
  bool fresh = pulseOK && timestamp-lastSample <= 1000;
  uint8_t flags = (mpuOK?1:0)|(pulseOK?2:0)|(fingerPresent&&fresh?4:0)
                |(bpm>0&&fresh?8:0)|(useG?16:0)|(fresh?32:0);
  Serial.printf("IMU,%lu,%lu,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.2f,%.1f,%lu,%u,2\n",
    (unsigned long)imuSequence++, (unsigned long)timestamp,
    ax,ay,az,gx,gy,gz,sensorTemperature,bpm,(unsigned long)ir,flags);
}

class SportBLECallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { bleConnected = true; }
  void onDisconnect(BLEServer *) override {
    bleConnected = false;
    restartAdvertising = true;
  }
};

void setupBluetooth() {
  BLEDevice::init("SmartSport-ESP32");
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new SportBLECallbacks());
  BLEService *service = server->createService(BLE_SERVICE_UUID);
  dataCharacteristic = service->createCharacteristic(
      BLE_DATA_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  dataCharacteristic->addDescriptor(new BLE2902());
  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
  Serial.println("BLE ready: SmartSport-ESP32");
}

void put16(uint8_t *packet, int offset, uint16_t value) {
  packet[offset] = value & 0xff;
  packet[offset + 1] = (value >> 8) & 0xff;
}

void put32(uint8_t *packet, int offset, uint32_t value) {
  for (int i = 0; i < 4; ++i) packet[offset + i] = (value >> (8 * i)) & 0xff;
}

void sendBluetooth() {
  if (restartAdvertising) {
    restartAdvertising = false;
    BLEDevice::startAdvertising();
  }
  uint32_t now = millis();
  if (!bleConnected || now - lastTelemetry < 100) return;
  lastTelemetry = now;
  // Two alternating 20-byte packets; compatible with the default BLE MTU.
  uint8_t packet[20] = {};
  packet[0] = 1; // Protocol version
  packet[1] = sendMotionNext ? 2 : 1;
  bool pulseFresh = pulseOK && now - lastSample <= 1000;
  packet[2] = (mpuOK ? 1 : 0) | (pulseOK ? 2 : 0)
            | (fingerPresent && pulseFresh ? 4 : 0)
            | (bpm > 0 && pulseFresh ? 8 : 0)
            | (useG ? 16 : 0) | (pulseFresh ? 32 : 0);
  if (!sendMotionNext) ++telemetrySequence;
  put16(packet, 4, telemetrySequence);
  if (!sendMotionNext) {
    put16(packet, 6, (uint16_t)lroundf(bpm * 10));
    put16(packet, 8, (uint16_t)(int16_t)lroundf(ax * 100));
    put16(packet, 10, (uint16_t)(int16_t)lroundf(ay * 100));
    put16(packet, 12, (uint16_t)(int16_t)lroundf(az * 100));
    put32(packet, 14, ir);
    put16(packet, 18, (uint16_t)(int16_t)lroundf(sensorTemperature * 100));
  } else {
    put16(packet, 6, (uint16_t)(int16_t)lroundf(gx * 1000));
    put16(packet, 8, (uint16_t)(int16_t)lroundf(gy * 1000));
    put16(packet, 10, (uint16_t)(int16_t)lroundf(gz * 1000));
    put32(packet, 12, now);
  }
  dataCharacteristic->setValue(packet, sizeof(packet));
  dataCharacteristic->notify();
  sendMotionNext = !sendMotionNext;
}

void resetRate() {
  bpm = 0;
  rateIndex = rateUsed = 0;
  lastBeat = 0;
  haveBeat = false;
  for (uint8_t i = 0; i < RATE_COUNT; ++i) rates[i] = 0;
}

void readHeartRate() {
  if (!pulseOK) return;
  pulse.check();
  while (pulse.available()) {
    ir = pulse.getFIFOIR();
    pulse.nextSample();
    uint32_t now = millis();
    lastSample = now;
    bool present = ir >= FINGER_IR_THRESHOLD;
    if (present != fingerPresent) {
      fingerPresent = present;
      fingerSince = now;
      resetRate();
    }
    // Feed every sample to the filter, including samples without a finger.
    bool beat = checkForBeat(ir);
    if (!fingerPresent || now - fingerSince < 2000) continue;
    if (beat) {
      if (haveBeat) {
        uint32_t interval = now - lastBeat;
        float candidate = interval ? 60000.0f / interval : 0;
        if (candidate >= 30 && candidate <= 220) {
          rates[rateIndex] = candidate;
          rateIndex = (rateIndex + 1) % RATE_COUNT;
          if (rateUsed < RATE_COUNT) ++rateUsed;
          float total = 0;
          for (uint8_t i = 0; i < rateUsed; ++i) total += rates[i];
          bpm = total / rateUsed;
        }
      }
      lastBeat = now;
      haveBeat = true;
    }
  }
  uint32_t now = millis();
  if (now - lastSample > 1000) {
    fingerPresent = false;
    fingerSince = now;
    resetRate();
  }
  if (haveBeat && now - lastBeat > 3000) resetRate();
}

void readButton() {
  static int previous = HIGH, stable = HIGH;
  static uint32_t changedAt = 0;
  int current = digitalRead(BUTTON_PIN);
  if (current != previous) { previous = current; changedAt = millis(); }
  if (millis() - changedAt >= 30 && current != stable) {
    stable = current;
    if (stable == LOW) useG = !useG;
  }
}

void renderScreen() {
  char line[32];
  tft.fillRect(0, 20, tft.width(), 99, ST77XX_BLACK);
  tft.setTextColor(ST77XX_GREEN, ST77XX_BLACK);
  tft.setTextSize(2);
  tft.setCursor(2, 23);
  if (bpm > 0) snprintf(line, sizeof(line), "HR: %.0f", bpm);
  else snprintf(line, sizeof(line), "HR: --");
  tft.print(line);
  tft.setTextSize(1);
  tft.setCursor(2, 44);
  tft.setTextColor(ST77XX_YELLOW, ST77XX_BLACK);
  if (!pulseOK) tft.print("MAX30102 NOT FOUND");
  else if (millis() - lastSample > 1000) tft.print("MAX30102 NO DATA");
  else if (!fingerPresent) tft.print("Place finger on sensor");
  else if (bpm == 0) tft.print("Measuring... keep still");
  else tft.print("BPM (4-beat average)");

  tft.setTextColor(ST77XX_CYAN, ST77XX_BLACK);
  tft.setCursor(2, 60);
  tft.print(useG ? "Acceleration (g)" : "Acceleration (m/s^2)");
  if (!mpuOK) {
    tft.setCursor(2, 77);
    tft.setTextColor(ST77XX_RED, ST77XX_BLACK);
    tft.print("MPU6050 NOT FOUND");
  } else {
    float divisor = useG ? STANDARD_GRAVITY : 1.0f;
    float magnitude = sqrtf(ax * ax + ay * ay + az * az);
    snprintf(line, sizeof(line), "X:%7.2f Y:%7.2f", ax / divisor, ay / divisor);
    tft.setCursor(2, 76); tft.print(line);
    snprintf(line, sizeof(line), "Z:%7.2f A:%7.2f", az / divisor, magnitude / divisor);
    tft.setCursor(2, 90); tft.print(line);
  }
  snprintf(line, sizeof(line), "IR: %lu", (unsigned long)ir);
  tft.setTextColor(ST77XX_WHITE, ST77XX_BLACK);
  tft.setCursor(2, 106); tft.print(line);
  tft.fillRect(0,120,tft.width(),8,ST77XX_BLACK);
  tft.setCursor(2,120);
  if (!lastActivity || millis()-lastActivity>3000) tft.print("ACT: waiting for PC");
  else {
    const char *shortName = !strcmp(activityName,"JUMPING_JACK") ? "JACK" :
                           !strcmp(activityName,"RUNNING") ? "RUN" : activityName;
    snprintf(line,sizeof(line),"ACT: %s %.0f%%",shortName,activityConfidence*100);
    tft.print(line);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT); // GPIO36 has no internal pull-up/pull-down
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);
  Wire.setTimeOut(20);
  SPI.begin(TFT_SCLK, -1, TFT_MOSI, TFT_CS);
  tft.initR(INITR_BLACKTAB); // Try INITR_GREENTAB / INITR_REDTAB if needed
  tft.setRotation(1); // Landscape 160x128
  tft.setTextWrap(false);
  tft.fillScreen(ST77XX_BLACK);
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_WHITE);
  tft.setCursor(2, 5); tft.print("SMART SPORT - BLE");
  tft.drawFastHLine(0, 17, tft.width(), ST77XX_BLUE);
  tft.setCursor(2, 120); tft.print("ACT: waiting for PC");

  mpuOK = mpu.begin(0x68, &Wire);
  if (!mpuOK) mpuOK = mpu.begin(0x69, &Wire);
  if (mpuOK) {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  }
  pulseOK = pulse.begin(Wire, I2C_SPEED_FAST);
  if (pulseOK) {
    // Red + IR, 400 samples/s averaged by 4 => 100 FIFO samples/s.
    pulse.setup(0x1F, 4, 2, 400, 411, 4096);
    pulse.clearFIFO();
  }
  Serial.printf("MPU6050: %s; MAX30102: %s\n", mpuOK ? "OK" : "FAILED", pulseOK ? "OK" : "FAILED");
  renderScreen();
  setupBluetooth();
}

void loop() {
  readHeartRate();
  readButton();
  receiveActivity();
  uint32_t now = millis();
  if (mpuOK && now - lastAccel >= 20) {
    // No synthetic catch-up samples: timestamps describe actual acquisition.
    lastAccel += 20;
    if (now-lastAccel >= 20) lastAccel = now;
    sensors_event_t a, g, temperature;
    if (mpu.getEvent(&a, &g, &temperature)) {
      ax = a.acceleration.x;
      ay = a.acceleration.y;
      az = (a.acceleration.z - ACCEL_Z_OFFSET) * ACCEL_Z_SCALE;
      gx = g.gyro.x;
      gy = g.gyro.y;
      gz = g.gyro.z;
      sensorTemperature = temperature.temperature;
      sendSerialSample(millis());
    } else {
      mpuOK = false; // Reboot after correcting wiring
    }
  }
  if (now - lastScreen >= 200) {
    lastScreen = now;
    renderScreen();
  }
  sendBluetooth();
  delay(1);
}
