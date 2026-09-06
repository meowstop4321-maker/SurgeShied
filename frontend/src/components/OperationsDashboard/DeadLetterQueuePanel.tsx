import React, { useEffect, useState } from "react";
import { Skull, RefreshCw, RotateCcw, CheckCircle2 } from "lucide-react";
import { getDeadLetterJobs, reprocessDeadLetterJob } from "../../lib/api";

interface DeadLetterJob {
  id: string;
  job_type: string;
  payload: Record<string, unknown>;
  priority: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const POLL_MS = 4000;

export function DeadLetterQueuePanel() {
  const [jobs, setJobs] = useState<DeadLetterJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [reprocessing, setReprocessing] = useState<Record<string, boolean>>({});
  const [justReprocessed, setJustReprocessed] = useState<Record<string, boolean>>({});

  const fetchJobs = async () => {
    try {
      const data = await getDeadLetterJobs();
      setJobs(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  const handleReprocess = async (jobId: string) => {
    setReprocessing((r) => ({ ...r, [jobId]: true }));
    try {
      await reprocessDeadLetterJob(jobId);
      setJustReprocessed((r) => ({ ...r, [jobId]: true }));
      // Give the operator a moment to see the confirmation before the row
      // disappears from the DLQ list on the next poll.
      setTimeout(fetchJobs, 1200);
    } catch (err) {
      console.error("reprocess failed:", err);
    } finally {
      setReprocessing((r) => ({ ...r, [jobId]: false }));
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 p-5 space-y-4 backdrop-blur-md">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Skull className="w-5 h-5 text-rose-400" />
          <h3 className="text-sm font-semibold text-slate-200">Dead Letter Queue</h3>
          <span
            className={`text-[10px] uppercase font-mono px-2 py-0.5 rounded-full border ${
              jobs.length > 0
                ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
            }`}
          >
            {jobs.length} job{jobs.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          onClick={fetchJobs}
          disabled={loading}
          className="p-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-teal-400" : ""}`} />
        </button>
      </div>

      {jobs.length === 0 ? (
        <div className="text-xs text-slate-500 text-center py-8 flex flex-col items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-500/60" />
          <span>No jobs stuck in the Dead Letter Queue — every job either succeeded or is still retrying.</span>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-white/5 bg-black/20">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-white/5 text-[11px] uppercase tracking-wider text-slate-400 font-mono">
              <tr>
                <th className="py-2.5 px-3">Job</th>
                <th className="py-2.5 px-3">Failure Reason</th>
                <th className="py-2.5 px-3">Attempts</th>
                <th className="py-2.5 px-3">Failed At</th>
                <th className="py-2.5 px-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 font-mono">
              {jobs.map((job) => (
                <tr key={job.id} className="hover:bg-white/[0.02] transition-colors">
                  <td className="py-2.5 px-3">
                    <div className="text-slate-200 font-semibold">{job.job_type}</div>
                    <div className="text-[10px] text-slate-500">#{job.id.slice(0, 8)}</div>
                  </td>
                  <td className="py-2.5 px-3 text-rose-300/90 max-w-xs">
                    <span className="line-clamp-2">{job.last_error ?? "unknown error"}</span>
                  </td>
                  <td className="py-2.5 px-3 text-slate-400">
                    {job.attempts} / {job.max_attempts}
                  </td>
                  <td className="py-2.5 px-3 text-slate-400 text-[11px]">
                    {new Date(job.updated_at).toLocaleTimeString()}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    {justReprocessed[job.id] ? (
                      <span className="inline-flex items-center gap-1 text-emerald-400 text-[11px]">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Requeued
                      </span>
                    ) : (
                      <button
                        onClick={() => handleReprocess(job.id)}
                        disabled={reprocessing[job.id]}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/30 text-teal-300 text-[11px] font-medium transition-colors disabled:opacity-50"
                      >
                        <RotateCcw className={`w-3 h-3 ${reprocessing[job.id] ? "animate-spin" : ""}`} />
                        Reprocess
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
