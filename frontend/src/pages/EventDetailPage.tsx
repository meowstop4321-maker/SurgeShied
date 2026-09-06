import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Shield,
  Layers,
  Calendar,
  Users,
  CheckCircle2,
  QrCode,
  Download,
  AlertCircle,
  Loader2,
  Clock,
  Sparkles,
} from "lucide-react";
import { getEvent, getSeatPartitions, registerForEvent, subscribeSeatPartitions } from "../lib/api";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabaseClient";
import { LiteModeBanner } from "../components/LiteModeBanner";
import { QRModal } from "../components/QRModal";
import { createGoogleCalendarUrl, downloadICSFile } from "../lib/calendar";

export const EventDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { session } = useAuth();
  const navigate = useNavigate();

  const [event, setEvent] = useState<any | null>(null);
  const [partitions, setPartitions] = useState<any[]>([]);
  const [existingReg, setExistingReg] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showQR, setShowQR] = useState(false);

  const loadData = async () => {
    if (!id) return;
    try {
      const [ev, parts] = await Promise.all([getEvent(id), getSeatPartitions(id)]);
      setEvent(ev);
      setPartitions(parts);

      if (session?.user) {
        const { data: reg } = await supabase
          .from("registrations")
          .select("*")
          .eq("event_id", id)
          .eq("user_id", session.user.id)
          .eq("status", "confirmed")
          .maybeSingle();
        setExistingReg(reg);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    if (!id) return;
    const unsub = subscribeSeatPartitions(id, () => {
      getSeatPartitions(id).then(setPartitions);
    });
    return unsub;
  }, [id, session]);

  const handleRegister = async () => {
    if (!session) {
      navigate("/auth");
      return;
    }
    if (!id) return;

    setRegistering(true);
    setError(null);

    try {
      const res = await registerForEvent(id);
      if (res.status === "confirmed") {
        await loadData();
        setShowQR(true);
      } else if (res.status === "queued") {
        navigate(`/queue/${id}`);
      } else if (res.status === "already_registered") {
        await loadData();
        setShowQR(true);
      } else {
        setError(res.message || "Registration encountered an unexpected issue.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to contact Surge Router.");
    } finally {
      setRegistering(false);
    }
  };

  if (loading) {
    return <div className="text-center py-20 text-slate-400">Loading event details…</div>;
  }

  if (!event) {
    return <div className="text-center py-20 text-slate-400">Event not found.</div>;
  }

  const calEvent = {
    title: event.title,
    description: event.description || "SurgeShield Confirmed Registration",
    startsAt: event.starts_at || new Date().toISOString(),
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-8">
      <LiteModeBanner eventId={event.id} />

      {/* Event Header Card */}
      <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-md p-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${
                  event.registration_open
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                    : "bg-slate-500/10 border-slate-500/30 text-slate-400"
                }`}
              >
                {event.registration_open ? "Registration Open" : "Registration Closed"}
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono bg-teal-500/10 border border-teal-500/30 text-teal-300">
                {event.lane_count} Adaptive Lanes
              </span>
            </div>
            <h1 className="text-3xl font-extrabold text-white">{event.title}</h1>
            <p className="text-xs text-slate-400 mt-1 flex items-center gap-2">
              <Calendar size={13} />
              <span>{new Date(event.starts_at || Date.now()).toLocaleString()}</span>
            </p>
          </div>

          <div>
            {existingReg ? (
              <div className="flex flex-col sm:items-end gap-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-semibold">
                  <CheckCircle2 size={14} />
                  <span>You're Registered (Lane {existingReg.lane_index})</span>
                </span>
                <button
                  onClick={() => setShowQR(true)}
                  className="px-4 py-2 rounded-xl bg-teal-500 text-slate-950 hover:bg-teal-400 font-bold text-xs flex items-center gap-1.5 shadow-md transition-all"
                >
                  <QrCode size={15} />
                  <span>View Ticket QR</span>
                </button>
              </div>
            ) : (
              <button
                onClick={handleRegister}
                disabled={registering || !event.registration_open}
                className="px-6 py-3 rounded-xl bg-teal-500 hover:bg-teal-400 text-slate-950 font-bold text-sm shadow-lg shadow-teal-500/20 flex items-center gap-2 transition-all disabled:opacity-50"
              >
                {registering ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Allocating Seat Lane…</span>
                  </>
                ) : (
                  <>
                    <Sparkles size={16} />
                    <span>Instant Reserve Seat</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle size={15} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <p className="text-sm text-slate-300 leading-relaxed border-t border-white/5 pt-4">
          {event.description ||
            "Join this event powered by SurgeShield high-concurrency partition lanes."}
        </p>

        {/* Existing Registration Info banner */}
        {existingReg && (
          <div className="p-4 rounded-xl border border-teal-500/30 bg-teal-950/20 flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <p className="text-xs font-semibold text-teal-300">Seat Passport Active</p>
              <p className="text-[11px] font-mono text-slate-400">
                Assigned Lane #{existingReg.lane_index} · Hash-Chained in Ledger
              </p>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={createGoogleCalendarUrl(calEvent)}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 transition-colors flex items-center gap-1.5"
              >
                <Calendar size={13} />
                <span>Google Cal</span>
              </a>
              <button
                onClick={() => downloadICSFile(calEvent)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 transition-colors flex items-center gap-1.5"
              >
                <Download size={13} />
                <span>.ICS</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Live Lane Partition Visualizer */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-teal-400" />
            <h2 className="text-base font-bold text-white">Live Surge Partitions</h2>
          </div>
          <span className="text-xs text-slate-400 font-mono">
            {partitions.reduce((sum, p) => sum + p.seats_taken, 0)} / {event.capacity} total allocated
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          {partitions.map((lane) => {
            const saturation = lane.capacity > 0 ? (lane.seats_taken / lane.capacity) * 100 : 0;
            const isFull = lane.seats_taken >= lane.capacity;
            const isHigh = saturation > 85;

            return (
              <div
                key={lane.id || lane.lane_index}
                className="rounded-xl border border-white/10 bg-slate-900/40 p-4 space-y-3 backdrop-blur-md"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white font-mono">
                    Lane #{lane.lane_index}
                  </span>
                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-semibold ${
                      isFull
                        ? "bg-rose-500/20 text-rose-300"
                        : isHigh
                        ? "bg-amber-500/20 text-amber-300"
                        : "bg-teal-500/20 text-teal-300"
                    }`}
                  >
                    {isFull ? "FULL" : `${lane.capacity - lane.seats_taken} left`}
                  </span>
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                    <span>{lane.seats_taken} filled</span>
                    <span>{lane.capacity} cap</span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        isFull ? "bg-rose-500" : isHigh ? "bg-amber-500" : "bg-teal-400"
                      }`}
                      style={{ width: `${saturation}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* QR Confirmation Modal */}
      {existingReg && (
        <QRModal
          isOpen={showQR}
          onClose={() => setShowQR(false)}
          eventTitle={event.title}
          startsAt={event.starts_at}
          ticketToken={existingReg.seat_passport_token || `TICKET-${existingReg.id}`}
          laneIndex={existingReg.lane_index}
          userEmail={session?.user?.email || "attendee@surgeshield.dev"}
        />
      )}
    </div>
  );
};
