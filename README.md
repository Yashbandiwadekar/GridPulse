# GridPulse

**End-to-end IoT energy monitoring: from an ESP32 sensor node on the AC mains to a real-time cloud dashboard.**

GridPulse is a full IoT stack I designed and built: embedded firmware on an ESP32 reads a PZEM-004T power meter over Modbus-RTU and publishes telemetry over MQTT/TLS. A Node.js ingestion service validates each packet, stores it in PostgreSQL and streams it live to a React dashboard over WebSockets. An optional LLM layer reviews the data periodically and flags anomalies.

![ESP32](https://img.shields.io/badge/device-ESP32-E7352C)
![MQTT](https://img.shields.io/badge/protocol-MQTT%20over%20TLS-660066)
![Node](https://img.shields.io/badge/backend-Node.js%20%2B%20Express-339933)
![PostgreSQL](https://img.shields.io/badge/db-PostgreSQL%2016-336791)
![React](https://img.shields.io/badge/dashboard-React%2019%20%2B%20Vite-0ea5e9)

---

## Architecture

```
  EDGE                     CLOUD BROKER            SERVER                          CLIENT
┌──────────────────┐     ┌──────────────┐     ┌──────────────────────┐      ┌─────────────────┐
│ PZEM-004T v3     │     │              │     │ Node.js ingestion    │      │ React dashboard │
│   │ Modbus-RTU   │     │  HiveMQ      │     │  · schema validation │ WS   │  · live KPIs    │
│   ▼ (UART2)      │MQTT │  Cloud       │MQTT │  · PostgreSQL write  │─────►│  · history      │
│ ESP32            │────►│  (TLS :8883) │────►│  · Socket.io fan-out │      │  · alarms       │
│  · WiFi STA      │QoS0 │              │QoS1 │  · REST history API  │      │  · AI insights  │
│  · JSON @ 10 s   │     └──────────────┘     │  · LLM anomaly check │      └─────────────────┘
└──────────────────┘                          └──────────┬───────────┘
                                                         ▼
                                              PostgreSQL (time-series,
                                              BRIN + composite index)
```

## What I built at each layer

### 1. Edge device ([`firmware/`](firmware/gridpulse-node))
- ESP32 talks to a **PZEM-004T v3** energy meter over **Modbus-RTU on UART2** (GPIO 16/17)
- Samples voltage, current, active power, cumulative energy, mains frequency and power factor
- Publishes a compact JSON packet every 10 s to an **MQTT broker over TLS (port 8883)**
- Non-blocking `millis()` scheduler keeps the MQTT keep-alive serviced between samples
- Recovers on its own after WiFi or broker drop-outs, and discards invalid (`NaN`) sensor reads
- Credentials sit in a gitignored `secrets.h`, separate from the source

### 2. Messaging
- HiveMQ Cloud serverless broker, with a per-device client ID and topic (`pzem/<device>/telemetry`)
- The backend subscribes with **MQTT v5, QoS 1**, a TLS certificate check and automatic reconnect

### 3. Ingestion backend ([`backend/`](backend))
- Checks the type of every incoming field before storing it. Malformed packets never reach the DB
- Writes to PostgreSQL and pushes each new reading to all connected dashboards through **Socket.io**
- `GET /api/history` returns raw samples for short windows. For 24 h and 7 d it **downsamples on the server** with `date_bin()`
- Database checks (`CHECK` constraints) reject values outside realistic electrical ranges
- Shuts down gracefully, uses a pooled DB connection, and provides a `/healthz` liveness endpoint

### 4. Data layer ([`backend/schema.sql`](backend/schema.sql))
- Append-only time-series table with a **BRIN index** on the timestamp (small on disk, fast range scans)
- A composite `(device_id, created_at DESC)` index serves "latest N readings" queries
- Notes in the schema cover how to scale to TimescaleDB or monthly partitions later

### 5. Dashboard ([`dashboard/`](dashboard))
- A control-room-style (SCADA) UI with live KPI cards, a mains frequency gauge and an event log
- 5M / 1H / 24H / 7D charts built with Recharts, plus CSV export
- Alarm limits for voltage, current, PF, power spikes and frequency deviation that you can change in the app

### 6. AI insights (optional)
- Every N minutes, the backend summarises 1 h and 24 h statistics and asks an LLM (via OpenRouter) for anomalies, trends and efficiency tips
- The model's JSON reply is checked against a fixed structure. One call per cycle is shared by every open dashboard to stay within free-tier limits

---

## Hardware

| Component | Notes |
|---|---|
| ESP32 DevKit | Any ESP32 with UART2 |
| PZEM-004T v3.0 (TTL) | Includes 100 A split-core CT |
| 5 V supply | Powers the PZEM TTL side |

**Wiring**

| PZEM | ESP32 |
|---|---|
| TX | GPIO 16 (RX2) |
| RX | GPIO 17 (TX2) |
| 5V | 5V |
| GND | GND |

> ⚠️ The PZEM's measurement side connects to AC mains. Wire it with power off and keep the CT and voltage terminals enclosed.

Keep UART leads short and add a 100 nF decoupling cap near the TTL header. For long or noisy runs, use the RS-485 PZEM variant with MAX485 transceivers.

---

## Repository layout

```
gridpulse/
├── firmware/gridpulse-node/
│   ├── gridpulse-node.ino     # ESP32 firmware (Arduino)
│   └── secrets.example.h      # copy to secrets.h
├── backend/
│   ├── server.js              # MQTT → PostgreSQL → Socket.io + REST + AI
│   ├── schema.sql             # time-series schema
│   └── seed.js                # synthetic data generator (no hardware needed)
└── dashboard/
    └── src/PowerMonitoringDashboard.jsx
```

---

## Quick start

You **don't need the hardware** to try it: the seed script generates realistic load profiles (overnight base load, morning and evening peaks, fridge cycling, appliance spikes).

```bash
# 1. PostgreSQL
docker run --name gridpulse-pg -e POSTGRES_PASSWORD=mysecret -e POSTGRES_DB=gridpulse -p 5432:5432 -d postgres:16
docker exec -i gridpulse-pg psql -U postgres -d gridpulse < backend/schema.sql

# 2. Backend
cd backend
npm install
cp .env.example .env        # fill in PG + MQTT values
npm run seed:clear          # optional: 7 days of synthetic data
npm run dev

# 3. Dashboard (new terminal)
cd dashboard
npm install
cp .env.example .env
npm run dev                 # http://localhost:5173
```

### Flashing the device

1. In Arduino IDE, install the **ESP32 board package**, **PubSubClient** and **PZEM004Tv30** libraries.
2. Copy `firmware/gridpulse-node/secrets.example.h` to `secrets.h` and fill in your WiFi and MQTT credentials.
3. Flash `gridpulse-node.ino`, then open the Serial Monitor at 115200 baud to watch packets go out.

### Telemetry contract

```json
{
  "device": "esp32_pzem_01",
  "voltage_V": 236.40,
  "current_A": 0.145,
  "power_W": 34.22,
  "energy_Wh": 128.55,
  "frequency_Hz": 50.02,
  "power_factor": 0.98
}
```

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/healthz` | MQTT / AI status, connected clients |
| `GET`  | `/api/history?range=5M\|1H\|24H\|7D&device=<id>` | Historical samples (downsampled for wide ranges) |
| `GET`  | `/api/insights` | Latest AI analysis |
| `POST` | `/api/insights/run` | Trigger an AI analysis now |

WebSocket events: `telemetry`, `ai-insight`, `ai-insight-error`.

---

## Configuration

`backend/.env` (see [`backend/.env.example`](backend/.env.example)):

| Variable | Purpose |
|---|---|
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | PostgreSQL |
| `MQTT_HOST` `MQTT_PORT` `MQTT_USERNAME` `MQTT_PASSWORD` `MQTT_TOPIC` | Broker |
| `CORS_ORIGIN` | Dashboard URL |
| `OPENROUTER_API_KEY` `OPENROUTER_MODEL` `INSIGHT_INTERVAL_MINUTES` | Optional AI insights |

---

## Roadmap

- [ ] Pin the broker's root CA on the ESP32 instead of `setInsecure()`
- [ ] OTA firmware updates
- [ ] Support for multiple devices in the dashboard
- [ ] Docker Compose for the full stack
- [ ] Three-phase metering (3× PZEM on Modbus addresses)

---

## License

MIT. See [LICENSE](LICENSE).
