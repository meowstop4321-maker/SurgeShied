import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Terminal,
  Pause,
  Play,
  Trash2,
  Search,
  ChevronDown,
  CheckCircle2,
  Info,
  AlertTriangle,
  XCircle,
  RotateCw,
  Users,
} from "lucide-react";
import { supabase } from "../../lib/supabaseClient";

// Cloud-Logging-style live stream: every audit_logs row is a real event that
// actually happened in the database (registration attempts, lane routing,
// queue promotions/drains, retries, dead-lettering, circuit trips, worker
// scaling) — this console just gives every action a color, an icon, and a
// plain-English sentence so a judge watching it can follow the system
// without reading Postgres rows. The mapping below is kept in sync with
// every `append_audit_log` call site in the repo (supabase/functions,
// worker/, supabase/migrations) — if you add a new audit action anywhere,
// add it here too or it'll fall back to a generic, less useful line.

type LogLevel = "success" | "info" | "warning" | "error" | "retry" | "queue";

interface AuditLogRow {
  id: string;
  seq: number;
  action: string;
  entity: string;
  entity_id: string | null;
  actor_id: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

const LEVEL_STYLE: Record<LogLevel, { label: string; text: string; dot: string; icon: React.ComponentType<{ size?: number | string; className?: string }> }> = {
  success: { label: "SUCCESS", text: "text-emerald-400", dot: "bg-emerald-400", icon: CheckCircle2 },
  info: { label: "INFO", text: "text-blue-400", dot: "bg-blue-400", icon: Info },
  warning: { label: "WARN", text: "text-amber-400", dot: "bg-amber-400", icon: AlertTriangle },
  error: { label: "ERROR", text: "text-rose-400", dot: "bg-rose-400", icon: XCircle },
  retry: { label: "RETRY", text: "text-orange-400", dot: "bg-orange-400", icon: RotateCw },
  queue: { label: "QUEUE", text: "text-purple-400", dot: "bg-purple-400", icon: Users },
};

// `muted: true` marks routine, high-frequency, low-information events (a
// request arrived / a routing decision was made) so they visually recede
// behind the outcomes that actually matter (confirmed, queued, failed,
// retried) — the same "signal over noise" principle a real ops console
// uses so the important lines don't get lost in chatter.
const ACTION_META: Record<string, { level: LogLevel; muted?: boolean }> = {
  registration_attempt: { level: "info", muted: true },
  lane_assignment: { level: "info", muted: true },
  registration_confirmed: { level: "success" },
  seat_reserved: { level: "success" },
  queue_join: { level: "queue" },
  queue_promoted: { level: "queue" },
  queue_drained: { level: "queue" },
  seat_released: { level: "warning" },
  rate_limited: { level: "warning" },
  registration_failed: { level: "error" },
  job_retry_scheduled: { level: "retry" },
  job_dead_lettered: { level: "error" },
  dlq_reprocessed: { level: "success" },
  circuit_guardian_open: { level: "error" },
  circuit_guardian_close: { level: "success" },
  worker_scaled_up: { level: "info" },
  worker_scaled_down: { level: "info" },
  lane_split: { level: "info" },
  lane_merge: { level: "info" },
  event_created: { level: "info", muted: true },
  lite_mode_activated: { level: "warning" },
  lite_mode_deactivated: { level: "success" },
};

function levelFor(action: string): LogLevel {
  return ACTION_META[action]?.level ?? "info";
}

function isMuted(action: string): boolean {
  return ACTION_META[action]?.muted ?? false;
}

// Turns a raw action + metadata row into the one-line, human-readable
// sentence the requirements ask for — e.g. an emptied queue must say
// exactly why, not just disappear, and a confirmed seat must say so
// explicitly rather than leaving the viewer to infer success from the
// absence of an error.
function messageFor(log: AuditLogRow): string {
  const m = log.metadata ?? {};
  const laneTag = m.lane_index != null ? `[Lane ${m.lane_index}] ` : m.candidate_lane != null ? `[Lane ${m.candidate_lane}] ` : "";
  const user = m.user_tag ? `@${m.user_tag}` : m.user_id ? `@user_${String(m.user_id).slice(0, 6)}` : log.actor_id ? `@${log.actor_id.slice(0, 8)}` : "Attendee";

  switch (log.action) {
    case "registration_attempt":
      return `${laneTag}📥 Ingress: ${user} arrived → routing to parallel partition`;
    case "lane_assignment":
      return `${laneTag}🔄 Routed: ${user} directed to Lane ${m.candidate_lane ?? m.lane_index ?? 0} (${m.headroom ?? 0} seats free)`;
    case "registration_confirmed":
    case "seat_allocated": {
      const laneDetails = m.seats_taken != null && m.capacity ? ` (${m.seats_taken}/${m.capacity} in lane)` : "";
      const totalDetails = m.total_booked ? ` · Total Booked: ${m.total_booked} seats` : "";
      return `${laneTag}✅ CONFIRMED: ${user} booked seat${laneDetails}${totalDetails}`;
    }
    case "seat_reserved":
      return `${laneTag}🎟️ HELD: Seat reserved for ${user} — checkout window active`;
    case "queue_join":
      return m.count
        ? `${laneTag}⏳ QUEUED: ${m.count} attendees placed in Waiting Queue (${m.reason ?? "lane capacity reached"})`
        : `${laneTag}⏳ QUEUED: Lane capacity reached → ${user} placed in Waiting Queue at #${m.position ?? "1"}`;
    case "queue_promoted":
      return `${laneTag}🚀 PROMOTED: ${user} upgraded from queue to confirmed seat`;
    case "queue_drained":
      return `${laneTag}Queue cleared — ${m.reason ?? "all waiting attendees processed"}`;
    case "seat_released":
      return `${laneTag}⚠️ RELEASED: Ghost seat reclaimed into inventory`;
    case "rate_limited":
      return `${laneTag}⚠️ THROTTLED: ${user} rate-limited — retry allowed in ${m.retry_after ?? "?"}s`;
    case "registration_failed":
      return `${laneTag}❌ FAILED: ${user} transaction rejected (${m.reason ?? m.message ?? m.detail ?? "unknown error"})`;
    case "job_retry_scheduled":
      return `${laneTag}🔄 RETRY: ${m.job_type ?? "Job"} failed (attempt ${m.attempt}/${m.max_attempts}) — retrying in ${m.retry_in_seconds}s`;
    case "job_dead_lettered":
      return `${laneTag}❌ DLQ: ${m.job_type ?? "Job"} exhausted retries → Dead Letter Queue`;
    case "dlq_reprocessed":
      return `${laneTag}✅ REPROCESSED: ${m.job_type ?? "Job"} replay triggered from Dead Letter Queue`;
    case "circuit_guardian_open":
      return `🛑 CIRCUIT BREAKER: Tripped OPEN (${m.reason ?? "downstream failures"})`;
    case "circuit_guardian_close":
      return `✅ CIRCUIT BREAKER: Reset to CLOSED — normal operations restored`;
    case "worker_scaled_up":
      return `⚡ AUTOSCALE UP: Worker pool scaled ${m.from_workers} → ${m.to_workers} workers (${m.pending_jobs ?? 0} pending jobs)`;
    case "worker_scaled_down":
      return `❄ AUTOSCALE DOWN: Worker pool scaled ${m.from_workers} → ${m.to_workers} workers`;
    case "lane_split":
      return `${laneTag}⚡ PARTITION SPLIT: Dynamic lane divided under surge pressure`;
    case "lane_merge":
      return `${laneTag}PARTITIONS MERGED: Capacity consolidated`;
    case "event_created":
      return `Event "${m.title ?? "untitled"}" initialized with ${m.capacity ?? "?"} seats across ${m.lane_count ?? 4} lanes`;
    case "lite_mode_activated":
      return `⚠️ LITE MODE: Graceful degradation activated — non-critical assets shed`;
    case "lite_mode_deactivated":
      return `✅ LITE MODE: Deactivated — full interactive mode restored`;
    default:
      return `${laneTag}${log.action.replace(/_/g, " ").toUpperCase()}`;
  }
}

const MAX_VISIBLE = 300;

export function LiveLogConsole({ eventId }: { eventId?: string }) {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<"all" | LogLevel>("all");
  const bufferRef = useRef<AuditLogRow[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("audit_logs")
      .select("id, seq, action, entity, entity_id, actor_id, created_at, metadata")
      .order("seq", { ascending: false })
      .limit(100)
      .then(({ data }) => {
        if (!cancelled && data) setLogs([...data].reverse());
      });

    const channel = supabase
      .channel("live_log_console")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "audit_logs" }, (payload) => {
        const row = payload.new as AuditLogRow;
        if (pausedRef.current) {
          bufferRef.current.push(row);
          setPendingCount(bufferRef.current.length);
        } else {
          setLogs((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), row]);
        }
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, paused]);

  const resume = () => {
    setPaused(false);
    if (bufferRef.current.length) {
      setLogs((prev) => [...prev, ...bufferRef.current].slice(-MAX_VISIBLE));
      bufferRef.current = [];
      setPendingCount(0);
    }
  };

  const filtered = useMemo(() => {
    return logs.filter((l) => {
      if (levelFilter !== "all" && levelFor(l.action) !== levelFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const msg = messageFor(l).toLowerCase();
        if (!msg.includes(q) && !l.action.toLowerCase().includes(q) && !(l.entity_id ?? "").toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [logs, levelFilter, search]);

  // The single most recent, non-muted event — shown as a large headline
  // above the scrolling stream so "what's happening right now" never
  // requires reading a wall of text to find. Falls back to the very latest
  // line (even a muted one) if nothing louder has happened yet.
  const headline = useMemo(() => {
    for (let i = logs.length - 1; i >= 0; i--) {
      if (!isMuted(logs[i].action)) return logs[i];
    }
    return logs[logs.length - 1];
  }, [logs]);

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 backdrop-blur-md overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5 text-teal-400" />
          <h3 className="text-sm font-semibold text-slate-200">Live Log Stream</h3>
          <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-teal-500/10 text-teal-400 border border-teal-500/20">
            {paused ? `Paused (${pendingCount} buffered)` : "Live"}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search logs…"
              className="bg-white/5 border border-white/10 rounded-lg pl-7 pr-2.5 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-teal-500 w-36 sm:w-48"
            />
          </div>
          <div className="relative">
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value as "all" | LogLevel)}
              className="appearance-none bg-white/5 border border-white/10 rounded-lg pl-2.5 pr-6 py-1 text-xs text-slate-300 focus:outline-none focus:border-teal-500"
            >
              <option value="all" className="bg-slate-900">All levels</option>
              <option value="success" className="bg-slate-900">Success</option>
              <option value="info" className="bg-slate-900">Info</option>
              <option value="warning" className="bg-slate-900">Warning</option>
              <option value="error" className="bg-slate-900">Error</option>
              <option value="retry" className="bg-slate-900">Retry</option>
              <option value="queue" className="bg-slate-900">Queue</option>
            </select>
            <ChevronDown className="w-3 h-3 text-slate-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
          <button
            onClick={() => (paused ? resume() : setPaused(true))}
            className="p-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white transition-colors"
            title={paused ? "Resume stream" : "Pause stream"}
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => setLogs([])}
            className="p-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white transition-colors"
            title="Clear (visible only — nothing is deleted)"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {headline && (
        <div className="px-4 py-3 border-b border-white/10 bg-black/20">
          <p className="text-[10px] uppercase tracking-wider text-slate-500 font-mono mb-1">Right now</p>
          {(() => {
            const level = levelFor(headline.action);
            const style = LEVEL_STYLE[level];
            const Icon = style.icon;
            return (
              <div className="flex items-start gap-2">
                <Icon size={16} className={`shrink-0 mt-0.5 ${style.text}`} />
                <p className={`text-sm font-semibold leading-snug ${style.text}`}>{messageFor(headline)}</p>
              </div>
            );
          })()}
        </div>
      )}

      <div ref={scrollRef} className="h-80 overflow-y-auto bg-black/30 font-mono text-xs p-3 space-y-1">
        {filtered.length === 0 ? (
          <div className="text-slate-500 text-center py-10">No log lines match the current filter.</div>
        ) : (
          filtered.map((log) => {
            const level = levelFor(log.action);
            const style = LEVEL_STYLE[level];
            const Icon = style.icon;
            const muted = isMuted(log.action);
            return (
              <div
                key={log.id}
                className={`flex items-start gap-2 leading-relaxed hover:bg-white/[0.03] rounded px-1 ${muted ? "opacity-60" : ""}`}
              >
                <span className="text-slate-600 shrink-0">{new Date(log.created_at).toLocaleTimeString()}</span>
                <Icon size={12} className={`shrink-0 mt-0.5 ${style.text}`} />
                <span className={`shrink-0 font-bold w-14 ${style.text}`}>{style.label}</span>
                <span className={`break-words ${muted ? "text-slate-500" : "text-slate-300"}`}>{messageFor(log)}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
