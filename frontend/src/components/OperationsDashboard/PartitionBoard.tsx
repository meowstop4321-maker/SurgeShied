import React, { useEffect, useState } from "react";
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

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 p-5 space-y-3 backdrop-blur-md">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Live Partition Saturation</h3>
        <span className="text-xs text-teal-400 font-medium flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-teal-400 animate-pulse" />
          Realtime Striping Active
        </span>
      </div>
      <div className="space-y-3 pt-1">
        {lanes.map((lane) => {
          const pct = Math.min(100, Math.round((lane.seats_taken / (lane.capacity || 1)) * 100));
          return (
            <div key={lane.lane_index} className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-400">
                <span className="font-medium text-slate-300">Lane {lane.lane_index}</span>
                <span>
                  <span className={pct >= 100 ? "text-rose-400 font-semibold" : "text-slate-200"}>
                    {lane.seats_taken}/{lane.capacity}
                  </span>{" "}
                  seated ({pct}%)
                  {lane.waiting > 0 && <span className="text-amber-300 font-medium"> · {lane.waiting} waiting</span>}
                </span>
              </div>
              <div className="h-2.5 rounded-full bg-white/5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    pct >= 100 ? "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]" : pct >= 80 ? "bg-amber-400" : "bg-teal-400"
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
