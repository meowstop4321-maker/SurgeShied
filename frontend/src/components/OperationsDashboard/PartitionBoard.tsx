import React, { useEffect, useState } from "react";
import { Layers, Users, Clock, ArrowRight, ShieldCheck, Zap, ArrowDownUp } from "lucide-react";
import { getSeatPartitions, subscribeSeatPartitions } from "../../lib/api";
import { supabase } from "../../lib/supabaseClient";

interface LaneRow {
  lane_index: number;
  capacity: number;
  seats_taken: number;
  waiting: number;
}

export function PartitionBoard({ eventId }: { eventId: string }) {
  const [lanes, setLanes] = useState<LaneRow[]>([]);
  const [initialCount, setInitialCount] = useState<number | null>(null);
  const [recentAdded, setRecentAdded] = useState<number>(0);

  async function refresh() {
    const partitions = await getSeatPartitions(eventId);
    const { data: waitingRows } = await supabase
      .from("queue_entries")
      .select("lane_index")
      .eq("event_id", eventId)
      .eq("status", "waiting");

    const waitingByLane = new Map<number, number>();
    (waitingRows ?? []).forEach((r) => {
      waitingByLane.set(r.lane_index, (waitingByLane.get(r.lane_index) ?? 0) + 1);
    });

    const currentTotal = partitions.reduce((s, p) => s + p.seats_taken, 0);
    if (initialCount === null && currentTotal > 0) {
      setInitialCount(currentTotal);
    } else if (initialCount !== null) {
      setRecentAdded(Math.max(0, currentTotal - initialCount));
    }

    setLanes(
      partitions.map((p) => ({
        lane_index: p.lane_index,
        capacity: p.capacity,
        seats_taken: p.seats_taken,
        waiting: waitingByLane.get(p.lane_index) ?? 0,
      })),
    );
  }

  useEffect(() => {
    refresh();
    const unsubscribeSeats = subscribeSeatPartitions(eventId, refresh);
    const channel = supabase
      .channel(`queue_board:${eventId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "queue_entries", filter: `event_id=eq.${eventId}` },
        refresh,
      )
      .subscribe();

    return () => {
      unsubscribeSeats();
      supabase.removeChannel(channel);
    };
  }, [eventId]);

  const totalCapacity = lanes.reduce((s, l) => s + l.capacity, 0);
  const totalSeated = lanes.reduce((s, l) => s + l.seats_taken, 0);
  const totalWaiting = lanes.reduce((s, l) => s + l.waiting, 0);
  const totalHeadroom = Math.max(0, totalCapacity - totalSeated);

  // Find optimal lane for dynamic queue / reservation routing
  const optimalLane = [...lanes]
    .sort((a, b) => {
      const aHeadroom = a.capacity - a.seats_taken;
      const bHeadroom = b.capacity - b.seats_taken;
      if (aHeadroom > 0 || bHeadroom > 0) return bHeadroom - aHeadroom;
      return a.waiting - b.waiting;
    })[0]?.lane_index ?? 0;

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 p-5 space-y-5 backdrop-blur-md">
      {/* Header & Dynamic Telemetry Summary */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/5 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-teal-400" />
            <h3 className="text-sm font-semibold text-slate-100">Adaptive Surge Partitions & Dynamic Queuing</h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Real-time striping across {lanes.length} parallel transactional database lanes with Crowd Pressure Routing.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-teal-400 font-medium flex items-center gap-1.5 bg-teal-950/40 px-3 py-1 rounded-full border border-teal-500/30">
            <span className="w-2 h-2 rounded-full bg-teal-400 animate-pulse" />
            Dynamic Routing Active
          </span>
        </div>
      </div>

      {/* Onboarding & Ingress Breakdown Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono">
        <div className="bg-black/30 border border-white/5 rounded-lg p-3">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Total Seated</span>
          <div className="text-lg font-bold text-white mt-0.5">
            {totalSeated} <span className="text-xs text-slate-500 font-normal">/ {totalCapacity}</span>
          </div>
          <span className="text-[10px] text-teal-400">
            {totalCapacity > 0 ? Math.round((totalSeated / totalCapacity) * 100) : 0}% capacity
          </span>
        </div>

        <div className="bg-black/30 border border-white/5 rounded-lg p-3">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Recent Ingress</span>
          <div className="text-lg font-bold text-emerald-400 mt-0.5">
            +{recentAdded > 0 ? recentAdded : totalSeated}
          </div>
          <span className="text-[10px] text-slate-400">newly onboarded</span>
        </div>

        <div className="bg-black/30 border border-white/5 rounded-lg p-3">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Striped Lanes</span>
          <div className="text-lg font-bold text-teal-300 mt-0.5">
            {lanes.length} <span className="text-xs text-slate-500 font-normal">lanes</span>
          </div>
          <span className="text-[10px] text-slate-400">{totalHeadroom} seats free</span>
        </div>

        <div className="bg-black/30 border border-white/5 rounded-lg p-3">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Waiting Queue</span>
          <div className="text-lg font-bold text-amber-300 mt-0.5">
            {totalWaiting} <span className="text-xs text-slate-500 font-normal">waiting</span>
          </div>
          <span className="text-[10px] text-amber-400/90">
            {totalWaiting > 0 ? `~${totalWaiting * 2}m est. wait` : "zero queue delay"}
          </span>
        </div>
      </div>

      {/* Per-Lane Live Strips */}
      <div className="space-y-3.5 pt-1">
        {lanes.map((lane) => {
          const headroom = Math.max(0, lane.capacity - lane.seats_taken);
          const pct = Math.min(100, Math.round((lane.seats_taken / (lane.capacity || 1)) * 100));
          const isOptimal = lane.lane_index === optimalLane;
          const waitTimeMins = (lane.waiting + 1) * 2;

          return (
            <div
              key={lane.lane_index}
              className={`rounded-xl border p-3.5 space-y-2 transition-all duration-300 ${
                isOptimal && headroom > 0
                  ? "bg-teal-950/20 border-teal-500/40 shadow-[0_0_12px_rgba(20,184,166,0.1)]"
                  : "bg-white/[0.02] border-white/5 hover:border-white/10"
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs">
                <div className="flex items-center gap-2 font-medium">
                  <span className="text-slate-200">Lane {lane.lane_index}</span>
                  {isOptimal && headroom > 0 && (
                    <span className="text-[10px] bg-teal-500/20 text-teal-300 border border-teal-500/40 px-1.5 py-0.2 rounded flex items-center gap-1">
                      ⭐ Recommended Ingress Target
                    </span>
                  )}
                  {pct >= 100 && (
                    <span className="text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/40 px-1.5 py-0.2 rounded">
                      Saturated
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3 text-slate-400 font-mono text-[11px]">
                  <span>
                    <span className={pct >= 100 ? "text-rose-400 font-bold" : "text-slate-200 font-semibold"}>
                      {lane.seats_taken}/{lane.capacity}
                    </span>{" "}
                    seated ({pct}%)
                  </span>
                  <span>·</span>
                  <span className={headroom > 0 ? "text-teal-400" : "text-slate-500"}>
                    {headroom} free
                  </span>
                  {lane.waiting > 0 && (
                    <>
                      <span>·</span>
                      <span className="text-amber-300 font-semibold flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {lane.waiting} waiting (~{waitTimeMins}m wait)
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Saturation Bar */}
              <div className="h-2.5 rounded-full bg-black/40 overflow-hidden border border-white/5">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    pct >= 100
                      ? "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]"
                      : pct >= 80
                      ? "bg-amber-400"
                      : "bg-teal-400 shadow-[0_0_8px_rgba(45,212,191,0.3)]"
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
