import React from "react";
import { CheckCircle2, AlertTriangle, XOctagon, CircleDot, Cpu, Users, TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { OpsMetrics, ActiveAlert } from "../../lib/api";

// The single "is everything OK?" answer a judge (or an on-call engineer)
// should be able to get in under a second, before reading a single metric
// tile. Derived entirely from real signals already on the dashboard —
// active alerts, Circuit Guardian state, and worker health — never a
// separate, hand-maintained "status" value that could drift from reality.
export function SystemHealthStrip({ metrics, alerts }: { metrics: OpsMetrics; alerts: ActiveAlert[] }) {
  const criticalAlerts = alerts.filter((a) => a.severity === "critical").length;
  const warningAlerts = alerts.filter((a) => a.severity === "warning").length;

  const isCritical = criticalAlerts > 0 || metrics.circuit_state === "open" || metrics.worker_status === "down";
  const isDegraded = !isCritical && (warningAlerts > 0 || metrics.lite_mode);

  const overall = isCritical
    ? { label: "Critical", icon: XOctagon, color: "text-rose-400", ring: "border-rose-500/30 bg-rose-950/20" }
    : isDegraded
    ? { label: "Degraded", icon: AlertTriangle, color: "text-amber-400", ring: "border-amber-500/30 bg-amber-950/20" }
    : { label: "All Systems Operational", icon: CheckCircle2, color: "text-emerald-400", ring: "border-emerald-500/30 bg-emerald-950/20" };

  const OverallIcon = overall.icon;

  const AutoscaleIcon = metrics.autoscaling_status === "scaling_up" ? TrendingUp : metrics.autoscaling_status === "scaling_down" ? TrendingDown : Minus;

  const chips: { icon: React.ComponentType<{ size?: number | string; className?: string }>; label: string; color: string }[] = [
    {
      icon: CircleDot,
      label: `Circuit: ${metrics.circuit_state}`,
      color: metrics.circuit_state === "open" ? "text-rose-400" : metrics.circuit_state === "half_open" ? "text-amber-400" : "text-emerald-400",
    },
    {
      icon: Cpu,
      label: `Workers: ${metrics.worker_status} (${metrics.active_worker_count})`,
      color: metrics.worker_status === "healthy" ? "text-emerald-400" : "text-rose-400",
    },
    {
      icon: Users,
      label: `Queue: ${metrics.queue_length} waiting`,
      color: metrics.queue_length > 20 ? "text-amber-400" : "text-slate-400",
    },
    {
      icon: AutoscaleIcon,
      label: `Scaling: ${metrics.autoscaling_status.replace("_", " ")}`,
      color: metrics.autoscaling_status === "stable" ? "text-slate-400" : "text-teal-400",
    },
  ];

  return (
    <div className={`rounded-xl border p-4 backdrop-blur-md flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 ${overall.ring}`}>
      <div className="flex items-center gap-2 shrink-0">
        <OverallIcon size={20} className={overall.color} />
        <span className={`text-sm font-bold ${overall.color}`}>{overall.label}</span>
        {(criticalAlerts > 0 || warningAlerts > 0) && (
          <span className="text-[11px] text-slate-400 font-medium">
            ({criticalAlerts > 0 ? `${criticalAlerts} critical` : ""}{criticalAlerts > 0 && warningAlerts > 0 ? ", " : ""}{warningAlerts > 0 ? `${warningAlerts} warning` : ""})
          </span>
        )}
      </div>
      <div className="h-px sm:h-6 sm:w-px bg-white/10 shrink-0" />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        {chips.map((chip, i) => {
          const Icon = chip.icon;
          return (
            <span key={i} className={`inline-flex items-center gap-1.5 text-xs font-medium ${chip.color}`}>
              <Icon size={13} />
              {chip.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
