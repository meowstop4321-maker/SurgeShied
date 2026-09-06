import React from "react";
import { Link, useLocation } from "react-router-dom";
import { Shield, Activity, Calendar, User, LogOut, Terminal } from "lucide-react";
import { useAuth } from "../lib/auth";

export const Navbar: React.FC = () => {
  const { session, profile, signOut } = useAuth();
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;

  return (
    <nav className="border-b border-white/10 bg-[#090d16]/80 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center space-x-3">
            <Link to="/" className="flex items-center space-x-2.5 group">
              <div className="w-9 h-9 rounded-lg bg-teal-500/10 border border-teal-500/30 flex items-center justify-center group-hover:border-teal-500/60 transition-colors">
                <Shield className="w-5 h-5 text-teal-400" />
              </div>
              <span className="text-lg font-bold tracking-tight bg-gradient-to-r from-white via-slate-100 to-teal-200 bg-clip-text text-transparent">
                SurgeShield
              </span>
            </Link>
            <span className="hidden sm:inline-block px-2 py-0.5 text-[11px] font-mono tracking-wider font-semibold uppercase rounded bg-teal-500/10 text-teal-300 border border-teal-500/20">
              Resilience Engine
            </span>
          </div>

          <div className="hidden md:flex items-center space-x-1">
            <Link
              to="/events"
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                isActive("/events") ? "text-teal-300 bg-white/5" : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.02]"
              }`}
            >
              Events
            </Link>
            <Link
              to="/ops"
              className={`px-3 py-1.5 rounded-lg text-sm font-medium flex items-center space-x-1.5 transition-colors ${
                isActive("/ops") ? "text-teal-300 bg-white/5" : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.02]"
              }`}
            >
              <Activity className="w-4 h-4 text-teal-400" />
              <span>Operations</span>
            </Link>
            <Link
              to="/simulate"
              className={`px-3 py-1.5 rounded-lg text-sm font-medium flex items-center space-x-1.5 transition-colors ${
                isActive("/simulate") ? "text-amber-300 bg-white/5" : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.02]"
              }`}
            >
              <Terminal className="w-4 h-4 text-amber-400" />
              <span>Simulate</span>
            </Link>
            {profile?.role === "organizer" || profile?.role === "admin" ? (
              <Link
                to="/organizer"
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive("/organizer") ? "text-teal-300 bg-white/5" : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.02]"
                }`}
              >
                Organizer
              </Link>
            ) : null}
          </div>

          <div className="flex items-center space-x-3">
            {session ? (
              <div className="flex items-center space-x-3">
                <span className="hidden sm:flex items-center space-x-1.5 text-xs text-slate-400 font-mono">
                  <User className="w-3.5 h-3.5 text-slate-500" />
                  <span>{session.user.email}</span>
                </span>
                <button
                  onClick={signOut}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 flex items-center space-x-1.5 transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Sign Out</span>
                </button>
              </div>
            ) : (
              <Link
                to="/auth"
                className="px-4 py-1.5 rounded-lg text-sm font-medium bg-teal-500 text-slate-950 hover:bg-teal-400 transition-colors font-semibold shadow-sm"
              >
                Sign In
              </Link>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
};
