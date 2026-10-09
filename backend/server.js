/**
 * ============================================================================
 *  GridPulse Ingestion Backend
 *  ---------------------------------------------------------------------------
 *  Pipeline:
 *      HiveMQ Cloud (MQTT/TLS:8883)
 *          └──► mqtt client ──► PostgreSQL INSERT
 *                           └─► socket.io emit  ──► React dashboard
 *
 *  Responsibilities:
 *    1. Subscribe to pzem/device01/telemetry (QoS 1).
 *    2. Validate + persist each payload.
 *    3. Fan out to all connected browser clients in real time.
 *    4. Serve GET /api/history for initial dashboard hydration.
 * ============================================================================
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const mqtt = require("mqtt");
const { Pool } = require("pg");

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------- */
const PORT = parseInt(process.env.PORT || "4000", 10);

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

const MQTT_TOPIC = process.env.MQTT_TOPIC || "pzem/device01/telemetry";

// Fail fast if critical secrets are missing — better than a confusing runtime error.
["PGHOST", "PGUSER", "PGDATABASE", "MQTT_HOST", "MQTT_USERNAME", "MQTT_PASSWORD"].forEach(
    (key) => {
        if (!process.env[key]) {
            console.error(`[FATAL] Missing required env var: ${key}`);
            process.exit(1);
        }
    }
);

/* ---------------------------------------------------------------------------
 * PostgreSQL pool
 * ------------------------------------------------------------------------- */
const pool = new Pool({
    host: process.env.PGHOST,
    port: parseInt(process.env.PGPORT || "5432", 10),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: 10,                    // ~10 concurrent queries is plenty for this workload
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // If your PG host requires TLS (managed clouds usually do):
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
});

// A pool-level error handler is CRITICAL — without it, an idle-client error
// will crash the whole process.
pool.on("error", (err) => {
    console.error("[PG] Idle client error:", err.message);
});

// Sanity-check the DB connection at startup.
(async () => {
    try {
        const { rows } = await pool.query("SELECT NOW() AS now");
        console.log(`[PG] Connected. Server time: ${rows[0].now.toISOString()}`);
    } catch (err) {
        console.error("[PG] Startup connectivity check FAILED:", err.message);
        // We keep the process alive — pg will retry on next query — but log loudly.
    }
})();

/* ---------------------------------------------------------------------------
 * Express + HTTP + Socket.io
 * ------------------------------------------------------------------------- */
const app = express();
const server = http.createServer(app);

app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());

const io = new Server(server, {
    cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
    console.log(`[WS] Client connected: ${socket.id}  (total: ${io.engine.clientsCount})`);
    socket.on("disconnect", (reason) => {
        console.log(`[WS] Client disconnected: ${socket.id}  (${reason})`);
    });
});

/* ---------------------------------------------------------------------------
 * Range → SQL interval mapping. Keep server + client in lockstep.
 * ------------------------------------------------------------------------- */
const RANGE_INTERVALS = {
    "5M": "5 minutes",
    "1H": "1 hour",
    "24H": "24 hours",
    "7D": "7 days",
};

// Cap on points returned per range (protects the browser and the chart).
const RANGE_LIMITS = {
    "5M": 30,     //  10s cadence → 30 pts over 5 min
    "1H": 360,    //  10s cadence → 360 pts over 1 h
    "24H": 288,    //  5-min buckets → 288 pts over 24 h
    "7D": 336,    //  30-min buckets → 336 pts over 7 d
};

/**
 * Pick a tick-label format appropriate to the zoom level.
 *   5M  / 1H  → HH:MM:SS  (sub-minute resolution matters)
 *   24H       → HH:MM      (spans a day; seconds are noise)
 *   7D        → DD MMM HH:MM  (needs the date to disambiguate)
 */
function formatTick(date, range) {
    if (range === "7D") {
        return date.toLocaleString("en-GB", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });
    }
    if (range === "24H") {
        return date.toLocaleTimeString("en-US", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
        });
    }
    return date.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

