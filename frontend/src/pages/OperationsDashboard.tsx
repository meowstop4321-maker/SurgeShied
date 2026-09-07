import React, { useEffect, useState } from "react";
import { CircleDot, Cpu, RefreshCw, TrendingUp, TrendingDown, Minus, MemoryStick } from "lucide-react";
import { getOpsMetrics, getActiveAlerts, listEvents, OpsMetrics, ActiveAlert } from "../lib/api";
import { LiteModeBanner } from "../components/LiteModeBanner";
import { MetricTile } from "../components/OperationsDashboard/MetricTile";
import { SurgeGauge } from "../components/OperationsDashboard/SurgeGauge";
import { PartitionBoard } from "../components/OperationsDashboard/PartitionBoard";
import { LiveAuditLogTable } from "../components/OperationsDashboard/LiveAuditLogTable";
import { LiveLogConsole } from "../components/OperationsDashboard/LiveLogConsole";
import { DeadLetterQueuePanel } from "../components/OperationsDashboard/DeadLetterQueuePanel";
import { AlertBanners } from "../components/OperationsDashboard/AlertBanners";
import { SystemHealthStrip } from "../components/OperationsDashboard/SystemHealthStrip";
import { TrustCard } from "../components/TrustCard";
import { SimulationPanel } from "../components/SimulationPanel";
import { LogExplainerCard } from "../components/LogExplainerCard";

const POLL_MS = 1500;
const HISTORY_LEN = 20;

// The handful of tiles worth trending — enough to show direction of travel
// without turning every stat into a chart (per the dataviz method: a
// sparkline earns its place only where "is this climbing?" is the question).
const HISTORY_KEYS = [
  "requests_per_sec",
  "successful_registrations",
  "cpu_percent",
] as const;
type HistoryKey = (typeof HISTORY_KEYS)[number];
type MetricHistory = Partial<Record<HistoryKey, number[]>>;

const circuitColor: Record<string, string> = {
  closed: "text-emerald-400",
  open: "text-rose-400",
  half_open: "text-amber-400",
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mt-2">{children}</h2>;
}

function AutoscalingValue({ metrics }: { metrics: OpsMetrics }) {
  const icon =
    metrics.autoscaling_status === "scaling_up" ? (
      <TrendingUp size={16} className="text-emerald-400" />
    ) : metrics.autoscaling_status === "scaling_down" ? (
      <TrendingDown size={16} className="text-amber-400" />
    ) : (
      <Minus size={16} className="text-slate-400" />
    );
  const label =
    metrics.autoscaling_status === "scaling_up" ? "Scaling Up" : metrics.autoscaling_status === "scaling_down" ? "Scaling Down" : "Stable";
  return (
    <span className="flex items-center gap-1.5">
      {icon} {label}
    </span>
  );
}

// Builds the {trend, delta} props for a MetricTile from the rolling
// history — one place that decides "is the direction good, bad, or
// neutral" per metric, instead of repeating that judgment call at every
// call site.
function trendProps(
  history: MetricHistory,
  key: HistoryKey,
  opts?: { goodDirection?: "up" | "down"; format?: (v: number) => string }
) {
  const h = history[key];
  if (!h || h.length < 1) return {};
  if (h.length < 2) return { trend: h };
  const value = h[h.length - 1] - h[h.length - 2];
  return { trend: h, delta: { value, goodDirection: opts?.goodDirection, format: opts?.format } };
}

