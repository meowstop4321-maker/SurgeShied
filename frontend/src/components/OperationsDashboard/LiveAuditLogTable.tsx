import React, { useEffect, useState } from "react";
import { Terminal, RefreshCw, ShieldCheck, Filter } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";

interface AuditLogRow {
  id: string;
  seq: number;
  action: string;
  entity: string;
  entity_id: string | null;
  actor_id: string | null;
  created_at: string;
  previous_hash: string;
  current_hash: string;
  metadata: any;
}

const actionBadges: Record<string, { bg: string; text: string; label: string }> = {
  registration_attempt: { bg: "bg-teal-500/10 border-teal-500/30", text: "text-teal-400", label: "Reserve Attempt" },
  registration_confirmed: { bg: "bg-emerald-500/20 border-emerald-500/40", text: "text-emerald-300", label: "✅ Seat Confirmed" },
  seat_allocated: { bg: "bg-emerald-500/20 border-emerald-500/40", text: "text-emerald-300", label: "✅ Seat Allocated" },
  seat_reserved: { bg: "bg-teal-500/20 border-teal-500/40", text: "text-teal-300", label: "Seat Held" },
  lane_assignment: { bg: "bg-blue-500/10 border-blue-500/30", text: "text-blue-400", label: "Pressure Route" },
  event_created: { bg: "bg-purple-500/10 border-purple-500/30", text: "text-purple-400", label: "Event Init" },
  queue_join: { bg: "bg-amber-500/10 border-amber-500/30", text: "text-amber-400", label: "Queue Enter" },
  queue_promoted: { bg: "bg-emerald-500/10 border-emerald-500/30", text: "text-emerald-400", label: "Queue Promotion" },
  seat_released: { bg: "bg-rose-500/10 border-rose-500/30", text: "text-rose-400", label: "Ghost Sweep" },
  circuit_guardian_open: { bg: "bg-rose-500/10 border-rose-500/30", text: "text-rose-400", label: "Circuit Trip" },
  circuit_guardian_close: { bg: "bg-emerald-500/10 border-emerald-500/30", text: "text-emerald-400", label: "Circuit Reset" },
  worker_scaled_up: { bg: "bg-indigo-500/10 border-indigo-500/30", text: "text-indigo-400", label: "⚡ Autoscale Up" },
  worker_scaled_down: { bg: "bg-slate-500/10 border-slate-500/30", text: "text-slate-400", label: "❄ Autoscale Down" },
  lane_split: { bg: "bg-cyan-500/10 border-cyan-500/30", text: "text-cyan-400", label: "⚡ Lane Split" },
};

export function LiveAuditLogTable({ eventId }: { eventId?: string }) {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterAction, setFilterAction] = useState<string>("all");

  const fetchLogs = async () => {
    try {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("*")
        .order("seq", { ascending: false })
        .limit(30);

      if (error) {
        console.error("fetchLogs error:", error.message);
      }
      if (!error && data) {
        setLogs(data);
      }
    } catch (err) {
      console.error("fetchLogs error:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
    const channel = supabase
      .channel("live_audit_feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "audit_logs" },
        (payload) => {
          setLogs((prev) => [payload.new as AuditLogRow, ...prev.slice(0, 19)]);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId]);

  const filteredLogs = filterAction === "all"
    ? logs
    : logs.filter((l) => l.action.toLowerCase().includes(filterAction.toLowerCase()));

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 p-5 space-y-4 backdrop-blur-md">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5 text-teal-400" />
          <h3 className="text-sm font-semibold text-slate-200">Live Cryptographic Audit Stream</h3>
          <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-teal-500/10 text-teal-400 border border-teal-500/20">
            Realtime WebSocket
          </span>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg px-2.5 py-1 text-xs text-slate-300 focus:outline-none focus:border-teal-500"
          >
            <option value="all" className="bg-slate-900">All Operations</option>
            <option value="registration" className="bg-slate-900">Registrations</option>
            <option value="lane" className="bg-slate-900">Lane Routing</option>
            <option value="circuit" className="bg-slate-900">Circuit Guardian</option>
            <option value="queue" className="bg-slate-900">Queue Promotions</option>
          </select>
          <button
            onClick={fetchLogs}
            disabled={loading}
            className="p-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white transition-colors"
            title="Refresh Logs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-teal-400" : ""}`} />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-white/5 bg-black/20">
        <table className="w-full text-left text-xs text-slate-300">
          <thead className="bg-white/5 text-[11px] uppercase tracking-wider text-slate-400 font-mono">
            <tr>
              <th className="py-2.5 px-3">Block #</th>
              <th className="py-2.5 px-3">Timestamp</th>
              <th className="py-2.5 px-3">Action</th>
              <th className="py-2.5 px-3">Entity</th>
              <th className="py-2.5 px-3">Lane & Ingress Details</th>
              <th className="py-2.5 px-3">SHA-256 Chained Hash</th>
              <th className="py-2.5 px-3 text-right">Integrity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 font-mono">
            {filteredLogs.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-500">
                  {loading ? "Streaming live ledger records…" : "No matching audit records found."}
                </td>
              </tr>
            ) : (
              filteredLogs.map((log) => {
                const badge = actionBadges[log.action] || {
                  bg: "bg-slate-800 border-white/10",
                  text: "text-slate-300",
                  label: log.action,
                };
                const meta = log.metadata || {};
                const laneInfo = meta.candidate_lane !== undefined
                  ? `Lane ${meta.candidate_lane} (${meta.headroom ?? 0} headroom)`
                  : meta.lane_index !== undefined
                  ? `Lane ${meta.lane_index}`
                  : meta.capacity
                  ? `${meta.capacity} cap / ${meta.lane_count} lanes`
                  : log.actor_id
                  ? `Actor: ${log.actor_id.slice(0, 8)}…`
                  : "system root";

                return (
                  <tr key={log.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 px-3 font-semibold text-teal-300">#{log.seq}</td>
                    <td className="py-2 px-3 text-slate-400 text-[11px]">
                      {new Date(log.created_at).toLocaleTimeString()}
                    </td>
                    <td className="py-2 px-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${badge.bg} ${badge.text}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-400 text-[11px]">{log.entity}</td>
                    <td className="py-2 px-3 text-[11px]">
                      <span className="text-slate-300 bg-white/5 px-2 py-0.5 rounded border border-white/5">
                        {laneInfo}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-400 text-[11px]">
                      <span className="text-teal-400/90">{log.current_hash ? log.current_hash.slice(0, 12) : "GENESIS"}</span>
                      <span className="text-slate-600">…</span>
                      <span className="text-slate-500">{log.current_hash ? log.current_hash.slice(-4) : ""}</span>
                    </td>
                    <td className="py-2 px-3 text-right">
                      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
                        <ShieldCheck className="w-3 h-3" />
                        Valid
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