/* ---------------------------------------------------------------------------
 * REST: GET /api/history?range=5M|1H|24H|7D[&device=esp32_pzem_01]
 *   - 5M / 1H → raw samples (cadence small enough to plot directly).
 *   - 24H / 7D → server-side downsampling via Postgres `date_bin` into
 *                5-min / 30-min buckets. Returns ASC chronological order.
 * ------------------------------------------------------------------------- */
app.get("/api/history", async (req, res) => {
    const range = RANGE_INTERVALS[req.query.range] ? req.query.range : "5M";
    const device = req.query.device || "esp32_pzem_01";
    const interval = RANGE_INTERVALS[range];
    const limit = RANGE_LIMITS[range];

    try {
        let rows;

        if (range === "5M" || range === "1H") {
            // Raw samples — point count stays manageable (≤360).
            const result = await pool.query(
                `
                SELECT id, device_id, voltage_v, current_a, power_w,
                       energy_wh, frequency_hz, power_factor, created_at
                FROM pzem_telemetry
                WHERE device_id = $1
                  AND created_at > NOW() - $2::interval
                ORDER BY created_at ASC
                LIMIT $3;
                `,
                [device, interval, limit]
            );
            rows = result.rows;
        } else {
            // Downsample wide windows into fixed buckets.
            //   - AVG() for instantaneous channels (V, I, P, PF, Hz)
            //   - MAX() for cumulative energy (monotonically increasing)
            //   - date_bin() (PG 14+) with a fixed anchor for deterministic buckets
            const bucket = range === "24H" ? "5 minutes" : "30 minutes";
            const result = await pool.query(
                `
                SELECT
                    MIN(id)                  AS id,
                    device_id,
                    AVG(voltage_v)::REAL     AS voltage_v,
                    AVG(current_a)::REAL     AS current_a,
                    AVG(power_w)::REAL       AS power_w,
                    MAX(energy_wh)           AS energy_wh,
                    AVG(frequency_hz)::REAL  AS frequency_hz,
                    AVG(power_factor)::REAL  AS power_factor,
                    date_bin($4::interval, created_at, TIMESTAMPTZ '2000-01-01') AS created_at
                FROM pzem_telemetry
                WHERE device_id = $1
                  AND created_at > NOW() - $2::interval
                GROUP BY device_id,
                         date_bin($4::interval, created_at, TIMESTAMPTZ '2000-01-01')
                ORDER BY created_at ASC
                LIMIT $3;
                `,
                [device, interval, limit, bucket]
            );
            rows = result.rows;
        }

        // Shape payload to match the React component's expected fields.
        const history = rows.map((r) => {
            const d = new Date(r.created_at);
            return {
                device: r.device_id,
                voltage_V: Number(r.voltage_v),
                current_A: Number(r.current_a),
                power_W: Number(r.power_w),
                energy_Wh: Number(r.energy_wh),
                frequency_Hz: Number(r.frequency_hz),
                power_factor: Number(r.power_factor),
                timestamp: d.getTime(),
                time: formatTick(d, range),
            };
        });

        res.json({ range, count: history.length, history });
    } catch (err) {
        console.error("[API] /api/history failed:", err.message);
        res.status(500).json({ error: "history_query_failed" });
    }
});

/* ---------------------------------------------------------------------------
 * REST: GET /healthz  — tiny liveness probe for uptime monitors / docker
 * ------------------------------------------------------------------------- */
app.get("/healthz", (_, res) => {
    res.json({
        status: "ok",
        mqtt: mqttClient?.connected ? "connected" : "disconnected",
        clients: io.engine.clientsCount,
        ai: AI_ENABLED ? "enabled" : "disabled",
    });
});

/* ===========================================================================
 * AI INSIGHTS — OpenRouter integration
 * ---------------------------------------------------------------------------
 * Strategy:
 *   - A single backend-driven timer runs analysis every N minutes.
 *   - Results are cached in memory and fanned out via socket.io to all
 *     connected dashboards. This means 1 API call per cycle regardless of
 *     how many tabs are open — important on OpenRouter's free tier.
 *   - GET  /api/insights      → returns the last cached analysis
 *   - POST /api/insights/run  → manual trigger (fires now, respects the
 *                               in-flight guard to prevent concurrent calls)
 * =========================================================================== */

