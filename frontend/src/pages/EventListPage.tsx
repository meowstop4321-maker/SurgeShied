import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Calendar, Users, ArrowRight } from "lucide-react";
import { listEvents } from "../lib/api";

export const EventListPage: React.FC = () => {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listEvents()
      .then(setEvents)
      .catch((err) => console.warn("Error fetching events:", err))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold text-white">Live Events</h1>
          <p className="text-sm text-slate-400 mt-1">
            Browse upcoming events with instant seat reservations and zero overbooking.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-20 text-slate-400">Loading events…</div>
      ) : events.length === 0 ? (
        <div className="text-center py-20 rounded-2xl border border-white/10 bg-slate-900/40 p-8">
          <Calendar className="w-12 h-12 text-slate-600 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-white">No active events yet</h3>
          <p className="text-xs text-slate-400 mt-1">Sign in as Organizer to create your first event.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {events.map((event) => (
            <div
              key={event.id}
              className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-md p-6 flex flex-col justify-between hover:border-white/20 transition-all group"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${
                      event.registration_open
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                        : "bg-slate-500/10 border-slate-500/30 text-slate-400"
                    }`}
                  >
                    {event.registration_open ? "Registration Open" : "Closed"}
                  </span>
                </div>

                <h3 className="text-lg font-bold text-white group-hover:text-teal-300 transition-colors">
                  {event.title}
                </h3>
                <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
                  {event.description || "High-concurrency event registration."}
                </p>
              </div>

              <div className="pt-6 space-y-4 border-t border-white/5 mt-6">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span className="flex items-center gap-1.5">
                    <Users size={14} className="text-slate-500" />
                    <span>Capacity</span>
                  </span>
                  <span className="font-semibold text-slate-200">{event.capacity} seats</span>
                </div>

                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span className="flex items-center gap-1.5">
                    <Calendar size={14} className="text-slate-500" />
                    <span>Date</span>
                  </span>
                  <span className="text-slate-200">
                    {new Date(event.starts_at || Date.now()).toLocaleDateString()}
                  </span>
                </div>

                <Link
                  to={`/events/${event.id}`}
                  className="w-full py-2.5 rounded-xl bg-white/5 hover:bg-teal-500 hover:text-slate-950 text-slate-200 border border-white/10 hover:border-teal-500 font-semibold text-xs flex items-center justify-center gap-2 transition-all"
                >
                  <span>View Details & Register</span>
                  <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
