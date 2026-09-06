import React from "react";
import { AlertTriangle, XOctagon } from "lucide-react";
import type { ActiveAlert } from "../../lib/api";

// Pure display component now — alerts are fetched once per poll tick in
// OperationsDashboard (alongside getOpsMetrics) and passed down, so this
// component and SystemHealthStrip always agree on the same data instead of
// running two independent polling loops that could disagree for a moment.
export function AlertBanners({ alerts }: { alerts: ActiveAlert[] }) {
  if (alerts.length === 0) return null;

  return (
    <div className="space-y-2">
      {alerts.map((alert) => {
        const critical = alert.severity === "critical";
        return (
          <div
            key={alert.code}
            className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-xs font-medium ${
              critical
                ? "border-rose-500/40 bg-rose-950/30 text-rose-200"
                : "border-amber-500/40 bg-amber-950/20 text-amber-200"
            }`}
          >
            {critical ? <XOctagon className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            <span className="uppercase tracking-wider text-[10px] font-bold opacity-70 shrink-0">
              {critical ? "Critical" : "Warning"}
            </span>
            <span>{alert.message}</span>
          </div>
        );
      })}
    </div>
  );
}