const AI_ENABLED = Boolean(process.env.OPENROUTER_API_KEY);
const AI_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
const AI_INTERVAL_MINUTES = Math.max(
    5,
    parseInt(process.env.INSIGHT_INTERVAL_MINUTES || "15", 10)
);
const AI_INTERVAL_MS = AI_INTERVAL_MINUTES * 60 * 1000;
const AI_DEVICE = process.env.INSIGHT_DEVICE || "esp32_pzem_01";
const AI_APP_URL = process.env.INSIGHT_APP_URL || "http://localhost:4000";
const AI_APP_TITLE = process.env.INSIGHT_APP_TITLE || "GridPulse";
const AI_TIMEOUT_MS = 30_000;
const AI_MIN_SAMPLES = 3; // need at least this many rows in the last hour

let lastInsight = null;       // latest successful result, or null
let lastInsightError = null;  // latest error, surfaced to UI
let insightInFlight = false;  // guards against concurrent API calls
let insightTimer = null;

async function aiGetCurrentReading(device) {
    const { rows } = await pool.query(
        `SELECT * FROM pzem_telemetry
         WHERE device_id = $1
         ORDER BY created_at DESC
         LIMIT 1;`,
        [device]
    );
    return rows[0] || null;
}

async function aiGetStatsWindow(device, interval) {
    const { rows } = await pool.query(
        `
        SELECT
            COUNT(*)::int                  AS n,
            COALESCE(AVG(voltage_v), 0)    AS voltage_avg,
            COALESCE(MIN(voltage_v), 0)    AS voltage_min,
            COALESCE(MAX(voltage_v), 0)    AS voltage_max,
            COALESCE(AVG(current_a), 0)    AS current_avg,
            COALESCE(MIN(current_a), 0)    AS current_min,
            COALESCE(MAX(current_a), 0)    AS current_max,
            COALESCE(AVG(power_w), 0)      AS power_avg,
            COALESCE(MIN(power_w), 0)      AS power_min,
            COALESCE(MAX(power_w), 0)      AS power_max,
            COALESCE(AVG(frequency_hz), 0) AS frequency_avg,
            COALESCE(MIN(frequency_hz), 0) AS frequency_min,
            COALESCE(MAX(frequency_hz), 0) AS frequency_max,
            COALESCE(AVG(power_factor)
                FILTER (WHERE current_a > 0.1), 0) AS pf_avg_active,
            COALESCE(MAX(energy_wh) - MIN(energy_wh), 0) AS energy_consumed_wh
        FROM pzem_telemetry
        WHERE device_id = $1
          AND created_at > NOW() - $2::interval;
        `,
        [device, interval]
    );
    return rows[0];
}

