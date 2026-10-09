// ══════════════════════════════════════════════════════════════════════
// GridPulse Node: ESP32 + PZEM-004T v3 energy telemetry publisher
// ----------------------------------------------------------------------
// Reads V / I / P / E / f / PF from a PZEM-004T over Modbus-RTU (UART2)
// and publishes a JSON packet to an MQTT broker over TLS every 10 s.
//
// Credentials live in secrets.h (copy secrets.example.h; gitignored).
// ══════════════════════════════════════════════════════════════════════

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <PZEM004Tv30.h>
#include "secrets.h"

// ESP32 UART2 pins wired to the PZEM TTL header
#define RXD2 16
#define TXD2 17

const unsigned long PUBLISH_INTERVAL_MS = 10000;  // matches backend/dashboard cadence

PZEM004Tv30 pzem(Serial2, RXD2, TXD2);
WiFiClientSecure espClient;
PubSubClient mqtt(espClient);

unsigned long lastPublish = 0;

void setup_wifi() {
  Serial.print("\nConnecting to WiFi: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.print("\nWiFi connected. IP: ");
  Serial.println(WiFi.localIP());
}

void reconnect_mqtt() {
  while (!mqtt.connected()) {
    Serial.print("Connecting to MQTT broker...");
    if (mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASS)) {
      Serial.println(" connected.");
    } else {
      Serial.print(" failed, rc=");
      Serial.print(mqtt.state());
      Serial.println(". Retrying in 5 s");
      delay(5000);
    }
  }
}

void publish_reading() {
  float voltage   = pzem.voltage();
  float current   = pzem.current();
  float power     = pzem.power();
  float energy    = pzem.energy();   // kWh from the meter
  float frequency = pzem.frequency();
  float pf        = pzem.pf();

  if (isnan(voltage)) {
    Serial.println("PZEM read failed. Check AC mains and UART wiring.");
    return;
  }

  char payload[256];
  snprintf(payload, sizeof(payload),
           "{\"device\":\"%s\",\"voltage_V\":%.2f,\"current_A\":%.3f,"
           "\"power_W\":%.2f,\"energy_Wh\":%.2f,\"frequency_Hz\":%.2f,"
           "\"power_factor\":%.2f}",
           DEVICE_ID, voltage, current, power, energy * 1000.0f, frequency, pf);

  Serial.print("Publishing: ");
  Serial.println(payload);
  mqtt.publish(MQTT_TOPIC, payload);
}

void setup() {
  Serial.begin(115200);
  setup_wifi();

  // TLS without certificate pinning keeps setup simple. For production,
  // load the broker's root CA with espClient.setCACert(...) instead.
  espClient.setInsecure();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);

  Serial.println("Boot complete. Waiting for PZEM data...");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) setup_wifi();
  if (!mqtt.connected()) reconnect_mqtt();
  mqtt.loop();

  // Non-blocking schedule so mqtt.loop() keeps the connection alive.
  if (millis() - lastPublish >= PUBLISH_INTERVAL_MS) {
    lastPublish = millis();
    publish_reading();
  }
}
