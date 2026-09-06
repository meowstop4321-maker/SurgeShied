import React from "react";

interface MetricTileProps {
  label: string;
  value: React.ReactNode;
  sub?: string;
  accent?: "default" | "amber" | "rose" | "teal";
}

const accentStyles = {
  default: "border-white/10 bg-slate-900/40 text-slate-100",
  amber: "border-amber-500/30 bg-amber-950/20 text-amber-300",
  rose: "border-rose-500/30 bg-rose-950/20 text-rose-300",
  teal: "border-teal-500/30 bg-teal-950/20 text-teal-300",
};

export const MetricTile: React.FC<MetricTileProps> = ({ label, value, sub, accent = "default" }) => {
  return (
    <div className={`rounded-xl border p-4 backdrop-blur-md transition-all ${accentStyles[accent]}`}>
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">{label}</p>
      <div className="text-2xl font-bold mt-1 tracking-tight">{value}</div>
      {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
    </div>
  );
};