function aiBuildPrompt(current, s1h, s24h) {
    const fmt = (v) => {
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) ? n.toFixed(2) : "0.00";
    };

    const systemPrompt = `You are an industrial SCADA operations analyst reviewing single-phase AC electrical telemetry from a PZEM-004T meter.

STRICT RULES:
- Comment ONLY on the numbers provided. Never invent values not in the data.
- If data is insufficient to make a claim, say so explicitly instead of guessing.
- Be concise, technical, and specific. No fluff, no marketing language.
- Output ONLY valid JSON matching the schema. No markdown, no code fences, no preamble.
- Every text field must be under 160 characters.

OUTPUT SCHEMA (all arrays may be empty; at most 3 items each):
{
  "summary": "string — 1-2 sentence operational state description",
  "anomalies": [{"severity": "low" | "medium" | "high", "message": "string"}],
  "trends":    [{"metric": "voltage" | "current" | "power" | "frequency" | "pf", "direction": "rising" | "falling" | "stable", "message": "string"}],
  "tips":      [{"category": "efficiency" | "safety" | "cost" | "maintenance", "message": "string"}]
}

DOMAIN CONTEXT (Indian 230V / 50Hz mains):
- Nominal voltage: 220–245 V. Below 210 V or above 250 V is critical.
- Nominal frequency: 50 Hz ± 0.2 Hz; deviation > 0.5 Hz is critical.
- Power factor < 0.85 indicates significant inductive/reactive load inefficiency.
- Sustained current > 7 A on a typical 6/10 A circuit suggests overload risk.`;

    const userPrompt = `CURRENT READING:
- Voltage: ${fmt(current?.voltage_v)} V
- Current: ${fmt(current?.current_a)} A
- Power:   ${fmt(current?.power_w)} W
- PF:      ${fmt(current?.power_factor)}
- Freq:    ${fmt(current?.frequency_hz)} Hz
- Cumulative energy: ${fmt(current?.energy_wh)} Wh

LAST 1 HOUR (${s1h.n} samples):
- Voltage: avg ${fmt(s1h.voltage_avg)} V, range ${fmt(s1h.voltage_min)}–${fmt(s1h.voltage_max)}
- Current: avg ${fmt(s1h.current_avg)} A, range ${fmt(s1h.current_min)}–${fmt(s1h.current_max)}
- Power:   avg ${fmt(s1h.power_avg)} W, range ${fmt(s1h.power_min)}–${fmt(s1h.power_max)}
- Freq:    avg ${fmt(s1h.frequency_avg)} Hz, range ${fmt(s1h.frequency_min)}–${fmt(s1h.frequency_max)}
- Avg PF when active: ${fmt(s1h.pf_avg_active)}
- Energy consumed: ${fmt(s1h.energy_consumed_wh)} Wh

LAST 24 HOURS (${s24h.n} samples):
- Voltage: avg ${fmt(s24h.voltage_avg)} V, range ${fmt(s24h.voltage_min)}–${fmt(s24h.voltage_max)}
- Current: avg ${fmt(s24h.current_avg)} A, peak ${fmt(s24h.current_max)}
- Power:   avg ${fmt(s24h.power_avg)} W, peak ${fmt(s24h.power_max)}
- Freq:    range ${fmt(s24h.frequency_min)}–${fmt(s24h.frequency_max)} Hz
- Avg PF when active: ${fmt(s24h.pf_avg_active)}
- Energy consumed: ${fmt(s24h.energy_consumed_wh)} Wh

Analyze and respond with JSON.`;

    return { systemPrompt, userPrompt };
}

function aiParseResponse(raw) {
    let text = String(raw || "").trim();
    // Strip ```json ... ``` fences if the model added them despite instructions.
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    // Robust to preamble/postamble: extract first {...} block.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
        throw new Error("model_returned_no_json_object");
    }

    const obj = JSON.parse(text.slice(start, end + 1));

    const asArray = (v) => (Array.isArray(v) ? v.slice(0, 3) : []);

    return {
        summary: String(obj.summary || "").slice(0, 400),
        anomalies: asArray(obj.anomalies).map((a) => ({
            severity: ["low", "medium", "high"].includes(a?.severity) ? a.severity : "low",
            message: String(a?.message || "").slice(0, 200),
        })),
        trends: asArray(obj.trends).map((t) => ({
            metric: String(t?.metric || "").toLowerCase(),
            direction: ["rising", "falling", "stable"].includes(t?.direction)
                ? t.direction
                : "stable",
            message: String(t?.message || "").slice(0, 200),
        })),
        tips: asArray(obj.tips).map((t) => ({
            category: ["efficiency", "safety", "cost", "maintenance"].includes(t?.category)
                ? t.category
                : "efficiency",
            message: String(t?.message || "").slice(0, 200),
        })),
    };
}

