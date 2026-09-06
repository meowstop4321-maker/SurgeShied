import React, { useEffect, useState } from "react";
import { Sparkles, RefreshCw, AlertCircle, CheckCircle, Info, Zap } from "lucide-react";
import { FUNCTIONS_URL } from "../lib/supabaseClient";

interface LogExplanation {
  time: string;
  type: "surge" | "resilience" | "queue" | "guardian" | "recovery" | "nominal";
  severity: "info" | "warning" | "alert" | "critical" | "success";
  headline: string;
  summary: string;
  action: string;
}

interface LogExplainerCardProps {
  eventId: string;
}

export const LogExplainerCard: React.FC<LogExplainerCardProps> = ({ eventId }) => {
  const [explanations, setExplanations] = useState<LogExplanation[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchExplanations = async () => {
    if (!eventId) return;
    setLoading(true);
    try {
      const res = await fetch(`${FUNCTIONS_URL}/log-explainer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId }),
      });
      const data = await res.json();
      if (data.explanations) {
        setExplanations(data.explanations);
      }
    } catch (err) {
      console.error("Failed to fetch log explanations:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchExplanations();
    const interval = setInterval(fetchExplanations, 8000);
    return () => clearInterval(interval);
  }, [eventId]);

  const severityStyles = {
    info: "border-sky-500/30 bg-sky-950/20 text-sky-300",
    warning: "border-amber-500/30 bg-amber-950/20 text-amber-300",
    alert: "border-rose-500/30 bg-rose-950/20 text-rose-300",
    critical: "border-rose-500/40 bg-rose-950/40 text-rose-200",
    success: "border-teal-500/30 bg-teal-950/20 text-teal-300",
  };

  const getIcon = (type: string) => {
    switch (type) {
      case "surge":
        return <Zap className="w-4 h-4 text-amber-400" />;
      case "guardian":
      case "resilience":
        return <AlertCircle className="w-4 h-4 text-rose-400" />;
      case "recovery":
      case "nominal":
        return <CheckCircle className="w-4 h-4 text-teal-400" />;
      default:
        return <Info className="w-4 h-4 text-sky-400" />;
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-md p-6 space-y-4 shadow-xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-teal-500/10 border border-teal-500/30 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-teal-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">AI Log Explainer</h3>
            <p className="text-xs text-slate-400">Natural language telemetry synthesis & automated incident diagnostics</p>
          </div>
        </div>
        <button
          onClick={fetchExplanations}
          disabled={loading}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
          title="Refresh explainer"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="space-y-3">
        {explanations.length === 0 ? (
          <p className="text-xs text-slate-500 py-3 text-center">Synthesizing real-time telemetry…</p>
        ) : (
          explanations.map((item, idx) => (
            <div
              key={idx}
              className={`rounded-lg border p-3.5 space-y-1.5 transition-all ${severityStyles[item.severity]}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {getIcon(item.type)}
                  <span className="text-xs font-semibold text-white">{item.headline}</span>
                </div>
                <span className="text-[10px] font-mono text-slate-400">{item.time}</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">{item.summary}</p>
              <div className="text-[11px] font-mono bg-black/30 px-2.5 py-1 rounded text-teal-300/90 border border-white/5">
                ⚡ <span className="font-semibold">Resilience Engine Action:</span> {item.action}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
