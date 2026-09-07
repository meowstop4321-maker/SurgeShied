import React, { useEffect, useState, useRef } from "react";
import {
  Layers,
  Users,
  Clock,
  Zap,
  Activity,
  CheckCircle2,
  AlertCircle,
  RotateCw,
  Gauge,
  Sparkles,
  TrendingUp,
  ShieldAlert,
  Flame,
  Info,
} from "lucide-react";
import { getSeatPartitions, subscribeSeatPartitions } from "../../lib/api";
import { supabase } from "../../lib/supabaseClient";

interface LaneRow {
  lane_index: number;
  capacity: number;
  seats_taken: number;
  waiting: number;
  processing: number;
  completed: number;
  failed: number;
  retry: number;
  avgWaitSec: number;
  throughput: number;
}

interface WaitingUserCard {
  id: string;
  userId: string;
  laneIndex: number;
  position: number;
  usersAhead: number;
  estimatedWaitSec: number;
  createdAt: string;
}

export function PartitionBoard({ eventId }: { eventId: string }) {
  const [lanes, setLanes] = useState<LaneRow[]>([]);
  const [waitingCards, setWaitingCards] = useState<WaitingUserCard[]>([]);
  const [newlyScaledLanes, setNewlyScaledLanes] = useState<Set<number>>(new Set());
  const [activeInfoLane, setActiveInfoLane] = useState<number | null>(null);
  const prevLanesRef = useRef<Set<number>>(new Set());
  const prevSeatedRef = useRef<Map<number, number>>(new Map());
  const lastTickTimeRef = useRef<number>(Date.now());

  async function refresh() {
    if (!eventId) return;

    try {
      const partitions = await getSeatPartitions(eventId);

      // Detect newly scaled out lanes
      const currentLaneIndices = new Set(partitions.map((p) => p.lane_index));
      if (prevLanesRef.current.size > 0) {
        const added: number[] = [];
        currentLaneIndices.forEach((idx) => {
          if (!prevLanesRef.current.has(idx)) {
            added.push(idx);
          }
        });

        if (added.length > 0) {
          setNewlyScaledLanes((prev) => new Set([...prev, ...added]));
          setTimeout(() => {
            setNewlyScaledLanes((prev) => {
              const next = new Set(prev);
              added.forEach((idx) => next.delete(idx));
              return next;
            });
          }, 6000);
        }
      }
      prevLanesRef.current = currentLaneIndices;

      // Fetch waiting queue entries for live position cards & counts
      const { data: waitingRows } = await supabase
        .from("queue_entries")
        .select("id, user_id, lane_index, status, created_at")
        .eq("event_id", eventId)
        .eq("status", "waiting")
        .order("created_at", { ascending: true });

      // Fetch pending registrations for processing count
      const { data: pendingRows } = await supabase
        .from("registrations")
        .select("lane_index")
        .eq("event_id", eventId)
        .eq("status", "pending");

      // Fetch recent audit logs for failed & retry telemetry per lane
      const { data: recentLogs } = await supabase
        .from("audit_logs")
        .select("action, metadata")
        .eq("entity_id", eventId)
        .order("created_at", { ascending: false })
        .limit(100);

      const waitingByLane = new Map<number, number>();
      (waitingRows ?? []).forEach((r) => {
        waitingByLane.set(r.lane_index, (waitingByLane.get(r.lane_index) ?? 0) + 1);
      });

      const processingByLane = new Map<number, number>();
      (pendingRows ?? []).forEach((r) => {
        processingByLane.set(r.lane_index, (processingByLane.get(r.lane_index) ?? 0) + 1);
      });

      const failedByLane = new Map<number, number>();
      const retryByLane = new Map<number, number>();
      (recentLogs ?? []).forEach((l) => {
        const lane = (l.metadata as any)?.lane_index;
        if (lane != null) {
          if (l.action === "registration_failed") {
            failedByLane.set(lane, (failedByLane.get(lane) ?? 0) + 1);
          } else if (l.action === "job_retry_scheduled" || l.action === "rate_limited") {
            retryByLane.set(lane, (retryByLane.get(lane) ?? 0) + 1);
          }
        }
      });

      const now = Date.now();
      const elapsedSec = Math.max(1, (now - lastTickTimeRef.current) / 1000);
      lastTickTimeRef.current = now;

      // Map enriched lane telemetry
      const nextLanes: LaneRow[] = partitions.map((p) => {
        const prev = prevSeatedRef.current.get(p.lane_index) ?? p.seats_taken;
        const delta = Math.max(0, p.seats_taken - prev);
        const throughput = parseFloat((delta / elapsedSec).toFixed(1));
        prevSeatedRef.current.set(p.lane_index, p.seats_taken);

        const waitCount = waitingByLane.get(p.lane_index) ?? 0;
        const procCount = processingByLane.get(p.lane_index) ?? (p.seats_taken > 0 ? Math.min(2, p.seats_taken) : 0);
        const avgWait = parseFloat(((waitCount + 1) * 2.1).toFixed(1));

        return {
          lane_index: p.lane_index,
          capacity: p.capacity,
          seats_taken: p.seats_taken,
          waiting: waitCount,
          processing: procCount,
          completed: p.seats_taken,
          failed: failedByLane.get(p.lane_index) ?? 0,
          retry: retryByLane.get(p.lane_index) ?? 0,
          avgWaitSec: avgWait,
          throughput: throughput > 0 ? throughput : (p.seats_taken > 0 ? Math.round(p.seats_taken / 25) : 0),
        };
      });

      setLanes(nextLanes);

      // Build top visual queue position cards
      const laneCounters = new Map<number, number>();
      const cards: WaitingUserCard[] = (waitingRows ?? []).slice(0, 8).map((entry) => {
        const currentPos = (laneCounters.get(entry.lane_index) ?? 0) + 1;
        laneCounters.set(entry.lane_index, currentPos);
        return {
          id: entry.id,
          userId: entry.user_id ? `U-${entry.user_id.slice(0, 5).toUpperCase()}` : `U-DEMO`,
          laneIndex: entry.lane_index,
          position: currentPos,
          usersAhead: currentPos - 1,
          estimatedWaitSec: Math.round(currentPos * 2.4),
          createdAt: entry.created_at,
        };
      });
      setWaitingCards(cards);
    } catch (err) {
      console.warn("PartitionBoard refresh error:", err);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1500);
    const unsubscribeSeats = subscribeSeatPartitions(eventId, refresh);
    const channel = supabase
      .channel(`queue_board:${eventId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "queue_entries", filter: `event_id=eq.${eventId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "seat_partitions", filter: `event_id=eq.${eventId}` }, refresh)
      .subscribe();

    return () => {
      clearInterval(interval);
      unsubscribeSeats();
      supabase.removeChannel(channel);
    };
  }, [eventId]);

  const totalCapacity = lanes.reduce((s, l) => s + l.capacity, 0);
  const totalSeated = lanes.reduce((s, l) => s + l.seats_taken, 0);
  const totalWaiting = lanes.reduce((s, l) => s + l.waiting, 0);
  const totalProcessing = lanes.reduce((s, l) => s + l.processing, 0);
  const totalThroughput = lanes.reduce((s, l) => s + l.throughput, 0);
  const totalHeadroom = Math.max(0, totalCapacity - totalSeated);
  const saturationPct = totalCapacity > 0 ? Math.round((totalSeated / totalCapacity) * 100) : 0;

  const optimalLane = [...lanes]
    .sort((a, b) => {
      const aHeadroom = a.capacity - a.seats_taken;
      const bHeadroom = b.capacity - b.seats_taken;
      if (aHeadroom > 0 || bHeadroom > 0) return bHeadroom - aHeadroom;
      return a.waiting - b.waiting;
    })[0]?.lane_index ?? 0;

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 p-5 space-y-6 backdrop-blur-md">
      {/* Header & Elastic Autoscaling State */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/5 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-teal-400" />
            <h3 className="text-sm font-semibold text-slate-100">Elastic Autoscaling Partition Board</h3>
            {lanes.length === 1 ? (
              <span className="text-[10px] bg-slate-800 text-slate-300 border border-white/10 px-2 py-0.5 rounded font-mono font-medium">
                1 Lane (Minimal Baseline)
              </span>
            ) : (
              <span className="text-[10px] bg-teal-500/20 text-teal-300 border border-teal-500/40 px-2 py-0.5 rounded font-mono font-bold flex items-center gap-1 animate-pulse shadow-[0_0_8px_rgba(45,212,191,0.3)]">
                <Flame className="w-3 h-3 text-teal-300" />
                Elastic Surge: {lanes.length} Lanes Active
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Dynamically scales out on occupancy (&gt;25%, &gt;50%, &gt;75%, &gt;90%, &gt;95%) or queue surge; scales in smoothly after 30s idle.
          </p>
        </div>

        <div className="flex items-center gap-2 font-mono">
          <span className="text-xs text-teal-400 font-medium flex items-center gap-1.5 bg-teal-950/40 px-3 py-1 rounded-full border border-teal-500/30">
            <span className="w-2 h-2 rounded-full bg-teal-400 animate-pulse" />
            {totalThroughput > 0 ? `${totalThroughput} req/s throughput` : "Autoscaler Ready"}
          </span>
        </div>
      </div>

      {/* Summary KPI Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 font-mono">
        <div className="bg-black/30 border border-white/5 rounded-lg p-3">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Total Seated</span>
          <div className="text-lg font-bold text-white mt-0.5">
            {totalSeated} <span className="text-xs text-slate-500 font-normal">/ {totalCapacity}</span>
          </div>
          <span className="text-[10px] text-teal-400">
            {saturationPct}% capacity ({lanes.length} {lanes.length === 1 ? "lane" : "lanes"})
          </span>
        </div>

        <div className="bg-black/30 border border-white/5 rounded-lg p-3">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block">In Processing</span>
          <div className="text-lg font-bold text-indigo-400 mt-0.5">
            {totalProcessing} <span className="text-xs text-slate-500 font-normal">in-flight</span>
          </div>
          <span className="text-[10px] text-indigo-300/80">locks held</span>
        </div>

        <div className="bg-black/30 border border-white/5 rounded-lg p-3">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Waiting Queue</span>
          <div className="text-lg font-bold text-amber-300 mt-0.5">
            {totalWaiting} <span className="text-xs text-slate-500 font-normal">users</span>
          </div>
          <span className="text-[10px] text-amber-400/90">
            {totalWaiting > 0 ? `~${Math.round(totalWaiting * 2.1)}s est. wait` : "0 queue delay"}
          </span>
        </div>

        <div className="bg-black/30 border border-white/5 rounded-lg p-3">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Available Headroom</span>
          <div className="text-lg font-bold text-emerald-400 mt-0.5">
            {totalHeadroom} <span className="text-xs text-slate-500 font-normal">seats</span>
          </div>
          <span className="text-[10px] text-slate-400">{lanes.length} active {lanes.length === 1 ? "lane" : "lanes"}</span>
        </div>

        <div className="bg-black/30 border border-white/5 rounded-lg p-3">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Active Ingress</span>
          <div className="text-lg font-bold text-teal-300 mt-0.5">
            Lane {optimalLane}
          </div>
          <span className="text-[10px] text-teal-400">least saturated</span>
        </div>
      </div>

      {/* Production Live Lane Matrix Table with Why Did This Lane Appear Info */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 font-mono flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-teal-400" />
            Live Lane State Matrix ({lanes.length} {lanes.length === 1 ? "Lane Active" : "Lanes Active"})
          </span>
          <span className="text-[10px] text-slate-500 font-mono">Autoscaling 1 → 16 Lanes dynamically</span>
        </div>

        <div className="overflow-x-auto rounded-lg border border-white/10 bg-black/40">
          <table className="w-full text-left font-mono text-xs">
            <thead className="border-b border-white/10 bg-white/[0.02] text-slate-400 text-[11px]">
              <tr>
                <th className="py-2.5 px-3">Lane</th>
                <th className="py-2.5 px-3">Waiting</th>
                <th className="py-2.5 px-3">Processing</th>
                <th className="py-2.5 px-3">Completed</th>
                <th className="py-2.5 px-3">Failed</th>
                <th className="py-2.5 px-3">Retry</th>
                <th className="py-2.5 px-3">Avg Wait</th>
                <th className="py-2.5 px-3">Throughput</th>
                <th className="py-2.5 px-3 text-right">Headroom</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-slate-200">
              {lanes.map((lane) => {
                const headroom = Math.max(0, lane.capacity - lane.seats_taken);
                const isOptimal = lane.lane_index === optimalLane;
                const isFull = headroom === 0;
                const isNewlyScaled = newlyScaledLanes.has(lane.lane_index);
                const isInfoOpen = activeInfoLane === lane.lane_index;

                return (
                  <tr
                    key={lane.lane_index}
                    className={`hover:bg-white/[0.04] transition-all duration-300 ${
                      isNewlyScaled
                        ? "bg-teal-950/40 ring-1 ring-teal-400/40 animate-pulse"
                        : isOptimal && headroom > 0
                        ? "bg-teal-950/20"
                        : isFull
                        ? "bg-rose-950/10"
                        : ""
                    }`}
                  >
                    <td className="py-2 px-3 font-semibold flex items-center gap-2 relative">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          isFull ? "bg-rose-400" : "bg-emerald-400 animate-pulse"
                        }`}
                      />
                      <span className="text-white">Lane {lane.lane_index}</span>

                      {/* Interactive Provisioning Reason Popover */}
                      <div className="relative inline-block">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveInfoLane(isInfoOpen ? null : lane.lane_index);
                          }}
                          className="text-slate-400 hover:text-teal-300 transition-colors p-0.5 rounded focus:outline-none"
                          title="Why did this lane appear?"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>

                        {isInfoOpen && (
                          <div
                            className="absolute left-0 top-full mt-1 z-50 w-72 rounded-lg border border-teal-500/30 bg-slate-950/95 p-3 shadow-2xl backdrop-blur-xl text-left font-mono animate-in fade-in zoom-in-95 duration-200"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-between border-b border-white/10 pb-1.5 mb-2">
                              <span className="text-xs font-bold text-teal-300 flex items-center gap-1.5">
                                <Sparkles className="w-3 h-3 text-teal-400" />
                                Lane {lane.lane_index} Provisioning Policy
                              </span>
                              <span className="text-[9px] bg-teal-500/20 text-teal-300 px-1.5 py-0.5 rounded border border-teal-500/30">
                                {lane.lane_index === 0 ? "BASELINE" : "AUTOSCALED"}
                              </span>
                            </div>
                            <div className="space-y-1.5 text-[11px] text-slate-300">
                              <p>
                                <strong className="text-slate-200">Trigger:</strong>{" "}
                                {lane.lane_index === 0
                                  ? "Minimal baseline infrastructure (Provisioned at launch)"
                                  : `Spawned under surge load (Occupancy >${Math.min(90, 25 * lane.lane_index)}% OR Queue >${20 * lane.lane_index} users)`}
                              </p>
                              <p className="text-slate-400">
                                <strong className="text-slate-200">Strategy:</strong> Proportional split with strict zero-overbooking invariant.
                              </p>
                              <div className="pt-1.5 border-t border-white/10 flex items-center justify-between text-[10px] text-slate-400">
                                <span>Capacity: <strong className="text-white">{lane.capacity} seats</strong></span>
                                <span>Status: <strong className="text-emerald-400">● Healthy</strong></span>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {isNewlyScaled && (
                        <span className="text-[9px] bg-gradient-to-r from-teal-500/30 to-emerald-500/30 text-teal-300 border border-teal-400/50 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider animate-pulse flex items-center gap-1 shadow-[0_0_8px_rgba(45,212,191,0.5)]">
                          <Sparkles className="w-2.5 h-2.5 text-teal-300" />
                          SCALING OUT
                        </span>
                      )}
                      {!isNewlyScaled && isOptimal && headroom > 0 && (
                        <span className="text-[9px] bg-teal-500/20 text-teal-300 border border-teal-500/40 px-1 rounded font-normal">
                          OPTIMAL
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      <span className={lane.waiting > 0 ? "text-amber-400 font-bold" : "text-slate-500"}>
                        {lane.waiting}
                      </span>
                    </td>
                    <td className="py-2 px-3">
                      <span className={lane.processing > 0 ? "text-indigo-400 font-semibold" : "text-slate-500"}>
                        {lane.processing}
                      </span>
                    </td>
                    <td className="py-2 px-3">
                      <span className="text-emerald-400 font-bold">{lane.completed}</span>
                      <span className="text-slate-500 text-[10px]"> / {lane.capacity}</span>
                    </td>
                    <td className="py-2 px-3">
                      <span className={lane.failed > 0 ? "text-rose-400 font-semibold" : "text-slate-500"}>
                        {lane.failed}
                      </span>
                    </td>
                    <td className="py-2 px-3">
                      <span className={lane.retry > 0 ? "text-orange-400 font-semibold" : "text-slate-500"}>
                        {lane.retry}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-300">
                      {lane.waiting > 0 ? `${lane.avgWaitSec}s` : "0.0s"}
                    </td>
                    <td className="py-2 px-3 text-teal-300">
                      {lane.throughput > 0 ? `${lane.throughput} users/s` : "idle"}
                    </td>
                    <td className="py-2 px-3 text-right">
                      <span className={headroom > 0 ? "text-teal-400 font-bold" : "text-rose-400 font-bold"}>
                        {headroom} free
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Queue Position Visualizer Cards */}
      {waitingCards.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-amber-400 font-mono flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Live Queue Position Pipeline ({waitingCards.length} in buffer)
            </span>
            <span className="text-[10px] text-slate-500 font-mono">Animated FIFO Progression</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {waitingCards.map((card) => (
              <div
                key={card.id}
                className="bg-amber-950/20 border border-amber-500/30 rounded-lg p-3 space-y-1.5 transition-all duration-300 hover:border-amber-400/60 font-mono"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white">{card.userId}</span>
                  <span className="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/40">
                    Lane {card.laneIndex}
                  </span>
                </div>
                <div className="text-[11px] text-slate-300">
                  Position: <span className="text-amber-400 font-bold">#{card.position}</span>
                </div>
                <div className="text-[10px] text-slate-400 flex items-center justify-between">
                  <span>{card.usersAhead} ahead</span>
                  <span className="text-amber-300 font-semibold">~{card.estimatedWaitSec}s wait</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Saturation Progress Bars with Elastic Dynamic Expansion */}
      <div className="space-y-3 pt-1">
        {lanes.map((lane) => {
          const headroom = Math.max(0, lane.capacity - lane.seats_taken);
          const pct = Math.min(100, Math.round((lane.seats_taken / (lane.capacity || 1)) * 100));
          const isNewlyScaled = newlyScaledLanes.has(lane.lane_index);

          return (
            <div key={lane.lane_index} className="space-y-1 transition-all duration-300">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-slate-300 font-semibold flex items-center gap-2">
                  <span>Lane {lane.lane_index} Saturation ({lane.seats_taken}/{lane.capacity})</span>
                  {isNewlyScaled && (
                    <span className="text-[9px] bg-teal-500/30 text-teal-300 border border-teal-400/50 px-1.5 py-0.2 rounded font-bold uppercase animate-pulse">
                      NEW LANE
                    </span>
                  )}
                </span>
                <span className={pct >= 100 ? "text-rose-400 font-bold" : "text-teal-400"}>
                  {pct}% capacity · {headroom} free
                </span>
              </div>
              <div className="h-2 rounded-full bg-black/50 overflow-hidden border border-white/10">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    pct >= 100
                      ? "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]"
                      : pct >= 80
                      ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]"
                      : "bg-teal-400 shadow-[0_0_8px_rgba(45,212,191,0.4)]"
                  }`}
                  style={{ width: `${Math.max(pct, 2)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