async function aiCallOpenRouter(systemPrompt, userPrompt) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    try {
        const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                // OpenRouter uses these headers for free-tier attribution/analytics.
                "HTTP-Referer": AI_APP_URL,
                "X-Title": AI_APP_TITLE,
            },
            signal: controller.signal,
            body: JSON.stringify({
                model: AI_MODEL,
                temperature: 0.3,
                max_tokens: 800,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
            }),
        });

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`openrouter_http_${resp.status}: ${body.slice(0, 200)}`);
        }

        const data = await resp.json();
        const raw = data?.choices?.[0]?.message?.content;
        if (!raw) throw new Error("empty_model_response");

        return { raw, usage: data.usage || null };
    } catch (err) {
        if (err.name === "AbortError") throw new Error("openrouter_timeout");
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

async function generateInsight({ manual = false } = {}) {
    if (!AI_ENABLED) return { ok: false, reason: "ai_disabled" };
    if (insightInFlight) return { ok: false, reason: "already_running" };

    insightInFlight = true;
    const startedAt = Date.now();

    try {
        const current = await aiGetCurrentReading(AI_DEVICE);
        if (!current) {
            console.log("[AI] Skipped — no telemetry rows for this device yet.");
            return { ok: false, reason: "no_data" };
        }

        const [s1h, s24h] = await Promise.all([
            aiGetStatsWindow(AI_DEVICE, "1 hour"),
            aiGetStatsWindow(AI_DEVICE, "24 hours"),
        ]);

        if (s1h.n < AI_MIN_SAMPLES) {
            console.log(`[AI] Skipped — only ${s1h.n} sample(s) in last hour.`);
            return { ok: false, reason: "insufficient_data", samples: s1h.n };
        }

        const { systemPrompt, userPrompt } = aiBuildPrompt(current, s1h, s24h);
        const { raw, usage } = await aiCallOpenRouter(systemPrompt, userPrompt);
        const parsed = aiParseResponse(raw);

        lastInsight = {
            ...parsed,
            model: AI_MODEL,
            generatedAt: new Date().toISOString(),
            intervalMinutes: AI_INTERVAL_MINUTES,
            manual,
            elapsedMs: Date.now() - startedAt,
            usage,
        };
        lastInsightError = null;

        io.emit("ai-insight", lastInsight);
        console.log(
            `[AI] Generated in ${lastInsight.elapsedMs}ms. ` +
            `anomalies=${parsed.anomalies.length} trends=${parsed.trends.length} tips=${parsed.tips.length}`
        );

        return { ok: true, insight: lastInsight };
    } catch (err) {
        console.error("[AI] Failed:", err.message);
        lastInsightError = {
            error: err.message || "unknown_error",
            model: AI_MODEL,
            generatedAt: new Date().toISOString(),
        };
        io.emit("ai-insight-error", lastInsightError);
        return { ok: false, reason: "error", error: err.message };
    } finally {
        insightInFlight = false;
    }
}

/* -------- AI REST endpoints ---------------------------------------------- */
app.get("/api/insights", (_, res) => {
    res.json({
        enabled: AI_ENABLED,
        model: AI_ENABLED ? AI_MODEL : null,
        intervalMinutes: AI_ENABLED ? AI_INTERVAL_MINUTES : null,
        insight: lastInsight,
        error: lastInsightError,
    });
});

app.post("/api/insights/run", async (_, res) => {
    const result = await generateInsight({ manual: true });
    res.json(result);
});

/* -------- Start the analysis loop ---------------------------------------- */
if (AI_ENABLED) {
    console.log(
        `[AI] Insights enabled — model=${AI_MODEL}, interval=${AI_INTERVAL_MINUTES} min.`
    );
    // First run 60 s after boot, so initial telemetry has time to accumulate.
    setTimeout(() => generateInsight().catch(() => { }), 60_000);
    insightTimer = setInterval(
        () => generateInsight().catch(() => { }),
        AI_INTERVAL_MS
    );
} else {
    console.log("[AI] Insights disabled — set OPENROUTER_API_KEY in .env to enable.");
}

/* ---------------------------------------------------------------------------
 * MQTT client — TLS on 8883 to HiveMQ Cloud
 * ------------------------------------------------------------------------- */
const mqttUrl = `mqtts://${process.env.MQTT_HOST}:${process.env.MQTT_PORT || 8883}`;

const mqttClient = mqtt.connect(mqttUrl, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clientId: `gridpulse-backend-${Math.random().toString(16).slice(2, 10)}`,
    protocolVersion: 5,
    clean: true,
    reconnectPeriod: 3_000,     // retry every 3 s after disconnect
    connectTimeout: 10_000,
    rejectUnauthorized: true,   // verify HiveMQ's TLS cert
});

