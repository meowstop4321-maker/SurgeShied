import React, { useEffect, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { subscribeSystemStatus } from "../lib/api";

interface LiteModeBannerProps {
  eventId: string;
}

export const LiteModeBanner: React.FC<LiteModeBannerProps> = ({ eventId }) => {
  const [liteMode, setLiteMode] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    if (!eventId) return;
    const unsub = subscribeSystemStatus(eventId, (isLite, msg) => {
      setLiteMode(isLite);
      setReason(msg);
    });
    return unsub;
  }, [eventId]);

  if (!liteMode) return null;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-950/40 p-4 backdrop-blur-md shadow-lg transition-all animate-pulse-fast">
      <div className="flex items-start sm:items-center space-x-3">
        <div className="w-9 h-9 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-5 h-5 text-amber-400" />
        </div>
        <div className="flex-1">
          <div className="flex items-center space-x-2">
            <h4 className="text-sm font-semibold text-amber-300">
              LITE MODE ACTIVE — Core Registrations Preserved
            </h4>
            <span className="px-2 py-0.5 text-[10px] font-mono uppercase font-bold rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
              Resilience Trigger
            </span>
          </div>
          <p className="text-xs text-amber-200/80 mt-0.5">
            Heavy animations & background charts temporarily paused. All seat allocations,
            anti-bot queues, and authentications remain 100% operational.
            {reason ? ` Reason: ${reason}` : ""}
          </p>
        </div>
      </div>
    </div>
  );
};
