import { useState, useEffect, useRef } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import {
  Zap,
  Activity,
  Gauge,
  Waves,
  BatteryCharging,
  Radio,
  TrendingUp,
  Cpu,
  Power,
  TriangleAlert,
  CircleCheck,
  Signal,
  Wifi,
  Download,
  Terminal,
  Trash2,
  Settings,
  X,
  Save,
  RotateCcw,
  Sparkles,
  RefreshCw,
  Lightbulb,
  ShieldAlert,
  ArrowUp,
  ArrowDown,
  Minus,
} from "lucide-react";
import { io as ioClient } from "socket.io-client";

/* ------------------------------------------------------------------ */
/*  Backend endpoint (override via VITE_API_BASE in .env)              */
/* ------------------------------------------------------------------ */
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";

/* ------------------------------------------------------------------ */
/*  CSV export helper                                                  */
/* ------------------------------------------------------------------ */
const CSV_HEADERS = [
  "iso_timestamp",
  "local_time",
  "device_id",
  "voltage_V",
  "current_A",
  "power_W",
  "energy_Wh",
  "frequency_Hz",
  "power_factor",
];

function escapeCsv(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportHistoryToCSV(history) {
  if (!history.length) return false;

  const rows = history.map((h) =>
    [
      new Date(h.timestamp).toISOString(),
      h.time,
      h.device,
      h.voltage_V,
      h.current_A,
      h.power_W,
      h.energy_Wh,
      h.frequency_Hz,
      h.power_factor,
    ]
      .map(escapeCsv)
      .join(",")
  );

  const csv = [CSV_HEADERS.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "gridpulse_export.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

/* ------------------------------------------------------------------ */
/*  Log level styling                                                  */
/* ------------------------------------------------------------------ */
const LOG_LEVEL = {
  INFO: { text: "text-cyan-400", tag: "bg-cyan-500/10    ring-cyan-500/30" },
  WARN: { text: "text-amber-400", tag: "bg-amber-500/10   ring-amber-500/30" },
  CRITICAL: { text: "text-red-400", tag: "bg-red-500/10     ring-red-500/30" },
  SYSTEM: { text: "text-slate-400", tag: "bg-slate-500/10   ring-slate-500/30" },
};

/* ------------------------------------------------------------------ */
/*  Historical range options                                           */
/* ------------------------------------------------------------------ */
const RANGE_OPTIONS = [
  { key: "5M", label: "5M", description: "5 minutes" },
  { key: "1H", label: "1H", description: "1 hour" },
  { key: "24H", label: "24H", description: "24 hours" },
  { key: "7D", label: "7D", description: "7 days" },
];

// How many points the backend returns per range (must match server.js).
const RANGE_SAMPLE_CAPS = { "5M": 30, "1H": 360, "24H": 288, "7D": 336 };

/* ------------------------------------------------------------------ */
/*  Alarm thresholds — overridable via the Settings modal              */
/* ------------------------------------------------------------------ */
const DEFAULT_THRESHOLDS = {
  voltage: {
    warnMin: 220, // V — below this → WARNING
    warnMax: 245, // V — above this → WARNING
    criticalMin: 210, // V — below this → CRITICAL
    criticalMax: 250, // V — above this → CRITICAL
  },
  current: {
    warn: 7, // A
    critical: 9, // A
  },
  powerFactor: {
    nominalMin: 0.85, // ≥ this → NOMINAL
    warnMin: 0.70, // below this → WARNING; between warnMin and nominalMin → CAUTION
  },
  frequency: {
    warnDev: 0.2, // Hz deviation from 50 → WARNING
    criticalDev: 0.5, // Hz deviation from 50 → CRITICAL
  },
  powerSpike: 1800, // W — breach triggers an event-log entry
};

// Physical limits the modal will clamp inputs into.
const THRESHOLD_LIMITS = {
  voltage: { min: 50, max: 400, step: 1 },
  current: { min: 0.1, max: 200, step: 0.1 },
  powerFactor: { min: 0, max: 1, step: 0.01 },
  frequency: { min: 0.01, max: 5, step: 0.01 },
  powerSpike: { min: 10, max: 50000, step: 10 },
};

/* ------------------------------------------------------------------ */
/*  Status helpers — pure functions of value + thresholds              */
/* ------------------------------------------------------------------ */
const getVoltageStatus = (v, t) => {
  const { warnMin, warnMax, criticalMin, criticalMax } = t.voltage;
  if (v < criticalMin || v > criticalMax) return "critical";
  if (v < warnMin || v > warnMax) return "warning";
  return "nominal";
};

const getCurrentStatus = (a, t) => {
  if (a > t.current.critical) return "critical";
  if (a > t.current.warn) return "warning";
  return "nominal";
};

const getPowerFactorStatus = (pf, current, t) => {
  if (current < 0.05) return "idle";
  if (pf < t.powerFactor.warnMin) return "warning";
  if (pf < t.powerFactor.nominalMin) return "caution";
  return "nominal";
};

const getFrequencyStatus = (f, t) => {
  const dev = Math.abs(f - 50);
  if (dev > t.frequency.criticalDev) return "critical";
  if (dev > t.frequency.warnDev) return "warning";
  return "nominal";
};

const STATUS = {
  nominal: {
    border: "border-l-emerald-500",
    text: "text-emerald-400",
    bg: "bg-emerald-500/10",
    ring: "ring-emerald-500/20",
    dot: "bg-emerald-500",
    label: "NOMINAL",
  },
  caution: {
    border: "border-l-yellow-500",
    text: "text-yellow-400",
    bg: "bg-yellow-500/10",
    ring: "ring-yellow-500/20",
    dot: "bg-yellow-500",
    label: "CAUTION",
  },
  warning: {
    border: "border-l-amber-500",
    text: "text-amber-400",
    bg: "bg-amber-500/10",
    ring: "ring-amber-500/20",
    dot: "bg-amber-500",
    label: "WARNING",
  },
  critical: {
    border: "border-l-red-500",
    text: "text-red-400",
    bg: "bg-red-500/10",
    ring: "ring-red-500/20",
    dot: "bg-red-500",
    label: "CRITICAL",
  },
  idle: {
    border: "border-l-slate-600",
    text: "text-slate-400",
    bg: "bg-slate-500/10",
    ring: "ring-slate-500/20",
    dot: "bg-slate-500",
    label: "IDLE",
  },
};

const formatUptime = (sec) => {
  const h = Math.floor(sec / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((sec % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}:${s}`;
};

/* ------------------------------------------------------------------ */
/*  Decorative corner brackets                                         */
/* ------------------------------------------------------------------ */
const CornerBrackets = () => (
  <>
    <div className="pointer-events-none absolute top-0 left-0 w-2.5 h-2.5 border-t border-l border-slate-600" />
    <div className="pointer-events-none absolute top-0 right-0 w-2.5 h-2.5 border-t border-r border-slate-600" />
    <div className="pointer-events-none absolute bottom-0 left-0 w-2.5 h-2.5 border-b border-l border-slate-600" />
    <div className="pointer-events-none absolute bottom-0 right-0 w-2.5 h-2.5 border-b border-r border-slate-600" />
  </>
);

/* ------------------------------------------------------------------ */
/*  Online badge                                                       */
/* ------------------------------------------------------------------ */
const OnlineBadge = () => (
  <div className="flex items-center gap-2.5 px-3 py-1.5 border border-emerald-500/40 bg-emerald-500/5 rounded-sm">
    <div className="relative flex items-center justify-center">
      <div className="w-2 h-2 bg-emerald-400 rounded-full shadow-lg shadow-emerald-500/60" />
      <div className="absolute inset-0 w-2 h-2 bg-emerald-400 rounded-full animate-ping opacity-75" />
    </div>
    <span className="text-[11px] font-mono tracking-[0.25em] text-emerald-400 font-medium">
      SYSTEM ONLINE
    </span>
  </div>
);

/* ------------------------------------------------------------------ */
/*  Mini sparkline                                                     */
/* ------------------------------------------------------------------ */
const Sparkline = ({ data, dataKey, color }) => {
  if (!data.length) return <div className="h-8" />;
  const values = data.map((d) => d[dataKey]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = 120;
  const height = 32;
  const step = width / Math.max(data.length - 1, 1);

  const points = values
    .map((v, i) => `${i * step},${height - ((v - min) / range) * height}`)
    .join(" ");

  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
        opacity="0.85"
      />
    </svg>
  );
};

/* ------------------------------------------------------------------ */
/*  KPI Card                                                           */
/* ------------------------------------------------------------------ */
const KpiCard = ({
  icon: Icon,
  label,
  code,
  value,
  unit,
  precision = 2,
  status,
  range,
  history,
  dataKey,
  sparkColor,
}) => {
  const s = STATUS[status];
  return (
    <div
      className={`relative bg-slate-900/60 backdrop-blur-sm border border-slate-800 border-l-[3px] ${s.border} rounded-sm p-5 overflow-hidden transition-colors duration-300 hover:bg-slate-900/80`}
    >
      <CornerBrackets />

      {/* header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${s.text}`} strokeWidth={1.5} />
          <div>
            <div className="text-[11px] font-mono tracking-[0.2em] text-slate-300 uppercase leading-tight">
              {label}
            </div>
            <div className="text-[9px] font-mono tracking-[0.3em] text-slate-600 leading-tight mt-0.5">
              {code}
            </div>
          </div>
        </div>
        <div
          className={`flex items-center gap-1.5 px-2 py-0.5 ${s.bg} ring-1 ${s.ring} rounded-sm`}
        >
          <div
            className={`w-1.5 h-1.5 ${s.dot} rounded-full ${status !== "nominal" && status !== "idle" ? "animate-pulse" : ""
              }`}
          />
          <span
            className={`text-[9px] font-mono tracking-[0.2em] ${s.text} font-medium`}
          >
            {s.label}
          </span>
        </div>
      </div>

      {/* value */}
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-4xl font-mono tabular-nums font-light text-slate-50 tracking-tight">
          {value.toFixed(precision)}
        </span>
        <span className="text-sm font-mono text-slate-500 tracking-wider">
          {unit}
        </span>
      </div>

      {/* sparkline + range */}
      <div className="flex items-end justify-between">
        <div className="text-[9px] font-mono text-slate-600 tracking-[0.15em] uppercase leading-relaxed">
          <div>NOM RANGE</div>
          <div className="text-slate-500">{range}</div>
        </div>
        <Sparkline data={history} dataKey={dataKey} color={sparkColor} />
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Frequency gauge (analog-style bar)                                */
/* ------------------------------------------------------------------ */
const FrequencyGauge = ({ value, thresholds }) => {
  // Map 49..51 Hz → 0..100%
  const pct = Math.max(0, Math.min(100, ((value - 49) / 2) * 100));
  const status = getFrequencyStatus(value, thresholds);
  const s = STATUS[status];

  return (
    <div className="space-y-3">
      <div className="relative h-14 bg-slate-950/80 border border-slate-800 rounded-sm overflow-hidden">
        {/* green zone 49.8–50.2 */}
        <div
          className="absolute inset-y-0 bg-emerald-500/10 border-x border-emerald-500/20"
          style={{ left: "40%", width: "20%" }}
        />
        {/* amber zones */}
        <div
          className="absolute inset-y-0 bg-amber-500/5"
          style={{ left: "25%", width: "15%" }}
        />
        <div
          className="absolute inset-y-0 bg-amber-500/5"
          style={{ left: "60%", width: "15%" }}
        />

        {/* tick marks */}
        {[0, 25, 50, 75, 100].map((p) => (
          <div
            key={p}
            className="absolute top-0 bottom-0 w-px bg-slate-700"
            style={{ left: `${p}%` }}
          />
        ))}

        {/* center reference 50Hz */}
        <div className="absolute top-0 bottom-0 w-px bg-slate-500" style={{ left: "50%" }} />

        {/* indicator */}
        <div
          className={`absolute top-1 bottom-1 w-0.5 ${s.dot} shadow-lg transition-all duration-500`}
          style={{
            left: `${pct}%`,
            boxShadow: "0 0 8px currentColor",
          }}
        />
      </div>

      <div className="flex justify-between text-[9px] font-mono text-slate-600 tracking-widest">
        <span>49.0</span>
        <span>49.5</span>
        <span className="text-slate-400">50.0</span>
        <span>50.5</span>
        <span>51.0</span>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Custom tooltip for main chart                                      */
/* ------------------------------------------------------------------ */
const ChartTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-slate-950/95 backdrop-blur border border-slate-700 px-3 py-2.5 rounded-sm shadow-2xl">
      <div className="text-[10px] font-mono tracking-[0.2em] text-slate-500 mb-2 pb-2 border-b border-slate-800">
        T / {d.time}
      </div>
      <div className="space-y-1.5 font-mono text-xs">
        <div className="flex justify-between gap-6">
          <span className="text-slate-400 tracking-wider text-[10px]">POWER</span>
          <span className="text-cyan-400 tabular-nums">
            {d.power_W.toFixed(2)} W
          </span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-slate-400 tracking-wider text-[10px]">VOLTS</span>
          <span className="text-slate-200 tabular-nums">
            {d.voltage_V.toFixed(2)} V
          </span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-slate-400 tracking-wider text-[10px]">CURR</span>
          <span className="text-slate-200 tabular-nums">
            {d.current_A.toFixed(3)} A
          </span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-slate-400 tracking-wider text-[10px]">P.F.</span>
          <span className="text-slate-200 tabular-nums">
            {d.power_factor.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Threshold configuration modal                                      */
/* ------------------------------------------------------------------ */
const InputField = ({ label, unit, value, onChange, limits, widthClass = "w-full" }) => (
  <div className={widthClass}>
    <label className="block text-[9px] font-mono tracking-[0.25em] text-slate-500 uppercase mb-1.5">
      {label}
      {unit && <span className="ml-1 text-slate-600 normal-case tracking-normal">[{unit}]</span>}
    </label>
    <div className="relative">
      <input
        type="number"
        inputMode="decimal"
        value={value}
        min={limits.min}
        max={limits.max}
        step={limits.step}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-slate-950 border border-slate-700 text-slate-100 font-mono tabular-nums text-sm px-3 py-2 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30 transition-colors rounded-none appearance-none"
        style={{
          // Kill the browser's built-in number spinners — we want a clean terminal look.
          MozAppearance: "textfield",
        }}
      />
      <span className="absolute inset-y-0 right-3 flex items-center text-[9px] font-mono tracking-[0.25em] text-slate-600 pointer-events-none">
        {unit}
      </span>
    </div>
  </div>
);

const FieldGroup = ({ title, code, children }) => (
  <div className="relative border border-slate-800 bg-slate-950/40 p-4">
    <div className="absolute -top-2 left-3 bg-slate-900 px-2">
      <div className="flex items-center gap-2">
        <div className="w-1 h-1 bg-cyan-400" />
        <span className="text-[10px] font-mono tracking-[0.3em] text-cyan-400 uppercase">
          {title}
        </span>
        {code && (
          <span className="text-[9px] font-mono tracking-[0.25em] text-slate-600">
            // {code}
          </span>
        )}
      </div>
    </div>
    <div className="pt-2">{children}</div>
  </div>
);

const ThresholdModal = ({ open, current, onSave, onCancel }) => {
  const [draft, setDraft] = useState(current);

  // Re-seed the draft every time the modal re-opens, so cancelled edits don't persist.
  useEffect(() => {
    if (open) setDraft(current);
  }, [open, current]);

  // ESC to cancel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const setV = (path, raw) => {
    const num = raw === "" ? "" : Number(raw);
    setDraft((prev) => {
      const next = structuredClone(prev);
      const segs = path.split(".");
      let ref = next;
      for (let i = 0; i < segs.length - 1; i++) ref = ref[segs[i]];
      ref[segs[segs.length - 1]] = num;
      return next;
    });
  };

  // Basic coherence validation — prevents "min > max" style nonsense.
  const errors = [];
  if (draft.voltage.warnMin >= draft.voltage.warnMax)
    errors.push("Voltage WARN min must be less than WARN max");
  if (draft.voltage.criticalMin >= draft.voltage.warnMin)
    errors.push("Voltage CRITICAL min must be less than WARN min");
  if (draft.voltage.criticalMax <= draft.voltage.warnMax)
    errors.push("Voltage CRITICAL max must be greater than WARN max");
  if (draft.current.warn >= draft.current.critical)
    errors.push("Current WARN must be less than CRITICAL");
  if (draft.powerFactor.warnMin >= draft.powerFactor.nominalMin)
    errors.push("Power factor WARN min must be less than NOMINAL min");
  if (draft.frequency.warnDev >= draft.frequency.criticalDev)
    errors.push("Frequency WARN deviation must be less than CRITICAL");

  const canSave = errors.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-md bg-slate-950/80 animate-in fade-in"
      onMouseDown={(e) => {
        // Click outside the modal box = cancel. But only on the backdrop itself.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-slate-900 border border-cyan-500/40 shadow-2xl shadow-cyan-500/10"
        role="dialog"
        aria-modal="true"
        aria-labelledby="threshold-modal-title"
      >
        {/* Corner brackets */}
        <div className="pointer-events-none absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-cyan-400" />
        <div className="pointer-events-none absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-cyan-400" />
        <div className="pointer-events-none absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-cyan-400" />
        <div className="pointer-events-none absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-cyan-400" />

        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-slate-800 bg-slate-950/40">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 flex items-center justify-center border border-cyan-500/30 bg-cyan-500/5">
              <Settings className="w-4 h-4 text-cyan-400" strokeWidth={1.5} />
            </div>
            <div>
              <div className="text-[10px] font-mono tracking-[0.3em] text-slate-500 uppercase">
                /// Operator Console
              </div>
              <div
                id="threshold-modal-title"
                className="text-sm font-mono font-medium text-slate-100 tracking-[0.15em]"
              >
                ALARM THRESHOLD CONFIGURATION
              </div>
            </div>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <X className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* Voltage */}
          <FieldGroup title="Voltage Limits" code="CH.01 RMS">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <InputField
                label="Warn Min"
                unit="V"
                value={draft.voltage.warnMin}
                onChange={(v) => setV("voltage.warnMin", v)}
                limits={THRESHOLD_LIMITS.voltage}
              />
              <InputField
                label="Warn Max"
                unit="V"
                value={draft.voltage.warnMax}
                onChange={(v) => setV("voltage.warnMax", v)}
                limits={THRESHOLD_LIMITS.voltage}
              />
              <InputField
                label="Crit Min"
                unit="V"
                value={draft.voltage.criticalMin}
                onChange={(v) => setV("voltage.criticalMin", v)}
                limits={THRESHOLD_LIMITS.voltage}
              />
              <InputField
                label="Crit Max"
                unit="V"
                value={draft.voltage.criticalMax}
                onChange={(v) => setV("voltage.criticalMax", v)}
                limits={THRESHOLD_LIMITS.voltage}
              />
            </div>
          </FieldGroup>

          {/* Current */}
          <FieldGroup title="Current Limits" code="CH.01 RMS">
            <div className="grid grid-cols-2 gap-4">
              <InputField
                label="Warn Above"
                unit="A"
                value={draft.current.warn}
                onChange={(v) => setV("current.warn", v)}
                limits={THRESHOLD_LIMITS.current}
              />
              <InputField
                label="Critical Above"
                unit="A"
                value={draft.current.critical}
                onChange={(v) => setV("current.critical", v)}
                limits={THRESHOLD_LIMITS.current}
              />
            </div>
          </FieldGroup>

          {/* Power Factor + Power Spike */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <FieldGroup title="Power Factor" code="cosφ">
              <div className="grid grid-cols-2 gap-4">
                <InputField
                  label="Warn Below"
                  unit="pf"
                  value={draft.powerFactor.warnMin}
                  onChange={(v) => setV("powerFactor.warnMin", v)}
                  limits={THRESHOLD_LIMITS.powerFactor}
                />
                <InputField
                  label="Nominal Min"
                  unit="pf"
                  value={draft.powerFactor.nominalMin}
                  onChange={(v) => setV("powerFactor.nominalMin", v)}
                  limits={THRESHOLD_LIMITS.powerFactor}
                />
              </div>
            </FieldGroup>

            <FieldGroup title="Power Spike" code="Event Log">
              <InputField
                label="Log Above"
                unit="W"
                value={draft.powerSpike}
                onChange={(v) => setV("powerSpike", v)}
                limits={THRESHOLD_LIMITS.powerSpike}
              />
            </FieldGroup>
          </div>

          {/* Frequency */}
          <FieldGroup title="Frequency Deviation" code="|f − 50 Hz|">
            <div className="grid grid-cols-2 gap-4">
              <InputField
                label="Warn ± Dev"
                unit="Hz"
                value={draft.frequency.warnDev}
                onChange={(v) => setV("frequency.warnDev", v)}
                limits={THRESHOLD_LIMITS.frequency}
              />
              <InputField
                label="Critical ± Dev"
                unit="Hz"
                value={draft.frequency.criticalDev}
                onChange={(v) => setV("frequency.criticalDev", v)}
                limits={THRESHOLD_LIMITS.frequency}
              />
            </div>
          </FieldGroup>

          {/* Validation errors */}
          {errors.length > 0 && (
            <div className="border border-red-500/40 bg-red-500/5 p-3 space-y-1">
              <div className="flex items-center gap-2 text-[10px] font-mono tracking-[0.25em] text-red-400">
                <TriangleAlert className="w-3.5 h-3.5" strokeWidth={1.75} />
                VALIDATION ERRORS
              </div>
              {errors.map((e, i) => (
                <div key={i} className="text-[11px] font-mono text-red-300 pl-5">
                  • {e}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer / Actions */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 px-6 py-4 border-t border-slate-800 bg-slate-950/40">
          <button
            onClick={() => setDraft(DEFAULT_THRESHOLDS)}
            className="flex items-center justify-center gap-2 px-4 py-2 border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-[11px] font-mono tracking-[0.25em] transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.75} />
            RESET DEFAULTS
          </button>

          <div className="flex items-center gap-3">
            <button
              onClick={onCancel}
              className="px-5 py-2 border border-slate-700 bg-transparent hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-[11px] font-mono tracking-[0.3em] transition-colors"
            >
              CANCEL
            </button>
            <button
              onClick={() => canSave && onSave(draft)}
              disabled={!canSave}
              className="flex items-center gap-2 px-5 py-2 bg-cyan-500/10 border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/20 hover:border-cyan-400 hover:text-cyan-200 disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-mono tracking-[0.3em] transition-colors shadow-[inset_0_0_12px_rgba(34,211,238,0.1)]"
            >
              <Save className="w-3.5 h-3.5" strokeWidth={1.75} />
              SAVE CONFIG
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ================================================================== */
/*  MAIN COMPONENT                                                    */
/* ================================================================== */
export default function PowerMonitoringDashboard() {
  const [currentData, setCurrentData] = useState({
    device: "esp32_pzem_01",
    voltage_V: 236.4,
    current_A: 0.0,
    power_W: 0.0,
    energy_Wh: 0.0,
    frequency_Hz: 50.0,
    power_factor: 0.0,
  });
  const [history, setHistory] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [uptime, setUptime] = useState(0);
  const [packetCount, setPacketCount] = useState(0);
  const [logs, setLogs] = useState([]);
  const [range, setRange] = useState("5M");
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // AI Insights
  const [insight, setInsight] = useState(null);
  const [insightError, setInsightError] = useState(null);
  const [insightRefreshing, setInsightRefreshing] = useState(false);
  const [insightConfig, setInsightConfig] = useState({
    enabled: false,
    model: null,
    intervalMinutes: null,
  });
  const [nowTick, setNowTick] = useState(Date.now()); // drives the "next run" countdown
  const energyRef = useRef(0);
  const prevStatusRef = useRef({ voltage: "nominal", powerSpike: false, mqtt: "disconnected" });
  // Keep the latest `range` accessible inside the socket handler's stable closure.
  const rangeRef = useRef(range);
  useEffect(() => { rangeRef.current = range; }, [range]);
  // Same trick for thresholds — the socket handler needs the latest limits.
  const thresholdsRef = useRef(thresholds);
  useEffect(() => { thresholdsRef.current = thresholds; }, [thresholds]);

  /* -------- Append a log entry (newest first, cap at 200) -------- */
  const pushLog = (level, message) => {
    setLogs((prev) => {
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ts: new Date(),
        level,
        message,
      };
      return [entry, ...prev].slice(0, 200);
    });
  };

  /* -------- (A) Refetch history whenever `range` changes -------- */
  useEffect(() => {
    let cancelled = false;

    fetch(`${API_BASE}/api/history?range=${range}&device=esp32_pzem_01`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(({ history, count }) => {
        if (cancelled || !history) return;
        setHistory(history);
        if (history.length) {
          const latest = history[history.length - 1];
          setCurrentData({
            device: latest.device,
            voltage_V: latest.voltage_V,
            current_A: latest.current_A,
            power_W: latest.power_W,
            energy_Wh: latest.energy_Wh,
            frequency_Hz: latest.frequency_Hz,
            power_factor: latest.power_factor,
          });
          energyRef.current = latest.energy_Wh;
          setLastUpdate(new Date(latest.timestamp));
        }
        pushLog(
          "INFO",
          `Loaded ${count} samples for ${RANGE_OPTIONS.find((o) => o.key === range)?.description
          } window`
        );
      })
      .catch((err) => {
        console.error("[API] history load failed:", err.message);
        pushLog("WARN", `History fetch failed: ${err.message}`);
      });

    return () => {
      cancelled = true;
    };
  }, [range]);

  /* -------- (B) Open the live Socket.io stream (runs once) -------- */
  useEffect(() => {
    pushLog("SYSTEM", "Dashboard session started — opening live stream…");
    const socket = ioClient(API_BASE, { transports: ["websocket"] });

    socket.on("connect", () => {
      console.log("[WS] Connected:", socket.id);
      if (prevStatusRef.current.mqtt !== "connected") {
        pushLog("INFO", `MQTT uplink established — session ${socket.id.slice(0, 8)}`);
        prevStatusRef.current.mqtt = "connected";
      }
    });
    socket.on("disconnect", (reason) => {
      console.warn("[WS] Disconnected:", reason);
      pushLog("WARN", `MQTT uplink lost — ${reason}`);
      prevStatusRef.current.mqtt = "disconnected";
    });
    socket.on("connect_error", (err) => {
      console.error("[WS] Connect error:", err.message);
      pushLog("CRITICAL", `Connection error: ${err.message}`);
    });

    // --- AI Insights stream ---
    socket.on("ai-insight", (payload) => {
      setInsight(payload);
      setInsightError(null);
      setInsightRefreshing(false);
      pushLog(
        "INFO",
        `AI analysis updated — ${payload.anomalies.length} anomaly, ` +
        `${payload.trends.length} trend, ${payload.tips.length} tip`
      );
    });
    socket.on("ai-insight-error", (payload) => {
      setInsightError(payload);
      setInsightRefreshing(false);
      pushLog("WARN", `AI analysis failed: ${payload.error}`);
    });

    socket.on("telemetry", (packet) => {
      const T = thresholdsRef.current;

      // --- Voltage transition logging ---
      const vNext = getVoltageStatus(packet.voltage_V, T);
      const vPrev = prevStatusRef.current.voltage;
      if (vNext !== vPrev) {
        if (vNext === "warning") {
          pushLog(
            "WARN",
            `Voltage out of nominal: ${packet.voltage_V.toFixed(1)} V ` +
            `(limits ${T.voltage.warnMin}–${T.voltage.warnMax} V)`
          );
        } else if (vNext === "critical") {
          pushLog(
            "CRITICAL",
            `Voltage critical: ${packet.voltage_V.toFixed(1)} V — ` +
            `outside ${T.voltage.criticalMin}–${T.voltage.criticalMax} V`
          );
        } else if (vPrev !== "nominal") {
          pushLog(
            "INFO",
            `Voltage recovered to nominal (${packet.voltage_V.toFixed(1)} V)`
          );
        }
        prevStatusRef.current.voltage = vNext;
      }

      // --- Power spike edge-trigger ---
      const spikeThreshold = T.powerSpike;
      if (packet.power_W > spikeThreshold && !prevStatusRef.current.powerSpike) {
        pushLog(
          "WARN",
          `Power spike: ${packet.power_W.toFixed(0)} W exceeds ${spikeThreshold} W threshold`
        );
        prevStatusRef.current.powerSpike = true;
      } else if (packet.power_W < spikeThreshold * 0.85) {
        prevStatusRef.current.powerSpike = false;
      }

      // Always update the live KPI row.
      setCurrentData({
        device: packet.device,
        voltage_V: packet.voltage_V,
        current_A: packet.current_A,
        power_W: packet.power_W,
        energy_Wh: packet.energy_Wh,
        frequency_Hz: packet.frequency_Hz,
        power_factor: packet.power_factor,
      });
      energyRef.current = packet.energy_Wh;
      setLastUpdate(new Date(packet.timestamp));
      setPacketCount((c) => c + 1);

      // Only append to the chart when we're looking at the live (5M) window.
      // Historical views stay as static snapshots until the user flips back to 5M.
      if (rangeRef.current === "5M") {
        setHistory((prev) => [...prev, packet].slice(-RANGE_SAMPLE_CAPS["5M"]));
      }
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  /* -------- Uptime ticker -------- */
  useEffect(() => {
    const i = setInterval(() => setUptime((u) => u + 1), 1000);
    return () => clearInterval(i);
  }, []);

  /* -------- AI insights: hydrate cached result + 1 Hz countdown tick -------- */
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/insights`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setInsightConfig({
          enabled: Boolean(data.enabled),
          model: data.model || null,
          intervalMinutes: data.intervalMinutes || null,
        });
        if (data.insight) setInsight(data.insight);
        if (data.error) setInsightError(data.error);
      })
      .catch((err) => console.error("[AI] initial fetch failed:", err.message));

    const tick = setInterval(() => setNowTick(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, []);

  /* -------- AI insights: manual refresh handler -------- */
  const runInsightNow = async () => {
    if (insightRefreshing) return;
    setInsightRefreshing(true);
    setInsightError(null);
    pushLog("SYSTEM", "Manual AI analysis triggered");
    try {
      const r = await fetch(`${API_BASE}/api/insights/run`, { method: "POST" });
      const data = await r.json();
      if (!data.ok && data.reason !== "already_running") {
        setInsightRefreshing(false);
        setInsightError({
          error: data.error || data.reason,
          generatedAt: new Date().toISOString(),
        });
        pushLog("WARN", `AI analysis could not run: ${data.reason}`);
      }
      // On success, the socket 'ai-insight' event will flip insightRefreshing off.
    } catch (err) {
      setInsightRefreshing(false);
      setInsightError({
        error: err.message,
        generatedAt: new Date().toISOString(),
      });
    }
  };

  const vStatus = getVoltageStatus(currentData.voltage_V, thresholds);
  const aStatus = getCurrentStatus(currentData.current_A, thresholds);
  const pStatus =
    currentData.current_A < 0.05
      ? "idle"
      : currentData.power_W > thresholds.powerSpike
        ? "warning"
        : "nominal";
  const pfStatus = getPowerFactorStatus(
    currentData.power_factor,
    currentData.current_A,
    thresholds
  );
  const fStatus = getFrequencyStatus(currentData.frequency_Hz, thresholds);

  return (
    <div
      className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-cyan-500/30"
      style={{
        backgroundImage:
          "linear-gradient(rgba(51,65,85,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(51,65,85,0.07) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
      }}
    >
      {/* ============== HEADER ============== */}
      <header className="border-b border-slate-800 bg-slate-950/70 backdrop-blur sticky top-0 z-20">
        <div className="px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="relative w-10 h-10 flex items-center justify-center border border-emerald-500/30 bg-emerald-500/5 rounded-sm">
                <Power
                  className="w-5 h-5 text-emerald-400"
                  strokeWidth={1.5}
                />
                <div className="absolute -top-px -left-px w-1.5 h-1.5 border-t border-l border-emerald-400" />
                <div className="absolute -bottom-px -right-px w-1.5 h-1.5 border-b border-r border-emerald-400" />
              </div>
              <div>
                <div className="text-[10px] font-mono tracking-[0.3em] text-slate-500">
                  PZEM-004T // v3.0 // MODBUS-RTU
                </div>
                <div className="text-base font-mono font-medium text-slate-100 tracking-[0.15em]">
                  GRIDPULSE · POWER TELEMETRY
                </div>
              </div>
            </div>

            <div className="hidden md:block h-10 w-px bg-slate-800" />

            <div className="hidden md:flex flex-col">
              <span className="text-[9px] font-mono tracking-[0.25em] text-slate-500 uppercase">
                Device Identifier
              </span>
              <span className="text-sm font-mono text-slate-200 tracking-wider">
                {currentData.device}
              </span>
            </div>

            <div className="hidden lg:block h-10 w-px bg-slate-800" />

            <div className="hidden lg:flex flex-col">
              <span className="text-[9px] font-mono tracking-[0.25em] text-slate-500 uppercase">
                Session Uptime
              </span>
              <span className="text-sm font-mono text-cyan-400 tabular-nums tracking-wider">
                {formatUptime(uptime)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <OnlineBadge />
            <div className="flex flex-col items-end">
              <span className="text-[9px] font-mono tracking-[0.25em] text-slate-500 uppercase">
                Last Update
              </span>
              <span className="text-sm font-mono text-slate-200 tabular-nums tracking-wider">
                {lastUpdate.toLocaleTimeString("en-US", { hour12: false })}
              </span>
            </div>

            {/* Export CSV */}
            <button
              onClick={() => {
                const ok = exportHistoryToCSV(history);
                if (ok) {
                  pushLog(
                    "INFO",
                    `Exported ${history.length} samples to gridpulse_export.csv`
                  );
                } else {
                  pushLog("WARN", "Export aborted — history buffer is empty");
                }
              }}
              disabled={history.length === 0}
              title={
                history.length === 0
                  ? "No data to export yet"
                  : `Export ${history.length} samples as CSV`
              }
              className="group flex items-center gap-2 px-3 py-2 border border-slate-700 bg-slate-900/60 hover:bg-cyan-500/10 hover:border-cyan-500/50 disabled:opacity-40 disabled:hover:bg-slate-900/60 disabled:hover:border-slate-700 disabled:cursor-not-allowed rounded-sm transition-colors"
            >
              <Download
                className="w-3.5 h-3.5 text-slate-400 group-hover:text-cyan-400 group-disabled:text-slate-500 transition-colors"
                strokeWidth={1.75}
              />
              <span className="text-[10px] font-mono tracking-[0.25em] text-slate-300 group-hover:text-cyan-400 group-disabled:text-slate-500 transition-colors">
                EXPORT
              </span>
            </button>

            {/* Configure thresholds */}
            <button
              onClick={() => setSettingsOpen(true)}
              title="Configure alarm thresholds"
              className="group flex items-center gap-2 px-3 py-2 border border-slate-700 bg-slate-900/60 hover:bg-cyan-500/10 hover:border-cyan-500/50 rounded-sm transition-colors"
            >
              <Settings
                className="w-3.5 h-3.5 text-slate-400 group-hover:text-cyan-400 transition-colors"
                strokeWidth={1.75}
              />
              <span className="text-[10px] font-mono tracking-[0.25em] text-slate-300 group-hover:text-cyan-400 transition-colors">
                CONFIGURE
              </span>
            </button>
          </div>
        </div>

        {/* sub-bar telemetry strip */}
        <div className="border-t border-slate-800/80 bg-slate-950/40 px-6 py-1.5 flex flex-wrap items-center gap-x-6 gap-y-1 text-[10px] font-mono tracking-[0.2em] text-slate-500">
          <span className="flex items-center gap-1.5">
            <Cpu className="w-3 h-3" strokeWidth={1.5} />
            MCU: ESP32-WROOM
          </span>
          <span className="flex items-center gap-1.5">
            <Radio className="w-3 h-3" strokeWidth={1.5} />
            MQTT: <span className="text-emerald-400">CONNECTED</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Signal className="w-3 h-3" strokeWidth={1.5} />
            PKT: <span className="text-slate-300 tabular-nums">{packetCount.toString().padStart(6, "0")}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Wifi className="w-3 h-3" strokeWidth={1.5} />
            INTERVAL: 10.00s
          </span>
          <span className="ml-auto hidden md:inline">
            TOPIC: pzem/device01/telemetry
          </span>
        </div>
      </header>

      {/* ============== MAIN CONTENT ============== */}
      <main className="px-6 py-6 max-w-[1600px] mx-auto space-y-6">
        {/* Section title */}
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-gradient-to-r from-slate-800 to-transparent" />
          <span className="text-[10px] font-mono tracking-[0.3em] text-slate-500">
            /// LIVE PARAMETERS
          </span>
          <div className="h-px w-16 bg-slate-800" />
        </div>

        {/* KPI GRID */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            icon={Zap}
            label="Voltage"
            code="CH.01 / RMS"
            value={currentData.voltage_V}
            unit="V"
            precision={2}
            status={vStatus}
            range="220 – 245 V"
            history={history}
            dataKey="voltage_V"
            sparkColor="#fbbf24"
          />
          <KpiCard
            icon={Activity}
            label="Current"
            code="CH.01 / RMS"
            value={currentData.current_A}
            unit="A"
            precision={3}
            status={aStatus}
            range="0 – 7 A"
            history={history}
            dataKey="current_A"
            sparkColor="#22d3ee"
          />
          <KpiCard
            icon={Gauge}
            label="Active Power"
            code="P = V·I·cosφ"
            value={currentData.power_W}
            unit="W"
            precision={2}
            status={pStatus}
            range="0 – 1800 W"
            history={history}
            dataKey="power_W"
            sparkColor="#a78bfa"
          />
          <KpiCard
            icon={TrendingUp}
            label="Power Factor"
            code="cosφ"
            value={currentData.power_factor}
            unit=""
            precision={2}
            status={pfStatus}
            range="0.85 – 1.00"
            history={history}
            dataKey="power_factor"
            sparkColor="#34d399"
          />
        </div>

        {/* ============== CHART ============== */}
        <div className="flex items-center gap-3 pt-2">
          <div className="h-px flex-1 bg-gradient-to-r from-slate-800 to-transparent" />
          <span className="text-[10px] font-mono tracking-[0.3em] text-slate-500">
            /// ACTIVE POWER TREND
          </span>
          <div className="h-px w-16 bg-slate-800" />
        </div>

        <div className="relative bg-slate-900/50 backdrop-blur-sm border border-slate-800 rounded-sm p-5 overflow-hidden">
          <CornerBrackets />

          <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
            <div className="flex items-center gap-3">
              <TrendingUp
                className="w-4 h-4 text-cyan-400"
                strokeWidth={1.5}
              />
              <div>
                <div className="text-xs font-mono tracking-[0.25em] text-slate-200">
                  P(t) // ACTIVE POWER
                </div>
                <div className="text-[10px] font-mono tracking-[0.2em] text-slate-600 mt-0.5">
                  WINDOW:{" "}
                  {RANGE_OPTIONS.find((o) => o.key === range)?.description.toUpperCase()}
                  {" "}// SAMPLE: 10 s
                </div>
              </div>
            </div>

            {/* ---- Historical range toggle ---- */}
            <div className="flex items-center gap-3">
              <span className="hidden sm:inline text-[9px] font-mono tracking-[0.3em] text-slate-600 uppercase">
                Range
              </span>
              <div
                role="radiogroup"
                aria-label="Historical range"
                className="flex items-center gap-0.5 p-0.5 border border-slate-700 bg-slate-950/60 rounded-sm"
              >
                {RANGE_OPTIONS.map((opt) => {
                  const active = range === opt.key;
                  return (
                    <button
                      key={opt.key}
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        setRange(opt.key);
                        pushLog(
                          "SYSTEM",
                          `Chart window set to ${opt.description}`
                        );
                      }}
                      className={`px-2.5 py-1 text-[10px] font-mono tracking-[0.2em] rounded-sm transition-all duration-150 ${active
                        ? "bg-cyan-500/10 text-cyan-400 ring-1 ring-cyan-500/40 shadow-[inset_0_0_8px_rgba(34,211,238,0.15)]"
                        : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/50"
                        }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ---- Secondary strip: legend + sample count ---- */}
          <div className="flex items-center justify-between gap-4 text-[10px] font-mono tracking-[0.2em] text-slate-500 mb-3 pb-3 border-b border-slate-800/60">
            <div className="flex items-center gap-2">
              <div className="w-3 h-0.5 bg-cyan-400" />
              <span>POWER [W]</span>
            </div>
            <div>
              SAMPLES:{" "}
              <span className="text-slate-300 tabular-nums">
                {history.length.toString().padStart(3, "0")}
              </span>
              {" / "}
              {RANGE_SAMPLE_CAPS[range].toString().padStart(3, "0")}
            </div>
          </div>

          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={history}
                margin={{ top: 10, right: 16, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="powerGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.55} />
                    <stop offset="50%" stopColor="#22d3ee" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  stroke="#1e293b"
                  strokeDasharray="2 4"
                  vertical={false}
                />
                <XAxis
                  dataKey="time"
                  stroke="#475569"
                  tick={{
                    fontSize: 10,
                    fontFamily: "ui-monospace, monospace",
                    fill: "#64748b",
                  }}
                  tickLine={false}
                  axisLine={{ stroke: "#1e293b" }}
                  minTickGap={30}
                />
                <YAxis
                  stroke="#475569"
                  tick={{
                    fontSize: 10,
                    fontFamily: "ui-monospace, monospace",
                    fill: "#64748b",
                  }}
                  tickLine={false}
                  axisLine={{ stroke: "#1e293b" }}
                  width={50}
                  tickFormatter={(v) => `${v.toFixed(0)}`}
                />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{
                    stroke: "#22d3ee",
                    strokeWidth: 1,
                    strokeDasharray: "3 3",
                  }}
                />
                <ReferenceLine
                  y={0}
                  stroke="#334155"
                  strokeDasharray="1 2"
                />
                <Area
                  type="monotone"
                  dataKey="power_W"
                  stroke="#22d3ee"
                  strokeWidth={1.5}
                  fill="url(#powerGrad)"
                  isAnimationActive={false}
                  dot={false}
                  activeDot={{
                    r: 4,
                    fill: "#0891b2",
                    stroke: "#22d3ee",
                    strokeWidth: 1.5,
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* ============== BOTTOM CARDS ============== */}
        <div className="flex items-center gap-3 pt-2">
          <div className="h-px flex-1 bg-gradient-to-r from-slate-800 to-transparent" />
          <span className="text-[10px] font-mono tracking-[0.3em] text-slate-500">
            /// AUXILIARY CHANNELS
          </span>
          <div className="h-px w-16 bg-slate-800" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Cumulative Energy */}
          <div className="relative bg-slate-900/60 backdrop-blur-sm border border-slate-800 border-l-[3px] border-l-cyan-500 rounded-sm p-6 overflow-hidden">
            <CornerBrackets />

            <div className="flex items-start justify-between mb-5">
              <div className="flex items-center gap-2">
                <BatteryCharging
                  className="w-4 h-4 text-cyan-400"
                  strokeWidth={1.5}
                />
                <div>
                  <div className="text-[11px] font-mono tracking-[0.2em] text-slate-300 uppercase leading-tight">
                    Cumulative Energy
                  </div>
                  <div className="text-[9px] font-mono tracking-[0.3em] text-slate-600 leading-tight mt-0.5">
                    ∫ P(t) dt
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 px-2 py-0.5 bg-cyan-500/10 ring-1 ring-cyan-500/20 rounded-sm">
                <div className="w-1.5 h-1.5 bg-cyan-400 rounded-full" />
                <span className="text-[9px] font-mono tracking-[0.2em] text-cyan-400 font-medium">
                  ACCUMULATING
                </span>
              </div>
            </div>

            <div className="flex items-baseline gap-3 mb-4">
              <span className="text-5xl font-mono tabular-nums font-light text-slate-50 tracking-tight">
                {currentData.energy_Wh.toFixed(2)}
              </span>
              <span className="text-base font-mono text-slate-500 tracking-wider">
                Wh
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3 pt-3 border-t border-slate-800">
              <div>
                <div className="text-[9px] font-mono tracking-[0.2em] text-slate-600 uppercase mb-1">
                  kWh
                </div>
                <div className="text-sm font-mono tabular-nums text-slate-300">
                  {(currentData.energy_Wh / 1000).toFixed(4)}
                </div>
              </div>
              <div>
                <div className="text-[9px] font-mono tracking-[0.2em] text-slate-600 uppercase mb-1">
                  Cost*
                </div>
                <div className="text-sm font-mono tabular-nums text-slate-300">
                  ₹{((currentData.energy_Wh / 1000) * 8.5).toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-[9px] font-mono tracking-[0.2em] text-slate-600 uppercase mb-1">
                  CO₂
                </div>
                <div className="text-sm font-mono tabular-nums text-slate-300">
                  {((currentData.energy_Wh / 1000) * 0.82).toFixed(3)} kg
                </div>
              </div>
            </div>
          </div>

          {/* Frequency */}
          <div
            className={`relative bg-slate-900/60 backdrop-blur-sm border border-slate-800 border-l-[3px] ${STATUS[fStatus].border} rounded-sm p-6 overflow-hidden`}
          >
            <CornerBrackets />

            <div className="flex items-start justify-between mb-5">
              <div className="flex items-center gap-2">
                <Waves
                  className={`w-4 h-4 ${STATUS[fStatus].text}`}
                  strokeWidth={1.5}
                />
                <div>
                  <div className="text-[11px] font-mono tracking-[0.2em] text-slate-300 uppercase leading-tight">
                    Mains Frequency
                  </div>
                  <div className="text-[9px] font-mono tracking-[0.3em] text-slate-600 leading-tight mt-0.5">
                    GRID / 50 Hz REF
                  </div>
                </div>
              </div>
              <div
                className={`flex items-center gap-1.5 px-2 py-0.5 ${STATUS[fStatus].bg} ring-1 ${STATUS[fStatus].ring} rounded-sm`}
              >
                <div
                  className={`w-1.5 h-1.5 ${STATUS[fStatus].dot} rounded-full ${fStatus !== "nominal" ? "animate-pulse" : ""
                    }`}
                />
                <span
                  className={`text-[9px] font-mono tracking-[0.2em] ${STATUS[fStatus].text} font-medium`}
                >
                  {STATUS[fStatus].label}
                </span>
              </div>
            </div>

            <div className="flex items-baseline gap-3 mb-5">
              <span className="text-5xl font-mono tabular-nums font-light text-slate-50 tracking-tight">
                {currentData.frequency_Hz.toFixed(2)}
              </span>
              <span className="text-base font-mono text-slate-500 tracking-wider">
                Hz
              </span>
              <span
                className={`text-xs font-mono tabular-nums ml-auto ${STATUS[fStatus].text}`}
              >
                {currentData.frequency_Hz - 50 >= 0 ? "+" : ""}
                {(currentData.frequency_Hz - 50).toFixed(3)} Δ
              </span>
            </div>

            <FrequencyGauge value={currentData.frequency_Hz} thresholds={thresholds} />
          </div>
        </div>

        {/* ============== AI OPERATIONAL INSIGHTS ============== */}
        <div className="flex items-center gap-3 pt-2">
          <div className="h-px flex-1 bg-gradient-to-r from-slate-800 to-transparent" />
          <span className="text-[10px] font-mono tracking-[0.3em] text-slate-500">
            /// AI OPERATIONAL INSIGHTS
          </span>
          <div className="h-px w-16 bg-slate-800" />
        </div>

        <div className="relative bg-slate-900/50 backdrop-blur-sm border border-slate-800 rounded-sm overflow-hidden">
          <CornerBrackets />

          {/* Header bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-slate-800 bg-slate-950/40">
            <div className="flex items-center gap-3">
              <div
                className={`w-8 h-8 flex items-center justify-center border rounded-sm ${insightConfig.enabled
                  ? "border-violet-500/40 bg-violet-500/5"
                  : "border-slate-700 bg-slate-800/50"
                  }`}
              >
                <Sparkles
                  className={`w-4 h-4 ${insightConfig.enabled ? "text-violet-400" : "text-slate-600"
                    }`}
                  strokeWidth={1.5}
                />
              </div>
              <div>
                <div className="text-xs font-mono tracking-[0.25em] text-slate-200">
                  OPERATIONAL ANALYSIS
                </div>
                <div className="text-[10px] font-mono tracking-[0.2em] text-slate-600 mt-0.5 truncate max-w-[48ch]">
                  {insightConfig.enabled
                    ? `MODEL: ${insightConfig.model}`
                    : "MODEL: DISABLED — set OPENROUTER_API_KEY in .env"}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Countdown + last-run timestamp */}
              {insight && insightConfig.enabled && (
                <div className="hidden md:flex flex-col items-end">
                  <span className="text-[9px] font-mono tracking-[0.25em] text-slate-500 uppercase">
                    Next Cycle
                  </span>
                  <span className="text-[11px] font-mono text-slate-300 tabular-nums">
                    {(() => {
                      const next =
                        new Date(insight.generatedAt).getTime() +
                        insightConfig.intervalMinutes * 60 * 1000;
                      const delta = Math.max(0, next - nowTick);
                      const m = Math.floor(delta / 60000);
                      const s = Math.floor((delta % 60000) / 1000);
                      return `${m.toString().padStart(2, "0")}:${s
                        .toString()
                        .padStart(2, "0")}`;
                    })()}
                  </span>
                </div>
              )}

              <button
                onClick={runInsightNow}
                disabled={!insightConfig.enabled || insightRefreshing}
                className="group flex items-center gap-2 px-3 py-1.5 border border-slate-700 bg-slate-900/60 hover:bg-violet-500/10 hover:border-violet-500/50 disabled:opacity-40 disabled:hover:bg-slate-900/60 disabled:hover:border-slate-700 disabled:cursor-not-allowed rounded-sm transition-colors"
                title={
                  !insightConfig.enabled
                    ? "AI is disabled"
                    : insightRefreshing
                      ? "Analysis in progress"
                      : "Run analysis now"
                }
              >
                <RefreshCw
                  className={`w-3 h-3 text-slate-400 group-hover:text-violet-400 group-disabled:text-slate-500 transition-colors ${insightRefreshing ? "animate-spin" : ""
                    }`}
                  strokeWidth={1.75}
                />
                <span className="text-[10px] font-mono tracking-[0.25em] text-slate-300 group-hover:text-violet-400 group-disabled:text-slate-500 transition-colors">
                  {insightRefreshing ? "ANALYZING" : "RE-RUN"}
                </span>
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="p-5 min-h-[200px]">
            {!insightConfig.enabled ? (
              <div className="flex flex-col items-center justify-center h-[200px] gap-2 text-slate-600">
                <Sparkles className="w-6 h-6" strokeWidth={1.25} />
                <div className="text-[11px] font-mono tracking-[0.2em]">
                  AI ANALYSIS DISABLED
                </div>
                <div className="text-[10px] font-mono text-slate-700 tracking-wider text-center max-w-md">
                  Add OPENROUTER_API_KEY to backend/.env and restart the server to enable
                  automatic operational insights.
                </div>
              </div>
            ) : !insight && !insightError ? (
              <div className="flex flex-col items-center justify-center h-[200px] gap-2 text-slate-600">
                <RefreshCw
                  className="w-5 h-5 animate-spin text-violet-500/60"
                  strokeWidth={1.25}
                />
                <div className="text-[11px] font-mono tracking-[0.2em]">
                  AWAITING FIRST ANALYSIS CYCLE
                </div>
                <div className="text-[10px] font-mono text-slate-700 tracking-wider">
                  First run fires ~60s after backend start.
                </div>
              </div>
            ) : insightError && !insight ? (
              <div className="flex flex-col items-center justify-center h-[200px] gap-2">
                <TriangleAlert
                  className="w-6 h-6 text-red-400"
                  strokeWidth={1.25}
                />
                <div className="text-[11px] font-mono tracking-[0.2em] text-red-400">
                  ANALYSIS FAILED
                </div>
                <div className="text-[10px] font-mono text-slate-500 tracking-wider text-center max-w-md break-words px-4">
                  {insightError.error}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {/* SUMMARY */}
                <div className="border-l-2 border-violet-500/60 pl-4">
                  <div className="text-[9px] font-mono tracking-[0.3em] text-violet-400 uppercase mb-1.5">
                    Summary
                  </div>
                  <div className="text-sm font-mono text-slate-200 leading-relaxed">
                    {insight.summary || "No summary generated."}
                  </div>
                </div>

                {/* Three-column layout for anomalies / trends / tips */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* ANOMALIES */}
                  <div className="border border-slate-800 bg-slate-950/40 p-3">
                    <div className="flex items-center gap-2 mb-2 pb-2 border-b border-slate-800">
                      <ShieldAlert
                        className="w-3.5 h-3.5 text-red-400"
                        strokeWidth={1.75}
                      />
                      <span className="text-[10px] font-mono tracking-[0.25em] text-slate-300 uppercase">
                        Anomalies
                      </span>
                      <span className="ml-auto text-[9px] font-mono text-slate-600 tabular-nums">
                        {(insight.anomalies || []).length.toString().padStart(2, "0")}
                      </span>
                    </div>
                    {(insight.anomalies || []).length === 0 ? (
                      <div className="flex items-center gap-2 text-[10px] font-mono text-emerald-500/80 tracking-wider">
                        <CircleCheck className="w-3 h-3" strokeWidth={1.75} />
                        NONE DETECTED
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {insight.anomalies.map((a, i) => {
                          const sev = {
                            high: { bg: "bg-red-500/10", text: "text-red-400", ring: "ring-red-500/30" },
                            medium: { bg: "bg-amber-500/10", text: "text-amber-400", ring: "ring-amber-500/30" },
                            low: { bg: "bg-slate-500/10", text: "text-slate-400", ring: "ring-slate-500/30" },
                          }[a.severity] || { bg: "bg-slate-500/10", text: "text-slate-400", ring: "ring-slate-500/30" };
                          return (
                            <div key={i} className="flex items-start gap-2">
                              <span
                                className={`shrink-0 px-1.5 py-0.5 text-[8px] font-mono tracking-[0.2em] uppercase ring-1 ${sev.bg} ${sev.text} ${sev.ring}`}
                              >
                                {a.severity}
                              </span>
                              <p className="text-[11px] font-mono text-slate-300 leading-snug break-words">
                                {a.message}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* TRENDS */}
                  <div className="border border-slate-800 bg-slate-950/40 p-3">
                    <div className="flex items-center gap-2 mb-2 pb-2 border-b border-slate-800">
                      <TrendingUp
                        className="w-3.5 h-3.5 text-cyan-400"
                        strokeWidth={1.75}
                      />
                      <span className="text-[10px] font-mono tracking-[0.25em] text-slate-300 uppercase">
                        Trends
                      </span>
                      <span className="ml-auto text-[9px] font-mono text-slate-600 tabular-nums">
                        {(insight.trends || []).length.toString().padStart(2, "0")}
                      </span>
                    </div>
                    {(insight.trends || []).length === 0 ? (
                      <div className="text-[10px] font-mono text-slate-600 tracking-wider">
                        — NO SIGNIFICANT CHANGE —
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {insight.trends.map((t, i) => {
                          const Dir =
                            t.direction === "rising"
                              ? ArrowUp
                              : t.direction === "falling"
                                ? ArrowDown
                                : Minus;
                          const dirColor =
                            t.direction === "rising"
                              ? "text-cyan-400"
                              : t.direction === "falling"
                                ? "text-amber-400"
                                : "text-slate-500";
                          return (
                            <div key={i} className="flex items-start gap-2">
                              <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 border border-slate-700 bg-slate-900/40 text-[8px] font-mono tracking-[0.2em] uppercase text-slate-400">
                                <Dir
                                  className={`w-2.5 h-2.5 ${dirColor}`}
                                  strokeWidth={2.25}
                                />
                                {t.metric}
                              </span>
                              <p className="text-[11px] font-mono text-slate-300 leading-snug break-words">
                                {t.message}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* TIPS */}
                  <div className="border border-slate-800 bg-slate-950/40 p-3">
                    <div className="flex items-center gap-2 mb-2 pb-2 border-b border-slate-800">
                      <Lightbulb
                        className="w-3.5 h-3.5 text-emerald-400"
                        strokeWidth={1.75}
                      />
                      <span className="text-[10px] font-mono tracking-[0.25em] text-slate-300 uppercase">
                        Optimization
                      </span>
                      <span className="ml-auto text-[9px] font-mono text-slate-600 tabular-nums">
                        {(insight.tips || []).length.toString().padStart(2, "0")}
                      </span>
                    </div>
                    {(insight.tips || []).length === 0 ? (
                      <div className="text-[10px] font-mono text-slate-600 tracking-wider">
                        NO RECOMMENDATIONS
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {insight.tips.map((t, i) => {
                          const catColor = {
                            efficiency: "text-emerald-400 ring-emerald-500/30 bg-emerald-500/10",
                            safety: "text-red-400     ring-red-500/30     bg-red-500/10",
                            cost: "text-cyan-400    ring-cyan-500/30    bg-cyan-500/10",
                            maintenance: "text-amber-400   ring-amber-500/30   bg-amber-500/10",
                          }[t.category] || "text-slate-400 ring-slate-500/30 bg-slate-500/10";
                          return (
                            <div key={i} className="flex items-start gap-2">
                              <span
                                className={`shrink-0 px-1.5 py-0.5 text-[8px] font-mono tracking-[0.2em] uppercase ring-1 ${catColor}`}
                              >
                                {t.category}
                              </span>
                              <p className="text-[11px] font-mono text-slate-300 leading-snug break-words">
                                {t.message}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Footer strip with metadata */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/60 text-[9px] font-mono tracking-[0.2em] text-slate-600">
                  <span>
                    GEN:{" "}
                    <span className="text-slate-500 tabular-nums">
                      {new Date(insight.generatedAt).toLocaleTimeString("en-US", {
                        hour12: false,
                      })}
                    </span>
                    {insight.manual && <span className="text-violet-500 ml-2">[MANUAL]</span>}
                  </span>
                  {insight.usage && (
                    <span>
                      TOKENS:{" "}
                      <span className="text-slate-500 tabular-nums">
                        {insight.usage.prompt_tokens ?? "—"}↑{" "}
                        {insight.usage.completion_tokens ?? "—"}↓
                      </span>
                    </span>
                  )}
                  <span>
                    LATENCY:{" "}
                    <span className="text-slate-500 tabular-nums">
                      {insight.elapsedMs}ms
                    </span>
                  </span>
                  {insightError && (
                    <span className="text-red-500">
                      LAST ERROR: {insightError.error.slice(0, 40)}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ============== SYSTEM EVENT LOG ============== */}
        <div className="flex items-center gap-3 pt-2">
          <div className="h-px flex-1 bg-gradient-to-r from-slate-800 to-transparent" />
          <span className="text-[10px] font-mono tracking-[0.3em] text-slate-500">
            /// SYSTEM EVENT LOG
          </span>
          <div className="h-px w-16 bg-slate-800" />
        </div>

        <div className="relative bg-black/70 border border-slate-800 rounded-sm overflow-hidden">
          <CornerBrackets />

          {/* Terminal header */}
          <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-slate-800 bg-slate-950/80">
            <div className="flex items-center gap-2">
              <Terminal
                className="w-3.5 h-3.5 text-emerald-400"
                strokeWidth={1.75}
              />
              <span className="text-[10px] font-mono tracking-[0.25em] text-slate-300">
                /dev/pzem/events
              </span>
              <span className="hidden sm:inline text-[9px] font-mono tracking-[0.2em] text-slate-600 ml-2">
                {logs.length.toString().padStart(3, "0")} ENTRIES
              </span>
            </div>

            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-lg shadow-emerald-500/60" />
                <span className="text-[9px] font-mono tracking-[0.25em] text-emerald-400">
                  STREAMING
                </span>
              </div>
              <button
                onClick={() => {
                  setLogs([]);
                  prevStatusRef.current = {
                    voltage: getVoltageStatus(currentData.voltage_V, thresholds),
                    powerSpike: currentData.power_W > thresholds.powerSpike,
                    mqtt: prevStatusRef.current.mqtt,
                  };
                }}
                disabled={logs.length === 0}
                title="Clear log buffer"
                className="flex items-center gap-1.5 px-2 py-1 border border-slate-700 bg-slate-900/60 hover:bg-red-500/10 hover:border-red-500/40 disabled:opacity-40 disabled:hover:bg-slate-900/60 disabled:hover:border-slate-700 disabled:cursor-not-allowed rounded-sm transition-colors group"
              >
                <Trash2
                  className="w-3 h-3 text-slate-500 group-hover:text-red-400 group-disabled:text-slate-600 transition-colors"
                  strokeWidth={1.75}
                />
                <span className="text-[9px] font-mono tracking-[0.25em] text-slate-400 group-hover:text-red-400 group-disabled:text-slate-600 transition-colors">
                  CLEAR
                </span>
              </button>
            </div>
          </div>

          {/* Terminal body */}
          <div className="h-40 overflow-y-auto font-mono text-[11px] leading-relaxed px-4 py-2 scrollbar-thin">
            {logs.length === 0 ? (
              <div className="flex items-center justify-center h-full text-slate-600 text-[10px] tracking-[0.25em]">
                &gt; waiting for events<span className="animate-pulse">_</span>
              </div>
            ) : (
              logs.map((l) => {
                const style = LOG_LEVEL[l.level] || LOG_LEVEL.INFO;
                const hh = l.ts.toLocaleTimeString("en-US", {
                  hour12: false,
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                });
                return (
                  <div
                    key={l.id}
                    className="flex items-start gap-2 py-0.5 hover:bg-slate-900/40 -mx-4 px-4"
                  >
                    <span className="text-slate-600 tabular-nums shrink-0">
                      [{hh}]
                    </span>
                    <span
                      className={`shrink-0 px-1.5 rounded-sm text-[9px] tracking-widest ring-1 ${style.tag} ${style.text}`}
                    >
                      {l.level.padEnd(4, "\u00A0")}
                    </span>
                    <span className={`${style.text} break-words`}>
                      {l.message}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ============== FOOTER ============== */}
        <footer className="pt-4 pb-2 border-t border-slate-800/60 flex flex-wrap items-center justify-between gap-3 text-[10px] font-mono tracking-[0.2em] text-slate-600">
          <div className="flex items-center gap-4">
            <span>© GRIDPULSE</span>
            <span className="hidden md:inline">
              BUILD 1.0.0 // {new Date().toISOString().split("T")[0]}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span>
              HEARTBEAT:{" "}
              <span className="text-emerald-500">
                {Math.floor(
                  (Date.now() - lastUpdate.getTime()) / 1000
                )
                  .toString()
                  .padStart(2, "0")}
                s
              </span>
            </span>
            <span>STATUS: OPERATIONAL</span>
          </div>
        </footer>
      </main>

      {/* ============== THRESHOLD CONFIGURATION MODAL ============== */}
      <ThresholdModal
        open={settingsOpen}
        current={thresholds}
        onCancel={() => setSettingsOpen(false)}
        onSave={(next) => {
          setThresholds(next);
          setSettingsOpen(false);
          pushLog("SYSTEM", "Alarm thresholds reconfigured by operator");
          // Re-seed the edge-trigger state so we don't immediately fire log
          // entries for conditions that were already active under the old limits.
          prevStatusRef.current = {
            voltage: getVoltageStatus(currentData.voltage_V, next),
            powerSpike: currentData.power_W > next.powerSpike,
            mqtt: prevStatusRef.current.mqtt,
          };
        }}
      />
    </div>
  );
}