mqttClient.on("connect", () => {
    console.log(`[MQTT] Connected to ${mqttUrl}`);
    mqttClient.subscribe(MQTT_TOPIC, { qos: 1 }, (err, granted) => {
        if (err) {
            console.error("[MQTT] Subscribe failed:", err.message);
        } else {
            console.log(`[MQTT] Subscribed: ${granted.map((g) => g.topic).join(", ")}`);
        }
    });
});

mqttClient.on("reconnect", () => console.log("[MQTT] Reconnecting..."));
mqttClient.on("close", () => console.log("[MQTT] Connection closed."));
mqttClient.on("offline", () => console.log("[MQTT] Offline."));
mqttClient.on("error", (err) => console.error("[MQTT] Error:", err.message));

/* ---------------------------------------------------------------------------
 * Payload validation — reject garbage before it hits the DB.
 * ------------------------------------------------------------------------- */
function validateTelemetry(p) {
    if (!p || typeof p !== "object") return "not_object";
    const numericKeys = [
        "voltage_V", "current_A", "power_W",
        "energy_Wh", "frequency_Hz", "power_factor",
    ];
    for (const k of numericKeys) {
        if (typeof p[k] !== "number" || Number.isNaN(p[k])) return `bad_field_${k}`;
    }
    if (typeof p.device !== "string" || p.device.length === 0) return "bad_device";
    return null;
}

/* ---------------------------------------------------------------------------
 * Message handler — the heart of the pipeline.
 * ------------------------------------------------------------------------- */
mqttClient.on("message", async (topic, buffer) => {
    let payload;
    try {
        payload = JSON.parse(buffer.toString());
    } catch (err) {
        console.warn(`[MQTT] Non-JSON payload on ${topic}: ${err.message}`);
        return;
    }

    const problem = validateTelemetry(payload);
    if (problem) {
        console.warn(`[MQTT] Rejected payload (${problem}):`, payload);
        return;
    }

    // 1) Persist
    try {
        const { rows } = await pool.query(
            `
            INSERT INTO pzem_telemetry
                (device_id, voltage_v, current_a, power_w,
                 energy_wh, frequency_hz, power_factor)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, created_at;
            `,
            [
                payload.device,
                payload.voltage_V,
                payload.current_A,
                payload.power_W,
                payload.energy_Wh,
                payload.frequency_Hz,
                payload.power_factor,
            ]
        );

        const { id, created_at } = rows[0];

        // 2) Fan out to all connected dashboards
        const enriched = {
            ...payload,
            id,
            timestamp: new Date(created_at).getTime(),
            time: new Date(created_at).toLocaleTimeString("en-US", {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            }),
        };

        io.emit("telemetry", enriched);
    } catch (err) {
        // DB errors must NOT kill the MQTT loop — keep ingesting.
        console.error("[PG] INSERT failed:", err.message);
    }
});

/* ---------------------------------------------------------------------------
 * Graceful shutdown
 * ------------------------------------------------------------------------- */
function shutdown(signal) {
    console.log(`\n[SYS] ${signal} received — shutting down.`);

    // Stop the AI loop first so no new requests fire while we tear down.
    if (insightTimer) {
        clearInterval(insightTimer);
        insightTimer = null;
    }

    // Stop taking new HTTP/WS traffic first.
    server.close(() => console.log("[SYS] HTTP server closed."));

    // Then close MQTT and PG cleanly.
    mqttClient.end(false, {}, () => console.log("[SYS] MQTT closed."));
    pool.end().then(() => console.log("[SYS] PG pool drained."));

    // Hard-exit after 5 s if anything is still hanging.
    setTimeout(() => {
        console.warn("[SYS] Forced exit.");
        process.exit(1);
    }, 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
    console.error("[SYS] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("[SYS] Uncaught exception:", err);
});

/* ---------------------------------------------------------------------------
 * Start the server
 * ------------------------------------------------------------------------- */
server.listen(PORT, () => {
    console.log(`[HTTP] Listening on :${PORT}`);
    console.log(`[HTTP] CORS origin:  ${CORS_ORIGIN}`);
});