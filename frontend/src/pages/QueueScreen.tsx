import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { LiteModeBanner } from "../components/LiteModeBanner";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/auth";

const ASSUMED_SECONDS_PER_PROMOTION = 4; // rough heuristic for an ETA, not a measured rate

export function QueueScreen() {
  const { id } = useParams<{ id: string }>();
  const { session } = useAuth();
  const navigate = useNavigate();
  const [entry, setEntry] = useState<{ lane_index: number; position: number | null } | null>(null);

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
      if (!queueRow) return;
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
          if ((payload.new as { user_id: string }).user_id === userId) navigate(`/events/${id}`);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, session, navigate]);

  if (!id) return null;

  return (
    <div className="max-w-md mx-auto px-6 py-16 text-center space-y-6">
      <LiteModeBanner eventId={id} />
      <h1 className="text-xl font-semibold text-slate-50">You're in the queue</h1>
      {entry ? (
        <div className="rounded-xl border border-white/10 bg-white/5 p-8">
          <p className="text-5xl font-semibold text-cyan-400">{entry.position ?? "—"}</p>
          <p className="text-sm text-slate-400 mt-2">position in lane {entry.lane_index}</p>
          {entry.position != null && (
            <p className="text-xs text-slate-500 mt-4">
              Estimated wait: ~{entry.position * ASSUMED_SECONDS_PER_PROMOTION}s
            </p>
          )}
        </div>
      ) : (
        <p className="text-slate-400">Loading your position…</p>
      )}
      <p className="text-xs text-slate-500">This page updates automatically — no need to refresh.</p>
    </div>
  );
}
