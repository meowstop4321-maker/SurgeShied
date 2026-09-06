import React from "react";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { Sparkline } from "./Sparkline";

interface DeltaSpec {
  /** Signed change since the last poll. */
  value: number;
  /** Which direction counts as "good" — colors the delta accordingly. Omit for a neutral (non-judged) delta. */
  goodDirection?: "up" | "down";
  /** How to format the number, e.g. "+2" vs "+2%". Defaults to a plain signed integer. */
  format?: (v: number) => string;
}

interface MetricTileProps {
  label: string;
  value: React.ReactNode;
  sub?: string;
  accent?: "default" | "amber" | "rose" | "teal";
  /** Signed change vs. the previous poll — rendered next to the value with a direction arrow. */
  delta?: DeltaSpec;
  /** Recent history (oldest → newest) rendered as a small trend sparkline. */
  trend?: number[];
}

const accentStyles = {
  default: "border-white/10 bg-slate-900/40 text-slate-100",
  amber: "border-amber-500/30 bg-amber-950/20 text-amber-300",
  rose: "border-rose-500/30 bg-rose-950/20 text-rose-300",
  teal: "border-teal-500/30 bg-teal-950/20 text-teal-300",
};

const accentDotColor: Record<string, string> = {
  default: "#2dd4bf",
  amber: "#fbbf24",
  rose: "#fb7185",
  teal: "#2dd4bf",
};

function DeltaBadge({ delta }: { delta: DeltaSpec }) {
  if (delta.value === 0) return <span className="text-[11px] text-slate-500 font-medium">no change</span>;
  const up = delta.value > 0;
  const isGood = delta.goodDirection == null ? null : (up && delta.goodDirection === "up") || (!up && delta.goodDirection === "down");
  const color = isGood == null ? "text-slate-400" : isGood ? "text-emerald-400" : "text-rose-400";
  const text = delta.format ? delta.format(delta.value) : `${up ? "+" : ""}${delta.value}`;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${color}`}>
      <Arrow size={12} />
      {text}
    </span>
  );
}

export const MetricTile: React.FC<MetricTileProps> = ({ label, value, sub, accent = "default", delta, trend }) => {
  return (
    <div className={`rounded-xl border p-4 backdrop-blur-md transition-all ${accentStyles[accent]}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">{label}</p>
        {trend && trend.length > 1 && <Sparkline values={trend} accent={accentDotColor[accent]} />}
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        {delta && <DeltaBadge delta={delta} />}
      </div>
      {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
    </div>
  );
};
