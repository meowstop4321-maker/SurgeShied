import React from "react";

// A minimal trend sparkline: a thin (2px) line in a de-emphasis hue, with
// the most recent point picked out as a small accent-colored dot — never a
// full chart (no axes/gridlines/tooltip), just enough shape to say "this is
// climbing" or "this just dropped" at a glance inside a stat tile.
export function Sparkline({
  values,
  width = 72,
  height = 24,
  accent = "#2dd4bf", // teal-400
}: {
  values: number[];
  width?: number;
  height?: number;
  accent?: string;
}) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 3;
  const points = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });
  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = points[points.length - 1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="text-slate-600" />
      <circle cx={lastX} cy={lastY} r={2.5} fill={accent} stroke="var(--tile-surface, #0f172a)" strokeWidth={2} />
    </svg>
  );
}
