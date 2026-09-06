import React, { useState } from "react";
import { Play, Users, Zap, MailX, AlertTriangle, RefreshCw, CheckCircle2 } from "lucide-react";
import { simulate } from "../lib/api";

interface SimulationPanelProps {
  eventId?: string;
}

export const SimulationPanel: React.FC<SimulationPanelProps> = ({ eventId }) => {
  const [loading, setLoading] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runSim = async (action: string, count?: number) => {
    setLoading(action);
    setError(null);
    setLastResult(null);
    try {
      const res = await simulate(action, eventId, count);
      if (res.status === "error") {
        setError(res.message);
      } else {
        setLastResult(res);
      }
    } catch (err: any) {
      setError(err.message || "Simulation request failed");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-950/10 backdrop-blur-md p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-amber-300">Resilience Simulation Controls</h3>
            <span className="px-2 py-0.5 text-[10px] font-mono uppercase font-bold rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
              Demo Panel
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Inject real-time concurrent loads, traffic spikes, and failure scenarios into the SurgeShield engine.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <button
          onClick={() => runSim("load", 100)}
          disabled={!eventId || loading !== null}
          className="p-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-left transition-all group disabled:opacity-50"
        >
          <div className="flex items-center justify-between text-teal-400 group-hover:text-teal-300">
            <Users size={18} />
            <Play size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="text-sm font-semibold text-white mt-2">100 Users</div>
          <div className="text-[11px] text-slate-400">Parallel lane load</div>
        </button>

        <button
          onClick={() => runSim("load", 1000)}
          disabled={!eventId || loading !== null}
          className="p-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-left transition-all group disabled:opacity-50"
        >
          <div className="flex items-center justify-between text-indigo-400 group-hover:text-indigo-300">
            <Users size={18} />
            <Play size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="text-sm font-semibold text-white mt-2">1,000 Users</div>
          <div className="text-[11px] text-slate-400">High concurrency flood</div>
        </button>

        <button
          onClick={() => runSim("trigger_surge")}
          disabled={!eventId || loading !== null}
          className="p-3 rounded-lg border border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 text-left transition-all group disabled:opacity-50"
        >
          <div className="flex items-center justify-between text-amber-400">
            <Zap size={18} />
            <Play size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="text-sm font-semibold text-white mt-2">Simulate Surge</div>
          <div className="text-[11px] text-slate-400">Crowd Pressure Routing</div>
        </button>

        <button
          onClick={() => runSim("trigger_email_failure")}
          disabled={loading !== null}
          className="p-3 rounded-lg border border-rose-500/20 bg-rose-500/5 hover:bg-rose-500/10 text-left transition-all group disabled:opacity-50"
        >
          <div className="flex items-center justify-between text-rose-400">
            <MailX size={18} />
            <Play size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="text-sm font-semibold text-white mt-2">Email Failure</div>
          <div className="text-[11px] text-slate-400">Trip Circuit Guardian</div>
        </button>

        <button
          onClick={() => runSim("enable_lite_mode")}
          disabled={!eventId || loading !== null}
          className="p-3 rounded-lg border border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 text-left transition-all group disabled:opacity-50"
        >
          <div className="flex items-center justify-between text-amber-400">
            <AlertTriangle size={18} />
            <Play size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="text-sm font-semibold text-white mt-2">Force Lite Mode</div>
          <div className="text-[11px] text-slate-400">Graceful degradation</div>
        </button>

        <button
          onClick={() => runSim("recover_system")}
          disabled={!eventId || loading !== null}
          className="p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 hover:bg-emerald-500/10 text-left transition-all group disabled:opacity-50"
        >
          <div className="flex items-center justify-between text-emerald-400">
            <RefreshCw size={18} className={loading === "recover_system" ? "animate-spin" : ""} />
            <Play size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="text-sm font-semibold text-white mt-2">Recover System</div>
          <div className="text-[11px] text-slate-400">Reset circuit & lite mode</div>
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-amber-300/80 font-mono bg-amber-500/10 p-3 rounded-lg border border-amber-500/20">
          <RefreshCw size={14} className="animate-spin" />
          <span>Executing simulation scenario '{loading}' against partition lanes…</span>
        </div>
      )}

      {error && (
        <div className="text-xs text-rose-300 font-mono bg-rose-500/10 p-3 rounded-lg border border-rose-500/20">
          Simulation Error: {error}
        </div>
      )}

      {lastResult && (
        <div className="text-xs text-emerald-300 bg-emerald-500/10 p-3.5 rounded-lg border border-emerald-500/20 space-y-1">
          <div className="flex items-center gap-1.5 font-semibold">
            <CheckCircle2 size={14} />
            <span>Simulation Executed Successfully ({lastResult.action})</span>
          </div>
          {lastResult.attempted !== undefined && (
            <p className="text-slate-300 font-mono text-[11px]">
              Attempted: {lastResult.attempted} | Confirmed: {lastResult.confirmed} | Queued: {lastResult.queued} | Already Registered: {lastResult.already_registered} | Errors: {lastResult.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
