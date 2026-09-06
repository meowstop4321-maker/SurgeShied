import React from "react";
import { Zap } from "lucide-react";

interface SurgeGaugeProps {
  score: number | null;
}

export const SurgeGauge: React.FC<SurgeGaugeProps> = ({ score }) => {
  const normalized = score !== null ? Math.min(Math.max(score * 100, 0), 100) : 0;
  const isHigh = normalized > 80;
  const isMed = normalized > 50;

  const color = isHigh
    ? "text-rose-400 border-rose-500/30 bg-rose-950/20"
    : isMed
    ? "text-amber-400 border-amber-500/30 bg-amber-950/20"
    : "text-teal-400 border-teal-500/30 bg-teal-950/20";

  return (
    <div className={`rounded-xl border p-4 backdrop-blur-md transition-all ${color}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-slate-400">SurgeScore</p>
        <Zap className="w-4 h-4" />
      </div>
      <div className="text-2xl font-bold mt-1 tracking-tight">
        {score !== null ? `${normalized.toFixed(0)}%` : "0%"}
      </div>
      <div className="w-full bg-white/10 rounded-full h-1.5 mt-2 overflow-hidden">
        <div
          className={`h-full transition-all duration-500 ${
            isHigh ? "bg-rose-500" : isMed ? "bg-amber-500" : "bg-teal-400"
          }`}
          style={{ width: `${normalized}%` }}
        />
      </div>
    </div>
  );
};
