import React, { useEffect, useState } from "react";
import { Plus, Calendar, Users, ShieldCheck, ToggleLeft, ToggleRight, Loader2, AlertCircle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/auth";

export const OrganizerDashboard: React.FC = () => {
  const { user } = useAuth();
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [capacity, setCapacity] = useState(500);
  const [startsAt, setStartsAt] = useState("");

  const loadOrganizerEvents = async () => {
    try {
      const { data, error } = await supabase.from("events").select("*").order("created_at", { ascending: false });
      if (error) {
        console.warn("Could not load events:", error.message);
      }
      setEvents(data ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrganizerEvents();
  }, []);

  const handleCreateEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setCreating(true);
    setFormError(null);

    try {
      const laneCount = 4; // Automatically partitioned behind the scenes
      const dateVal = startsAt ? new Date(startsAt).toISOString() : new Date(Date.now() + 86400000 * 7).toISOString();
      
      // 1. Try atomic create_event_with_partitions RPC
      const { data: rpcEvent, error: rpcErr } = await supabase.rpc("create_event_with_partitions", {
        p_title: title,
        p_description: description,
        p_capacity: capacity,
        p_lane_count: laneCount,
        p_starts_at: dateVal,
      });

      if (!rpcErr && rpcEvent) {
        setTitle("");
        setDescription("");
        setCapacity(500);
        setStartsAt("");
        await loadOrganizerEvents();
        return;
      }

      // 2. Direct insert fallback
      const { data: newEvent, error: evErr } = await supabase
        .from("events")
        .insert({
          organizer_id: user.id,
          title,
          description,
          capacity,
          lane_count: laneCount,
          starts_at: dateVal,
          registration_open: true,
        })
        .select()
        .single();

      if (evErr) throw evErr;

      if (newEvent) {
        const laneCap = Math.floor(capacity / laneCount);
        const partitionsToInsert = [];
        for (let i = 0; i < laneCount; i++) {
          partitionsToInsert.push({
            event_id: newEvent.id,
            lane_index: i,
            capacity: laneCap,
            seats_taken: 0,
          });
        }
        await supabase.from("seat_partitions").insert(partitionsToInsert);

        try {
          await supabase.rpc("append_audit_log", {
            p_actor_id: user.id,
            p_action: "event_created",
            p_entity: "event",
            p_entity_id: newEvent.id,
            p_metadata: { title, capacity, lane_count: laneCount },
          });
        } catch {}

        setTitle("");
        setDescription("");
        setCapacity(500);
        setStartsAt("");
        await loadOrganizerEvents();
      }
    } catch (err: any) {
      setFormError(err.message || "Failed to create event. Make sure migration 0009 has been executed in Supabase SQL Editor.");
    } finally {
      setCreating(false);
    }
  };

  const toggleEventStatus = async (eventId: string, currentStatus: boolean) => {
    try {
      await supabase.from("events").update({ registration_open: !currentStatus }).eq("id", eventId);
      await loadOrganizerEvents();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-10">
      <div>
        <h1 className="text-3xl font-extrabold text-white">Organizer Portal</h1>
        <p className="text-sm text-slate-400 mt-1">
          Create and manage high-volume events with automated zero-overbooking resilience.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Create Event Form */}
        <div className="rounded-2xl border border-white/10 bg-slate-900/50 backdrop-blur-md p-6 space-y-5 h-fit">
          <div className="flex items-center gap-2">
            <Plus className="w-5 h-5 text-teal-400" />
            <h2 className="text-base font-bold text-white">Create New Event</h2>
          </div>

          <form onSubmit={handleCreateEvent} className="space-y-4">
            {formError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
                <AlertCircle size={15} className="shrink-0" />
                <span>{formError}</span>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Event Title</label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Tech Summit Keynote 2026"
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-teal-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Description</label>
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="High-profile keynote session..."
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-teal-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Total Capacity (Seats)</label>
              <input
                type="number"
                required
                min={10}
                value={capacity}
                onChange={(e) => setCapacity(parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-teal-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Event Date & Time</label>
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-teal-500"
              />
            </div>

            <button
              type="submit"
              disabled={creating}
              className="w-full py-2.5 rounded-lg bg-teal-500 hover:bg-teal-400 text-slate-950 font-bold text-sm shadow flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
            >
              {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              <span>Create Event</span>
            </button>
          </form>
        </div>

        {/* Existing Events List */}
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-base font-bold text-white">Your Managed Events ({events.length})</h2>

          {loading ? (
            <div className="text-slate-400 text-xs py-8">Loading events…</div>
          ) : events.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-slate-900/30 p-8 text-center text-slate-400 text-xs">
              No events found. Create your first high-concurrency event on the left.
            </div>
          ) : (
            <div className="space-y-3">
              {events.map((ev) => (
                <div
                  key={ev.id}
                  className="rounded-xl border border-white/10 bg-slate-900/40 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 backdrop-blur-md"
                >
                  <div className="space-y-1">
                    <h3 className="text-sm font-bold text-white">{ev.title}</h3>
                    <p className="text-xs text-slate-400">
                      Capacity: {ev.capacity} seats · Started {new Date(ev.starts_at || Date.now()).toLocaleDateString()}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => toggleEventStatus(ev.id, ev.registration_open)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                        ev.registration_open
                          ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20"
                          : "bg-slate-500/10 text-slate-400 border border-slate-500/30 hover:bg-slate-500/20"
                      }`}
                    >
                      {ev.registration_open ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                      <span>{ev.registration_open ? "Registration Live" : "Closed"}</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
