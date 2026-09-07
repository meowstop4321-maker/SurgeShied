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
  Bug,
  Activity,
} from "lucide-react";
import { supabase } from "../../lib/supabaseClient";

type LogLevel = "success" | "info" | "warning" | "error" | "retry" | "queue" | "debug";

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

const LEVEL_STYLE: Record<
  LogLevel,
  { label: string; text: string; dot: string; icon: React.ComponentType<{ size?: number | string; className?: string }> }
> = {
  success: { label: "SUCCESS", text: "text-emerald-400", dot: "bg-emerald-400", icon: CheckCircle2 },
  info: { label: "INFO", text: "text-blue-400", dot: "bg-blue-400", icon: Info },
  warning: { label: "WARN", text: "text-amber-400", dot: "bg-amber-400", icon: AlertTriangle },
  error: { label: "ERROR", text: "text-rose-400", dot: "bg-rose-400", icon: XCircle },
  retry: { label: "RETRY", text: "text-orange-400", dot: "bg-orange-400", icon: RotateCw },
  queue: { label: "QUEUE", text: "text-purple-400", dot: "bg-purple-400", icon: Users },
  debug: { label: "DEBUG", text: "text-teal-400", dot: "bg-teal-400", icon: Bug },
};

const ACTION_META: Record<string, { level: LogLevel; muted?: boolean }> = {
  registration_attempt: { level: "info", muted: true },
  lane_assignment: { level: "info", muted: true },
  registration_confirmed: { level: "success" },
  seat_allocated: { level: "success" },
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
  scaling_out_triggered: { level: "info" },
  scaling_in_triggered: { level: "info" },
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

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${h}:${m}:${s}.${ms}`;
  } catch {
    return iso;
  }
}

function messageFor(log: AuditLogRow, debugMode: boolean): string {
  const m = log.metadata ?? {};
  const lane = m.lane_index != null ? `Lane ${m.lane_index}` : m.candidate_lane != null ? `Lane ${m.candidate_lane}` : null;
  const laneTag = lane ? `[${lane}] ` : "";
  const pktTag = log.seq ? `[Pkt #${log.seq}] ` : "";
  
  const rawUser = (m.user_tag as string) || (m.user_id as string) || log.actor_id || "DEMO";
  const user = rawUser.startsWith("U-")
    ? rawUser
    : rawUser.startsWith("demo_") || rawUser.startsWith("attendee_")
    ? `U-${rawUser.replace(/^(demo_|attendee_)/, "").slice(0, 5).toUpperCase()}`
    : `U-${String(rawUser).slice(0, 5).toUpperCase()}`;

  switch (log.action) {
    case "registration_attempt":
      return debugMode
        ? `${pktTag}${laneTag}Ingress: User ${user} arrived → calculating crowd pressure routing`
        : `${laneTag}📥 Ingress: User ${user} arrived → routing to parallel partition`;

    case "lane_assignment":
      return `${pktTag}${laneTag}User ${user} assigned to ${lane ?? "Lane 0"} | Headroom: ${m.headroom ?? 250} seats free`;

    case "registration_confirmed":
    case "seat_allocated": {
      const laneDetails = m.seats_taken != null && m.capacity ? ` (${m.seats_taken}/${m.capacity} in lane)` : "";
      const totalDetails = m.total_booked ? ` · Total Booked: ${m.total_booked}` : "";
      const countDetails = m.count ? ` (${m.count} seats allocated)` : "";
      return `${pktTag}${laneTag}User ${user} successfully completed registration${countDetails}${laneDetails}${totalDetails}`;
    }

    case "seat_reserved":
      return `${pktTag}${laneTag}Held: Seat reserved for ${user} — checkout window active (120s)`;

    case "queue_join":
      if (m.count) {
        return `${pktTag}${laneTag}⏳ QUEUED: ${m.count} attendees placed in Waiting Queue (${m.reason ?? "lane capacity reached"})`;
      }
      return `${pktTag}${laneTag}User ${user} is waiting in ${lane ?? "Queue"} | Position: #${m.position ?? 1} | Ahead: ${(Number(m.position) || 1) - 1}`;

    case "queue_promoted":
      return `${pktTag}${laneTag}🚀 PROMOTED: ${user} upgraded from queue to confirmed seat`;

    case "queue_drained":
      return `${pktTag}${laneTag}Queue cleared — ${m.reason ?? "all waiting attendees processed"}`;

    case "seat_released":
      return `${pktTag}${laneTag}⚠️ RELEASED: Ghost seat reclaimed into inventory`;

    case "rate_limited":
      return `${pktTag}${laneTag}⚠️ THROTTLED: User ${user} rate-limited — retry allowed in ${m.retry_after ?? "?"}s`;

    case "registration_failed":
      return `${pktTag}${laneTag}❌ FAILED: User ${user} validation rejected (${m.reason ?? m.message ?? m.detail ?? "unknown error"})`;

    case "job_retry_scheduled":
      return `${pktTag}${laneTag}🔄 RETRY: ${m.job_type ?? "Job"} failed (attempt ${m.attempt}/${m.max_attempts}) — retrying in ${m.retry_in_seconds}s`;

    case "job_dead_lettered":
      return `${pktTag}${laneTag}❌ DLQ: User ${user} moved to Dead Letter Queue after ${m.max_attempts ?? 3} failed attempts`;

    case "dlq_reprocessed":
      return `${pktTag}${laneTag}✅ REPROCESSED: ${m.job_type ?? "Job"} replay triggered from Dead Letter Queue`;

    case "circuit_guardian_open":
      return `🛑 CIRCUIT BREAKER: Tripped OPEN (${m.reason ?? "downstream failures"})`;

    case "circuit_guardian_close":
      return `✅ CIRCUIT BREAKER: Reset to CLOSED — normal operations restored`;

    case "worker_scaled_up":
      return `⚡ AUTOSCALE UP: Worker pool scaled ${m.from_workers} → ${m.to_workers} workers (${m.pending_jobs ?? 0} pending jobs)`;

    case "worker_scaled_down":
      return `❄ AUTOSCALE DOWN: Worker pool scaled ${m.from_workers} → ${m.to_workers} workers`;

    case "scaling_out_triggered":
    case "lane_split": {
      const reason = m.trigger_reason ? ` | ${m.trigger_reason}` : "";
      const cap = m.capacity_redistributed ? ` | Cap: ${m.capacity_redistributed}` : "";
      const occ = m.occupancy_redistributed ? ` | Occ: ${m.occupancy_redistributed}` : "";
      const totalLanes = m.new_lane_count ? ` · Total: ${m.new_lane_count} active lanes` : "";
      return `🚀 SCALE-OUT: Lane ${m.lane_index ?? "?"} provisioned${reason}${cap}${occ}${totalLanes}`;
    }

    case "scaling_in_triggered":
    case "lane_merge": {
      const removed = m.removed_lane != null ? `Lane ${m.removed_lane}` : "idle lane";
      const target = m.lane_index != null ? `Lane ${m.lane_index}` : "Lane 0";
      const totalLanes = m.new_lane_count ? ` · ${m.new_lane_count} active lanes` : "";
      return `❄ SCALE-IN: ${removed} consolidated into ${target} (Idle cooldown active${totalLanes})`;
    }

    case "event_created":
      return `Event "${m.title ?? "untitled"}" initialized with ${m.capacity ?? "?"} seats across ${m.lane_count ?? 4} lanes`;

    case "lite_mode_activated":
      return `⚠️ LITE MODE: Graceful degradation activated — non-critical assets shed`;

    case "lite_mode_deactivated":
      return `✅ LITE MODE: Deactivated — full interactive mode restored`;

    default:
      return `${pktTag}${laneTag}${log.action.replace(/_/g, " ").toUpperCase()}`;
  }
}

const MAX_VISIBLE = 400;

export function LiveLogConsole({ eventId }: { eventId?: string }) {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [paused, setPaused] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<"all" | LogLevel>("all");
  const bufferRef = useRef<AuditLogRow[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const fetchLogs = () => {
    supabase
      .from("audit_logs")
      .select("id, seq, action, entity, entity_id, actor_id, created_at, metadata")
      .order("seq", { ascending: false })
      .limit(150)
      .then(({ data }) => {
        if (data) setLogs([...data].reverse());
      });
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);

    const channel = supabase
      .channel("live_log_console_stream")
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
      clearInterval(interval);
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
      if (!debugMode && isMuted(l.action) && levelFilter === "all") return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const msg = messageFor(l, debugMode).toLowerCase();
        if (!msg.includes(q) && !l.action.toLowerCase().includes(q) && !(l.entity_id ?? "").toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [logs, levelFilter, search, debugMode]);

  const headline = useMemo(() => {
    for (let i = logs.length - 1; i >= 0; i--) {
      if (!isMuted(logs[i].action)) return logs[i];
    }
    return logs[logs.length - 1];
  }, [logs]);

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 backdrop-blur-md overflow-hidden">
      {/* Console Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <Terminal className="w-5 h-5 text-teal-400" />
          <h3 className="text-sm font-semibold text-slate-200">Live Operational Log Stream</h3>
          <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-teal-500/10 text-teal-400 border border-teal-500/20">
            {paused ? `Paused (${pendingCount} buffered)` : "Live Stream"}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap font-mono text-xs">
          {/* Debug Mode Toggle */}
          <button
            onClick={() => setDebugMode(!debugMode)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-colors ${
              debugMode
                ? "bg-teal-500/20 text-teal-300 border-teal-500/40 shadow-[0_0_10px_rgba(20,184,166,0.2)]"
                : "bg-white/5 text-slate-400 border-white/10 hover:text-white"
            }`}
            title="Toggle fine-grained packet routing & state transition logs"
          >
            <Bug className="w-3.5 h-3.5" />
            <span>Debug Mode {debugMode ? "ON" : "OFF"}</span>
          </button>

          {/* Search */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search user / lane…"
              className="bg-white/5 border border-white/10 rounded-lg pl-7 pr-2.5 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-teal-500 w-36 sm:w-44"
            />
          </div>

          {/* Level Filter */}
          <div className="relative">
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value as "all" | LogLevel)}
              className="appearance-none bg-white/5 border border-white/10 rounded-lg pl-2.5 pr-6 py-1 text-xs text-slate-300 focus:outline-none focus:border-teal-500"
            >
              <option value="all" className="bg-slate-900">All Levels</option>
              <option value="success" className="bg-slate-900">Success</option>
              <option value="queue" className="bg-slate-900">Queue</option>
              <option value="retry" className="bg-slate-900">Retry</option>
              <option value="info" className="bg-slate-900">Info</option>
              <option value="warning" className="bg-slate-900">Warning</option>
              <option value="error" className="bg-slate-900">Error</option>
            </select>
            <ChevronDown className="w-3 h-3 text-slate-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          {/* Controls */}
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
            title="Clear display"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Right Now Headline */}
      {headline && (
        <div className="px-4 py-2.5 border-b border-white/10 bg-black/20 font-mono">
          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">Most Recent State Transition</p>
          {(() => {
            const level = levelFor(headline.action);
            const style = LEVEL_STYLE[level];
            const Icon = style.icon;
            return (
              <div className="flex items-start gap-2">
                <Icon size={15} className={`shrink-0 mt-0.5 ${style.text}`} />
                <p className={`text-xs font-semibold leading-snug ${style.text}`}>{messageFor(headline, debugMode)}</p>
              </div>
            );
          })()}
        </div>
      )}

      {/* Log Feed */}
      <div ref={scrollRef} className="h-80 overflow-y-auto bg-black/30 font-mono text-xs p-3 space-y-1">
        {filtered.length === 0 ? (
          <div className="text-slate-500 text-center py-10">No log entries match the active filter.</div>
        ) : (
          filtered.map((log) => {
            const level = levelFor(log.action);
            const style = LEVEL_STYLE[level];
            const Icon = style.icon;
            const muted = isMuted(log.action);

            return (
              <div
                key={log.id}
                className={`flex items-start gap-2 leading-relaxed hover:bg-white/[0.04] rounded px-1.5 py-0.5 transition-colors ${
                  muted ? "opacity-70" : ""
                }`}
              >
                <span className="text-slate-500 shrink-0 text-[11px]">[{formatTimestamp(log.created_at)}]</span>
                <Icon size={12} className={`shrink-0 mt-1 ${style.text}`} />
                <span className={`shrink-0 font-bold w-14 text-[11px] ${style.text}`}>{style.label}</span>
                <span className={`break-words ${muted ? "text-slate-400" : "text-slate-200"}`}>
                  {messageFor(log, debugMode)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
