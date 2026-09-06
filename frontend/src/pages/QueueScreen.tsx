import React, { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { Clock, ShieldCheck, Lock, ArrowLeft, Sparkles, AlertCircle } from "lucide-react";
import { LiteModeBanner } from "../components/LiteModeBanner";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/auth";

const SECONDS_PER_BOOKING_WINDOW = 120; // 2 minutes booking allotment per attendee

export function QueueScreen() {
  const { id } = useParams<{ id: string }>();
  const { session } = useAuth();
  const navigate = useNavigate();
  const [entry, setEntry] = useState<{ lane_index: number; position: number | null } | null>(null);
  const [eventTitle, setEventTitle] = useState<string>("");

  useEffect(() => {
    if (!id) return;
    supabase.from("events").select("title").eq("id", id).single().then(({ data }) => {
      if (data) setEventTitle(data.title);
    });
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
        }
        return;
      }

      const { data: position } = await supabase.rpc("queue_position", {
        p_event_id: id,
        p_lane_index: queueRow.lane_index,
        p_user_id: userId,
      });
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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, session, navigate]);

  if (!id) return null;

  const estimatedMinutes = entry?.position ? Math.ceil((entry.position * SECONDS_PER_BOOKING_WINDOW) / 60) : 2;

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
          <span>Dynamic Lane Queue Active</span>
        </div>
        <h1 className="text-2xl font-bold text-white mt-2">You're in the Waiting Queue</h1>
        <p className="text-xs text-slate-400">{eventTitle || "High-demand partitioned ticket drop"}</p>
      </div>

      {entry ? (
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 backdrop-blur-xl p-8 space-y-6 shadow-2xl">
          <div className="space-y-1">
            <p className="text-6xl font-black tracking-tight text-teal-400 font-mono">
              #{entry.position ?? "1"}
            </p>
            <p className="text-sm font-semibold text-slate-200">
              Position in Lane {entry.lane_index}
            </p>
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

          <div className="text-[11px] text-slate-500 font-mono flex items-center justify-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-teal-400 animate-ping" />
            <span>Listening for seat releases in Lane #{entry.lane_index}…</span>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-8 text-slate-400 text-xs">
          Calculating your dynamic queue placement…
        </div>
      )}

      <p className="text-[11px] text-slate-500">
        When a seat is released, your Seat Passport will be issued automatically and redirect you to checkout.
      </p>
    </div>
  );
}
