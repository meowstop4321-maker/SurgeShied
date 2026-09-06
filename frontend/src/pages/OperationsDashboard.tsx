import React, { useEffect, useState } from "react";
import { Activity, CircleDot, Cpu, Gauge, RefreshCw, Timer, TriangleAlert, Users } from "lucide-react";
import { getOpsMetrics, getWorkerMetrics, listEvents, WorkerMetrics } from "../lib/api";
import { LiteModeBanner } from "../components/LiteModeBanner";
import { MetricTile } from "../components/OperationsDashboard/MetricTile";
import { SurgeGauge } from "../components/OperationsDashboard/SurgeGauge";
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
  const [workerMetrics, setWorkerMetrics] = useState<WorkerMetrics | null>(null);
  const [workerHistory, setWorkerHistory] = useState<number[]>([]);
  const [workerError, setWorkerError] = useState<string | null>(null);

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
        if (!cancelled) setMetrics(m);
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

  useEffect(() => {
    let cancelled = false;
    async function tickWorker() {
      try {
        const next = await getWorkerMetrics();
        if (!cancelled) {
          setWorkerMetrics(next);
          setWorkerError(null);
          setWorkerHistory((history) => [...history.slice(-19), next.avg_latency_ms]);
        }
      } catch (err) {
        if (!cancelled) setWorkerError(err instanceof Error ? err.message : "Worker metrics unavailable");
      }
    }
    tickWorker();
    const interval = setInterval(tickWorker, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

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
          <section className="rounded-xl border border-teal-500/20 bg-teal-950/10 p-5 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-teal-200">Self-Scaling Worker Pool</h2>
                <p className="text-xs text-slate-400 mt-1">Live queue pressure and application-level concurrency.</p>
              </div>
              {workerMetrics && (
                <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${
                  workerMetrics.status === "Healthy" ? "border-emerald-500/30 text-emerald-300" :
                  workerMetrics.status === "High Load" ? "border-rose-500/30 text-rose-300" : "border-amber-500/30 text-amber-300"
                }`}>
                  <Activity size={13} className="animate-pulse" /> {workerMetrics.status}
                </span>
              )}
            </div>
            {workerError ? (
              <div className="rounded-lg border border-rose-500/20 bg-rose-950/20 p-4 text-sm text-rose-300">{workerError}</div>
            ) : !workerMetrics ? (
              <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center text-slate-400">
                <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-teal-400" /> Loading worker metrics...
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <MetricTile label="Queue Length" value={workerMetrics.queue_length} icon={<Users size={16} />} accent={workerMetrics.queue_length > 100 ? "rose" : "default"} />
                  <MetricTile label="Active Workers" value={`${workerMetrics.active_workers} / ${workerMetrics.target_workers}`} icon={<Cpu size={16} />} accent="teal" />
                  <MetricTile label="Processing Rate" value={`${workerMetrics.processing_rate.toFixed(2)}/s`} icon={<Gauge size={16} />} />
                  <MetricTile label="Average Latency" value={`${Math.round(workerMetrics.avg_latency_ms)} ms`} icon={<Timer size={16} />} />
                  <MetricTile label="Failed Jobs" value={workerMetrics.failed_jobs} icon={<TriangleAlert size={16} />} accent={workerMetrics.failed_jobs > 0 ? "rose" : "default"} />
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-4">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Latency trend</span>
                    <span>{workerMetrics.active_workers} workers serving {workerMetrics.queue_length} queued jobs</span>
                  </div>
                  <div className="mt-3 flex h-12 items-end gap-1">
                    {(workerHistory.length ? workerHistory : [0]).map((latency, index) => (
                      <div key={`${index}-${latency}`} className="flex-1 rounded-t bg-teal-400/70 transition-all duration-500" style={{ height: `${Math.max(8, Math.min(100, latency / 10))}%` }} />
                    ))}
                  </div>
                </div>
              </>
            )}
          </section>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetricTile label="Requests/sec" value={metrics.requests_per_sec.toFixed(1)} />
            <MetricTile
              label="Queue length"
              value={metrics.queue_length}
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

          {eventId && <LogExplainerCard eventId={eventId} />}

          {eventId && <SimulationPanel eventId={eventId} />}
        </div>
      )}
    </div>
  );
}
