import React, { useEffect, useState } from "react";
import { Terminal, Shield, Layers } from "lucide-react";
import { listEvents } from "../lib/api";
import { SimulationPanel } from "../components/SimulationPanel";
import { LiteModeBanner } from "../components/LiteModeBanner";

export const SimulationPage: React.FC = () => {
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>("");

  useEffect(() => {
    listEvents().then((evs) => {
      setEvents(evs);
      if (evs.length > 0 && !selectedEventId) {
        setSelectedEventId(evs[0].id);
      }
    });
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-amber-400 mb-1">
            <Terminal size={18} />
            <span className="text-xs font-mono uppercase font-bold tracking-wider">SurgeShield Resilience Testbed</span>
          </div>
          <h1 className="text-3xl font-extrabold text-white">Simulation Engine</h1>
          <p className="text-sm text-slate-400 mt-1">
            Run deterministic chaos experiments and high-throughput surge tests on partition lanes.
          </p>
        </div>

        {events.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 font-medium">Target:</span>
            <select
              value={selectedEventId}
              onChange={(e) => setSelectedEventId(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-teal-500 font-medium"
            >
              {events.map((e) => (
                <option key={e.id} value={e.id} className="bg-slate-900 text-white">
                  {e.title}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {selectedEventId && <LiteModeBanner eventId={selectedEventId} />}

      <SimulationPanel eventId={selectedEventId} />
    </div>
  );
};