const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`;

export function OperationsDashboard() {
  const [events, setEvents] = useState<{ id: string; title: string }[]>([]);
  const [eventId, setEventId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<OpsMetrics | null>(null);
  const [alerts, setAlerts] = useState<ActiveAlert[]>([]);
  const [history, setHistory] = useState<MetricHistory>({});

  useEffect(() => {
    listEvents().then((data) => {
      setEvents(data);
      if (data.length && !eventId) setEventId(data[0].id);
    });
  }, []);

  const fetchLatestMetrics = async () => {
    if (!eventId) return;
    try {
      const [m, a] = await Promise.all([getOpsMetrics(eventId), getActiveAlerts(eventId)]);
      setMetrics(m);
      setAlerts(a);
      setHistory((h) => {
        const next: MetricHistory = { ...h };
        HISTORY_KEYS.forEach((k) => {
          const v = m[k];
          if (typeof v === "number") {
            next[k] = [...(h[k] ?? []).slice(-(HISTORY_LEN - 1)), v];
          }
        });
        return next;
      });
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    async function tick() {
      if (cancelled) return;
      await fetchLatestMetrics();
    }
    tick();
    const interval = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [eventId]);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold text-white">Operations & Telemetry</h1>
          <p className="text-sm text-slate-400 mt-1">
            Real-time health, Adaptive Surge Partition saturation, and resilience telemetry.
          </p>
        </div>

        {events.length > 0 && (
          <select
            value={eventId ?? ""}
            onChange={(e) => setEventId(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-xs text-slate-200 focus:outline-none focus:border-teal-500 font-medium"
          >
            {events.map((e) => (
              <option key={e.id} value={e.id} className="bg-slate-900 text-white">
                {e.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* The one-second answer to "is everything OK?" — comes first, above
          even the lite-mode banner, so it's the very first thing read. */}
      {metrics && <SystemHealthStrip metrics={metrics} alerts={alerts} />}

      {eventId && <LiteModeBanner eventId={eventId} />}
      <AlertBanners alerts={alerts} />

      {!metrics ? (
        <div className="rounded-xl border border-white/10 bg-slate-900/40 p-12 text-center text-slate-400">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-teal-400" />
          <span>Polling telemetry metrics…</span>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Traffic & Registrations */}
          <SectionLabel>Traffic & Registrations</SectionLabel>
          <div className="grid grid-cols-2 sm:grid-cols-2 gap-4">
            <MetricTile
              label="Requests/sec"
              value={metrics.requests_per_sec.toFixed(1)}
              {...trendProps(history, "requests_per_sec")}
            />
            <MetricTile
              label="Successful Registrations"
              value={metrics.successful_registrations}
              accent="teal"
              {...trendProps(history, "successful_registrations", { goodDirection: "up" })}
            />
          </div>

          {/* Queue & Job Processing */}
          <SectionLabel>Queue & Job Processing</SectionLabel>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <MetricTile
              label="Retry count"
              value={metrics.retry_count}
              accent={metrics.retry_count > 0 ? "amber" : "default"}
            />
            <MetricTile label="Active lanes" value={`${metrics.active_lanes} / ${metrics.total_lanes}`} />
            <SurgeGauge score={metrics.surge_score} />
            <MetricTile
              label="Seats remaining"
              value={metrics.seats_remaining}
              accent={metrics.seats_remaining === 0 ? "rose" : "default"}
            />
            <MetricTile
              label="Dead letter count"
              value={metrics.dead_letter_count}
              accent={metrics.dead_letter_count > 0 ? "rose" : "default"}
            />
          </div>

          {/* Latency & Performance */}
          <SectionLabel>Latency & Performance</SectionLabel>
          <div className="grid grid-cols-2 sm:grid-cols-2 gap-4">
            <MetricTile
              label="CPU usage"
              value={
                <span className="flex items-center gap-1.5">
                  <Cpu size={16} className="text-slate-400" />
                  {metrics.cpu_percent != null ? `${metrics.cpu_percent}%` : "—"}
                </span>
              }
              accent={metrics.cpu_percent != null && metrics.cpu_percent > 85 ? "amber" : "default"}
              {...trendProps(history, "cpu_percent", { goodDirection: "down", format: fmtPct })}
            />
            <MetricTile
              label="Memory usage"
              value={
                <span className="flex items-center gap-1.5">
                  <MemoryStick size={16} className="text-slate-400" />
                  {metrics.memory_used_mb != null ? `${Math.round(metrics.memory_used_mb)} MB` : "—"}
                </span>
              }
              sub={metrics.memory_total_mb != null ? `of ${Math.round(metrics.memory_total_mb)} MB` : undefined}
            />
          </div>

          {/* Infrastructure & Scaling */}
          <SectionLabel>Infrastructure & Scaling</SectionLabel>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetricTile
              label="Active instances"
              value={metrics.active_instances ?? "—"}
              sub={
                metrics.min_instances != null && metrics.max_instances != null
                  ? `range ${metrics.min_instances}–${metrics.max_instances}`
                  : undefined
              }
            />
            <MetricTile
              label="Autoscaling status"
              value={<AutoscalingValue metrics={metrics} />}
              sub={metrics.autoscaling_note}
              accent={metrics.autoscaling_status === "scaling_up" ? "teal" : "default"}
            />
            <MetricTile
              label="Circuit Guardian"
              value={
                <span className={`flex items-center gap-1.5 ${circuitColor[metrics.circuit_state] ?? "text-slate-300"}`}>
                  <CircleDot size={16} /> {metrics.circuit_state}
                </span>
              }
              accent={metrics.circuit_state === "open" ? "rose" : "default"}
            />
            <MetricTile
              label="Worker health"
              value={
                <span
                  className={`flex items-center gap-1.5 ${
                    metrics.worker_status === "healthy" ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  <Cpu size={16} /> {metrics.worker_status}
                </span>
              }
              sub={`${metrics.active_worker_count} active instance(s)`}
              accent={metrics.worker_status === "healthy" ? "default" : "rose"}
            />
            <MetricTile
              label="Notification retries"
              value={metrics.notification_retries}
              sub={`${metrics.notification_queued} queued`}
            />
          </div>

          <TrustCard />

          {eventId && <SimulationPanel eventId={eventId} />}

          {eventId && <PartitionBoard eventId={eventId} />}

          <LiveLogConsole eventId={eventId ?? undefined} />

          <DeadLetterQueuePanel />

          {eventId && <LogExplainerCard eventId={eventId} />}

          {eventId && <LiveAuditLogTable eventId={eventId} />}
        </div>
      )}
    </div>
  );
}
