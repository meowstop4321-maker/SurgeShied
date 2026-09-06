import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Calendar,
  Users,
  CheckCircle2,
  QrCode,
  Download,
  AlertCircle,
  Loader2,
  Clock,
  Sparkles,
  ShieldCheck,
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

  const totalTaken = partitions.reduce((sum, p) => sum + p.seats_taken, 0);
  const seatsAvailable = Math.max(0, event.capacity - totalTaken);
  const saturationPercent = event.capacity > 0 ? (totalTaken / event.capacity) * 100 : 0;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-8">
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
              <span
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${
                  seatsAvailable > 0
                    ? "bg-teal-500/10 border-teal-500/30 text-teal-300"
                    : "bg-amber-500/10 border-amber-500/30 text-amber-300"
                }`}
              >
                {seatsAvailable > 0 ? `${seatsAvailable} Seats Available` : "Waiting Queue Active (0 Available)"}
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
                  <span>You're Registered</span>
                </span>
                <button
                  onClick={() => setShowQR(true)}
                  className="px-4 py-2 rounded-xl bg-teal-500 text-slate-950 hover:bg-teal-400 font-bold text-xs flex items-center gap-1.5 shadow-md transition-all"
                >
                  <QrCode size={15} />
                  <span>View Ticket QR</span>
                </button>
              </div>
            ) : !event.registration_open ? (
              <button
                disabled
                className="px-6 py-3 rounded-xl bg-slate-800 text-slate-400 font-semibold text-sm border border-white/5 cursor-not-allowed"
              >
                Registration Closed
              </button>
            ) : seatsAvailable === 0 ? (
              <button
                onClick={handleRegister}
                disabled={registering}
                className="px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm shadow-lg shadow-amber-500/20 flex items-center gap-2 transition-all disabled:opacity-50"
              >
                {registering ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Joining Queue…</span>
                  </>
                ) : (
                  <>
                    <Users size={16} />
                    <span>Join Waiting Queue</span>
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={handleRegister}
                disabled={registering}
                className="px-6 py-3 rounded-xl bg-teal-500 hover:bg-teal-400 text-slate-950 font-bold text-sm shadow-lg shadow-teal-500/20 flex items-center gap-2 transition-all disabled:opacity-50"
              >
                {registering ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Allocating Seat…</span>
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
          {event.description || "Reserve your seat for this event."}
        </p>

        {/* Capacity Progress Bar */}
        <div className="space-y-2 pt-2">
          <div className="flex justify-between text-xs text-slate-400 font-medium">
            <span>Capacity Utilization</span>
            <span className="text-slate-200">{totalTaken} / {event.capacity} seats booked</span>
          </div>
          <div className="w-full bg-white/10 rounded-full h-2.5 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                saturationPercent > 85 ? "bg-amber-500" : "bg-teal-400"
              }`}
              style={{ width: `${saturationPercent}%` }}
            />
          </div>
        </div>

        {/* Existing Registration Info banner */}
        {existingReg && (
          <div className="p-5 rounded-2xl border border-teal-500/30 bg-teal-950/20 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-bold text-teal-300">Seat Confirmed</p>
                  <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-teal-500/20 text-teal-300 border border-teal-500/30">
                    2 min window (max 6 min)
                  </span>
                </div>
                <p className="text-xs text-slate-300">
                  Cryptographically Verified · SHA-256 Ledger Backed
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

            <div className="bg-black/30 p-2.5 rounded-xl border border-white/5 flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center gap-1.5">
                <ShieldCheck size={14} className="text-teal-400" />
                <span>Status:</span>
              </span>
              <span className="text-teal-300 font-mono font-semibold">
                Guaranteed Zero-Overbooking Allotment
              </span>
            </div>
          </div>
        )}
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
          userEmail={session?.user?.email || "attendee@example.com"}
        />
      )}
    </div>
  );
};
