import React, { useEffect, useState } from "react";
import { CircleDot, Cpu, RefreshCw } from "lucide-react";
import { getOpsMetrics, listEvents } from "../lib/api";
import { LiteModeBanner } from "../components/LiteModeBanner";
import { MetricTile } from "../components/OperationsDashboard/MetricTile";
import { SurgeGauge } from "../components/OperationsDashboard/SurgeGauge";
import { PartitionBoard } from "../components/OperationsDashboard/PartitionBoard";
import { LiveAuditLogTable } from "../components/OperationsDashboard/LiveAuditLogTable";
import { TrustCard } from "../components/TrustCard";
import { SimulationPanel } from "../components/SimulationPanel";
import { LogExplainerCard } from "../components/LogExplainerCard";

const POLL_MS = 3000;

const circuitColor: Record<string, string> = {
  closed: "text-emerald-400",
  open: "text-rose-400",
  half_open: "text-amber-400",
};

export function OperationsDashboard() {
  const [events, setEvents] = useState<{ id: string; title: string }[]>([]);
  const [eventId, setEventId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Awaited<ReturnType<typeof getOpsMetrics>> | null>(null);
  const [queueHistory, setQueueHistory] = useState<number[]>([]);

  useEffect(() => {
    listEvents().then((data) => {
      setEvents(data);
      if (data.length && !eventId) setEventId(data[0].id);
    });
  }, []);

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    async function tick() {
      try {
        const m = await getOpsMetrics(eventId!);
        if (!cancelled) {
          setMetrics(m);
          setQueueHistory((h) => [...h.slice(-29), m.queue_length]);
        }
      } catch (err) {
        console.error(err);
      }
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

      {eventId && <LiteModeBanner eventId={eventId} />}

      {!metrics ? (
        <div className="rounded-xl border border-white/10 bg-slate-900/40 p-12 text-center text-slate-400">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-teal-400" />
          <span>Polling telemetry metrics…</span>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetricTile label="Requests/sec" value={metrics.requests_per_sec.toFixed(1)} />
            <MetricTile
              label="Queue length"
              value={
                <div className="flex items-baseline justify-between gap-3">
                  <span>{metrics.queue_length}</span>
                  {queueHistory.length > 1 && (
                    <div className="flex items-end gap-0.5 h-6 w-20">
                      {queueHistory.map((val, idx) => {
                        const max = Math.max(...queueHistory, 1);
                        const heightPct = Math.max(15, Math.round((val / max) * 100));
                        return (
                          <div
                            key={idx}
                            className={`flex-1 rounded-t transition-all duration-300 ${
                              val > 20 ? "bg-amber-400/80" : val > 0 ? "bg-teal-400/70" : "bg-white/10"
                            }`}
                            style={{ height: `${heightPct}%` }}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              }
              accent={metrics.queue_length > 20 ? "amber" : "default"}
            />
            <MetricTile label="Active lanes" value={`${metrics.active_lanes} / ${metrics.total_lanes}`} />
            <SurgeGauge score={metrics.surge_score} />

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
            <MetricTile
              label="Dead letter count"
              value={metrics.dead_letter_count}
              accent={metrics.dead_letter_count > 0 ? "rose" : "default"}
            />
          </div>

          <TrustCard />

          {eventId && <PartitionBoard eventId={eventId} />}

          {eventId && <LogExplainerCard eventId={eventId} />}

          {eventId && <LiveAuditLogTable eventId={eventId} />}

          {eventId && <SimulationPanel eventId={eventId} />}
        </div>
      )}
    </div>
  );
}
