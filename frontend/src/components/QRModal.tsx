import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { X, CheckCircle, ShieldCheck, Download, Calendar } from "lucide-react";
import { downloadICSFile, createGoogleCalendarUrl } from "../lib/calendar";

interface QRModalProps {
  isOpen: boolean;
  onClose: () => void;
  eventTitle: string;
  startsAt: string;
  ticketToken: string;
  laneIndex?: number;
  userEmail: string;
}

export const QRModal: React.FC<QRModalProps> = ({
  isOpen,
  onClose,
  eventTitle,
  startsAt,
  ticketToken,
  userEmail,
}) => {
  const [qrUrl, setQrUrl] = useState<string>("");

  useEffect(() => {
    if (ticketToken) {
      QRCode.toDataURL(ticketToken, {
        width: 260,
        margin: 2,
        color: {
          dark: "#090d16",
          light: "#ffffff",
        },
      }).then(setQrUrl);
    }
  }, [ticketToken]);

  if (!isOpen) return null;

  const calEvent = {
    title: eventTitle,
    description: `Your SurgeShield ticket is confirmed. Token: ${ticketToken}`,
    startsAt: startsAt || new Date().toISOString(),
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl space-y-5">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 transition-colors"
        >
          <X size={18} />
        </button>

        <div className="text-center space-y-1">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-teal-500/10 text-teal-400 border border-teal-500/30 mb-1">
            <CheckCircle size={22} />
          </div>
          <h3 className="text-lg font-bold text-white">Registration Confirmed</h3>
          <p className="text-xs text-slate-400 font-medium">{eventTitle}</p>
        </div>

        <div className="flex flex-col items-center justify-center bg-white p-4 rounded-xl shadow-inner">
          {qrUrl ? (
            <img src={qrUrl} alt="Ticket QR Code" className="w-48 h-48 rounded-lg" />
          ) : (
            <div className="w-48 h-48 bg-slate-100 flex items-center justify-center text-xs text-slate-400">
              Generating QR…
            </div>
          )}
          <div className="mt-2 text-center">
            <span className="text-[11px] font-mono font-bold text-slate-900 bg-slate-200 px-3 py-1 rounded">
              SEAT PASSPORT · VERIFIED
            </span>
          </div>
        </div>

        <div className="text-center space-y-1 bg-white/5 p-3 rounded-xl border border-white/5">
          <div className="text-xs text-slate-300 font-medium flex items-center justify-center gap-1.5">
            <ShieldCheck size={14} className="text-teal-400" />
            <span>Cryptographically Verified Pass</span>
          </div>
          <p className="text-[10px] font-mono text-slate-500 truncate">{ticketToken}</p>
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1">
          <a
            href={createGoogleCalendarUrl(calEvent)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 transition-colors"
          >
            <Calendar size={14} className="text-teal-400" />
            <span>Google Calendar</span>
          </a>
          <button
            onClick={() => downloadICSFile(calEvent)}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 transition-colors"
          >
            <Download size={14} className="text-teal-400" />
            <span>Download .ICS</span>
          </button>
        </div>
      </div>
    </div>
  );
};
