import React from "react";
import { Link } from "react-router-dom";
import {
  Shield,
  Layers,
  Zap,
  Cpu,
  Lock,
  ArrowRight,
  CheckCircle2,
  Activity,
  GitBranch,
  ShieldCheck,
  Server,
} from "lucide-react";

export const LandingPage: React.FC = () => {
  return (
    <div className="space-y-20 pb-20">
      {/* Hero Section */}
      <section className="relative pt-16 sm:pt-24 text-center px-4 sm:px-6 lg:px-8 max-w-5xl mx-auto space-y-8">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 text-teal-300 text-xs font-semibold tracking-wide">
          <Shield className="w-3.5 h-3.5" />
          <span>Zero Overbooking · Sub-Millisecond Concurrency Partitioning</span>
        </div>

        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-white leading-tight">
          Never Crash on Registration Surges Again.
        </h1>

        <p className="text-base sm:text-lg text-slate-300 max-w-3xl mx-auto leading-relaxed">
          SurgeShield replaces brittle monolith databases with{" "}
          <span className="text-teal-400 font-semibold">Adaptive Surge Partitions</span>,{" "}
          <span className="text-teal-400 font-semibold">Crowd Pressure Routing</span>, and{" "}
          <span className="text-teal-400 font-semibold">Tamper-Evident Audit Chains</span>. Built for high-stakes ticket drops.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
          <Link
            to="/events"
            className="px-6 py-3 rounded-xl bg-teal-500 hover:bg-teal-400 text-slate-950 font-bold text-sm shadow-lg shadow-teal-500/20 flex items-center gap-2 transition-all"
          >
            <span>Explore Live Events</span>
            <ArrowRight size={16} />
          </Link>
          <Link
            to="/ops"
            className="px-6 py-3 rounded-xl bg-white/5 hover:bg-white/10 text-slate-100 border border-white/10 font-semibold text-sm flex items-center gap-2 transition-all"
          >
            <Activity size={16} className="text-teal-400" />
            <span>Operations Dashboard</span>
          </Link>
          <Link
            to="/simulate"
            className="px-6 py-3 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold text-sm flex items-center gap-2 transition-all"
          >
            <Zap size={16} className="text-amber-400" />
            <span>Stress Test Simulator</span>
          </Link>
        </div>
      </section>

      {/* Signature Innovations Grid */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 space-y-10">
        <div className="text-center space-y-2">
          <h2 className="text-2xl sm:text-3xl font-bold text-white">SurgeShield Resilience Engine</h2>
          <p className="text-sm text-slate-400">9 Core architectural innovations designed for extreme load events</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-6 space-y-3 backdrop-blur-md">
            <div className="w-10 h-10 rounded-xl bg-teal-500/10 border border-teal-500/30 flex items-center justify-center text-teal-400">
              <Layers size={20} />
            </div>
            <h3 className="text-base font-bold text-white">1. Adaptive Surge Partitions</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Splits capacity across parallel transactional lanes (`hash(user_id) % N`). Eliminates row-lock contention across PostgreSQL.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-6 space-y-3 backdrop-blur-md">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <GitBranch size={20} />
            </div>
            <h3 className="text-base font-bold text-white">2. Crowd Pressure Routing</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Dynamically calculates lane queue length and headroom to route incoming attendees to the healthiest available lane.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-6 space-y-3 backdrop-blur-md">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Lock size={20} />
            </div>
            <h3 className="text-base font-bold text-white">3. Cryptographic Seat Passports</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              HMAC-SHA256 signed temporary reservation tokens with 10-minute TTLs that guarantee checkout exclusivity without blocking database threads.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-6 space-y-3 backdrop-blur-md">
            <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <Cpu size={20} />
            </div>
            <h3 className="text-base font-bold text-white">4. Ghost Seat Recovery</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Autonomous background workers sweep abandoned reservations every 45s and promote top-of-queue waiting users automatically.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-6 space-y-3 backdrop-blur-md">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <ShieldCheck size={20} />
            </div>
            <h3 className="text-base font-bold text-white">5. Circuit Guardian & Lite Mode</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Detects downstream email failure or API backpressure, triggers graceful UI degradation, and routes notifications to DLQ buffers.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-6 space-y-3 backdrop-blur-md">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400">
              <Server size={20} />
            </div>
            <h3 className="text-base font-bold text-white">6. Tamper-Evident Audit Chain</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Lightweight SHA-256 hash chaining of every seat allocation. Publicly verifiable proof that nobody altered the ticket inventory ledger.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};
