import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { Clock, ShieldCheck, Lock, ArrowLeft, Sparkles, Zap, Loader2, Users, Gauge, TicketX, AlertCircle, RefreshCw } from "lucide-react";
import { LiteModeBanner } from "../components/LiteModeBanner";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/auth";
import { getOpsMetrics } from "../lib/api";

const SECONDS_PER_BOOKING_WINDOW = 120; // 2 minutes booking allotment per attendee
const OPS_POLL_MS = 5000;

type QueueStatus = "loading" | "waiting" | "not_found";

export function QueueScreen() {
  const { id } = useParams<{ id: string }>();
  const { session } = useAuth();
  const navigate = useNavigate();
  const [entry, setEntry] = useState<{ lane_index: number; position: number | null } | null>(null);
  const [movement, setMovement] = useState<number>(0); // positive = moved up this many spots
  const [eventTitle, setEventTitle] = useState<string>("");
  const [simulatingPromotion, setSimulatingPromotion] = useState(false);
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus>("loading");
  const [notFoundReason, setNotFoundReason] = useState<string | null>(null);
  const [processingRate, setProcessingRate] = useState<number | null>(null);
  const [seatsRemaining, setSeatsRemaining] = useState<number | null>(null);
  const prevPositionRef = useRef<number | null>(null);

  useEffect(() => {
    if (!id) return;
    supabase.from("events").select("title").eq("id", id).single().then(({ data }) => {
      if (data) setEventTitle(data.title);
    });
  }, [id]);

  // Best-effort context (queue processing speed, seats left overall) — never
  // blocks the position display if it fails, since it's supplementary.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const m = await getOpsMetrics(id);
        if (!cancelled) {
          setProcessingRate(m.queue_processing_rate_per_min);
          setSeatsRemaining(m.seats_remaining);
        }
      } catch {
        // supplementary only — ignore.
      }
    };
    tick();
    const interval = setInterval(tick, OPS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id]);

  useEffect(() => {
    if (!id || !session) return;
    const userId = session.user.id;

    async function loadPosition() {
      const { data: queueRow } = await supabase
        .from("queue_entries")
        .select("lane_index")
        .eq("event_id", id)
        .eq("user_id", userId)
        .eq("status", "waiting")
        .maybeSingle();

      if (!queueRow) {
        // Check if user already got promoted into confirmed registration
        const { data: reg } = await supabase
          .from("registrations")
          .select("id")
          .eq("event_id", id)
          .eq("user_id", userId)
          .eq("status", "confirmed")
          .maybeSingle();

        if (reg) {
          navigate(`/events/${id}`);
          return;
        }

        // Not waiting AND not confirmed. The old behavior was to silently
        // `return` here, which left the "Calculating your queue
        // placement…" spinner on screen forever with no explanation — the
        // exact "queue disappeared" failure mode this screen must never
        // produce. Look up why, and always show a reason.
        const { data: drainLog } = await supabase
          .from("audit_logs")
          .select("metadata, created_at")
          .eq("entity", "event")
          .eq("entity_id", id)
          .eq("action", "queue_drained")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const meta = (drainLog?.metadata ?? {}) as { reason?: string; lane_index?: number };
        setQueueStatus("not_found");
        setNotFoundReason(
          drainLog
            ? `Queue cleared on Lane ${meta.lane_index ?? "?"}: ${meta.reason ?? "all waiting attendees were processed"}.`
            : "You're not currently showing in this event's waiting queue. This can happen if you were already promoted from another tab or device, or if your place expired. Check your registration status below.",
        );
        return;
      }

      setQueueStatus("waiting");
      const { data: position } = await supabase.rpc("queue_position", {
        p_event_id: id,
        p_lane_index: queueRow.lane_index,
        p_user_id: userId,
      });

      if (prevPositionRef.current != null && position != null) {
        setMovement(prevPositionRef.current - position);
      }
      prevPositionRef.current = position ?? null;
      setEntry({ lane_index: queueRow.lane_index, position });
    }

    loadPosition();

    const channel = supabase
      .channel(`queue:${id}:${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "queue_entries", filter: `event_id=eq.${id}` },
        () => loadPosition(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "registrations", filter: `event_id=eq.${id}` },
        (payload) => {
          if ((payload.new as { user_id: string }).user_id === userId) {
            navigate(`/events/${id}`);
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "registrations", filter: `event_id=eq.${id}` },
        (payload) => {
          if ((payload.new as { user_id: string }).user_id === userId) {
            navigate(`/events/${id}`);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, session, navigate]);

  // Demo helper: Instantly trigger promotion for demo / testing.
  //
  // Previously, when the promote_from_queue RPC returned null (no seat
  // actually available), this fell back to a raw upsert that faked a
  // "confirmed" registration client-side — bypassing allocate_seat()'s
  // locking entirely. It's blocked by RLS today (registrations can only be
  // written by service_role), so it was never a live overbooking hole, but
  // it silently swallowed that failure and still navigated the user to the
  // event page as if they had a real seat. Never fabricate a confirmation:
  // report the real outcome instead.
  const handleInstantPromotion = async () => {
    if (!id || !session || !entry) return;
    setSimulatingPromotion(true);
    setPromotionError(null);
    try {
      const { data: reg, error } = await supabase.rpc("promote_from_queue", {
        p_event_id: id,
        p_lane_index: entry.lane_index,
      });

      if (error) throw error;

      if (!reg) {
        setPromotionError(
          "No seat is available to promote into right now — the lane may still be full, or someone else was processed first. Your place in line is unaffected; you'll be promoted automatically the moment a seat frees up.",
        );
        return;
      }

      navigate(`/events/${id}`);
    } catch (err) {
      console.warn("Promotion helper:", err);
      setPromotionError("Couldn't reach the promotion service just now — please try again in a moment.");
    } finally {
      setSimulatingPromotion(false);
    }
  };

  if (!id) return null;

  const estimatedMinutesFallback = entry?.position ? Math.ceil((entry.position * SECONDS_PER_BOOKING_WINDOW) / 60) : 2;
  const estimatedMinutes =
    processingRate && processingRate > 0 && entry?.position
      ? Math.max(1, Math.ceil(entry.position / processingRate))
      : estimatedMinutesFallback;
  const peopleAhead = entry?.position ? Math.max(0, entry.position - 1) : 0;

  return (
    <div className="max-w-md mx-auto px-4 sm:px-6 py-12 text-center space-y-6">
      <div className="text-left">
        <Link to={`/events/${id}`} className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors">
          <ArrowLeft size={14} />
          <span>Back to Event</span>
        </Link>
      </div>

      <LiteModeBanner eventId={id} />

      <div className="space-y-1">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-teal-500/10 border border-teal-500/30 text-teal-300 text-xs font-semibold">
          <Sparkles size={13} />
          <span>Dynamic Waiting Queue Active</span>
        </div>
        <h1 className="text-2xl font-bold text-white mt-2">You're in the Waiting Queue</h1>
        <p className="text-xs text-slate-400">{eventTitle || "High-demand partitioned ticket drop"}</p>
      </div>

      {queueStatus === "not_found" ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-950/20 p-8 space-y-4 text-left">
          <div className="flex items-start gap-2.5">
            <AlertCircle size={18} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-amber-200">You're no longer in this queue</p>
              <p className="text-xs text-slate-300 leading-relaxed">{notFoundReason}</p>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => window.location.reload()}
              className="flex-1 py-2 px-3 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
            >
              <RefreshCw size={13} /> Recheck Status
            </button>
            <Link
              to={`/events/${id}`}
              className="flex-1 py-2 px-3 rounded-lg bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/30 text-teal-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
            >
              Go to Event
            </Link>
          </div>
        </div>
      ) : entry ? (
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 backdrop-blur-xl p-8 space-y-6 shadow-2xl">
          <div className="space-y-1">
            <div className="flex items-center justify-center gap-2">
              <p className="text-6xl font-black tracking-tight text-teal-400 font-mono">
                #{entry.position ?? "1"}
              </p>
              {movement !== 0 && (
                <span
                  className={`text-xs font-mono font-semibold ${movement > 0 ? "text-emerald-400" : "text-slate-500"}`}
                  title="Change since last update"
                >
                  {movement > 0 ? `▲${movement}` : `▼${Math.abs(movement)}`}
                </span>
              )}
            </div>
            <p className="text-sm font-semibold text-slate-200">
              Position in Line
            </p>
            <p className="text-[11px] text-slate-500">{peopleAhead} attendee{peopleAhead === 1 ? "" : "s"} ahead of you</p>
          </div>

          <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-2 text-left">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Clock size={14} className="text-teal-400" />
                <span>Est. Wait Time:</span>
              </span>
              <span className="font-semibold text-white font-mono">~{estimatedMinutes} min</span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Gauge size={14} className="text-teal-400" />
                <span>Processing Speed:</span>
              </span>
              <span className="font-semibold text-white font-mono">
                {processingRate != null ? `${processingRate}/min` : "—"}
              </span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center gap-1.5">
                <TicketX size={14} className="text-teal-400" />
                <span>Seats Remaining:</span>
              </span>
              <span className="font-semibold text-white font-mono">{seatsRemaining ?? "—"}</span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center gap-1.5">
                <ShieldCheck size={14} className="text-teal-400" />
                <span>Booking Window:</span>
              </span>
              <span className="font-semibold text-teal-300 font-mono">2 min (Max 6 min)</span>
            </div>
          </div>

          {/* Strict No-Switching Policy Banner */}
          <div className="rounded-xl border border-indigo-500/30 bg-indigo-950/20 p-3.5 flex items-start gap-2.5 text-left">
            <Lock size={16} className="text-indigo-400 shrink-0 mt-0.5" />
            <div className="text-[11px] text-slate-300 leading-relaxed">
              <span className="font-bold text-indigo-300">Strict Anti-Hopping Policy: </span>
              Assigned dynamically based on shortest wait time. Lane switching is locked to protect FIFO queue fairness.
            </div>
          </div>

          {/* Instant Simulation Promotion Button for Demo */}
          <div className="pt-2 border-t border-white/5 space-y-2">
            <button
              onClick={handleInstantPromotion}
              disabled={simulatingPromotion}
              className="w-full py-2.5 px-4 rounded-xl bg-teal-500/10 hover:bg-teal-500/20 text-teal-300 border border-teal-500/30 text-xs font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50"
            >
              {simulatingPromotion ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Promoting into Seat…</span>
                </>
              ) : (
                <>
                  <Zap size={14} className="text-teal-400" />
                  <span>⚡ Simulate Seat Release (Promote Me Now)</span>
                </>
              )}
            </button>
            {promotionError && (
              <p className="text-[11px] text-amber-300 bg-amber-950/20 border border-amber-500/30 rounded-lg px-3 py-2 text-left leading-relaxed">
                {promotionError}
              </p>
            )}
            <p className="text-[10px] text-slate-500">
              (In production, Ghost Seat Recovery auto-promotes you within 2 minutes when a cart expires).
            </p>
          </div>

          <div className="text-[11px] text-slate-500 font-mono flex items-center justify-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-teal-400 animate-ping" />
            <span>Listening for seat releases in real-time…</span>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-8 text-slate-400 text-xs flex flex-col items-center gap-2">
          <Users size={18} className="text-teal-400 animate-pulse" />
          <span>Calculating your dynamic queue placement…</span>
        </div>
      )}
    </div>
  );
}
