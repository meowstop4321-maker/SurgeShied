import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, Mail, Lock, User, ArrowRight, AlertCircle, Sparkles } from "lucide-react";
import { supabase } from "../lib/supabaseClient";

export const AuthPage: React.FC = () => {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<"attendee" | "organizer">("attendee");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (isSignUp) {
        const { data, error: signUpErr } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName, role },
          },
        });
        if (signUpErr) throw signUpErr;
        if (data.user) {
          navigate("/events");
        }
      } else {
        const { data, error: signInErr } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInErr) throw signInErr;
        if (data.user) {
          navigate("/events");
        }
      }
    } catch (err: any) {
      setError(err.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  // One-click demo sign-in helper
  const handleQuickDemo = async (demoRole: "organizer" | "attendee") => {
    setLoading(true);
    setError(null);
    const demoEmail = demoRole === "organizer" ? "demo.organizer@surgeshield.dev" : "demo.attendee@surgeshield.dev";
    const demoPass = "SurgeShield2026!Demo";

    try {
      const { data, error: signInErr } = await supabase.auth.signInWithPassword({
        email: demoEmail,
        password: demoPass,
      });

      if (signInErr) {
        // If demo user doesn't exist yet, auto sign-up
        const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({
          email: demoEmail,
          password: demoPass,
          options: {
            data: { full_name: demoRole === "organizer" ? "Demo Organizer" : "Demo Attendee", role: demoRole },
          },
        });
        if (signUpErr) throw signUpErr;
        if (signUpData.user) {
          navigate(demoRole === "organizer" ? "/organizer" : "/events");
          return;
        }
      }

      if (data?.user) {
        navigate(demoRole === "organizer" ? "/organizer" : "/events");
      }
    } catch (err: any) {
      setError(err.message || "Demo sign-in failed. You can create an account using the form below.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto px-4 py-16">
      <div className="rounded-2xl border border-white/10 bg-slate-900/60 backdrop-blur-xl p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-teal-500/10 border border-teal-500/30 text-teal-400">
            <Shield size={24} />
          </div>
          <h2 className="text-2xl font-bold text-white">
            {isSignUp ? "Create SurgeShield Account" : "Sign In to SurgeShield"}
          </h2>
          <p className="text-xs text-slate-400">
            {isSignUp ? "Join as an attendee or organizer" : "Access your registrations and operations"}
          </p>
        </div>

        {/* 1-Click Quick Demo Sign-In Buttons */}
        <div className="bg-white/5 border border-white/10 rounded-xl p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1">
              <Sparkles size={12} className="text-teal-400" />
              <span>Instant Demo Logins (Hackathon Mode)</span>
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => handleQuickDemo("attendee")}
              className="py-2 px-3 rounded-lg text-xs font-semibold bg-teal-500/10 hover:bg-teal-500/20 text-teal-300 border border-teal-500/30 transition-all text-center disabled:opacity-50"
            >
              Demo Attendee
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => handleQuickDemo("organizer")}
              className="py-2 px-3 rounded-lg text-xs font-semibold bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 transition-all text-center disabled:opacity-50"
            >
              Demo Organizer
            </button>
          </div>
        </div>

        <div className="relative flex items-center justify-center">
          <div className="border-t border-white/10 w-full" />
          <span className="bg-slate-900 px-3 text-[11px] uppercase tracking-wider text-slate-500 font-mono">or standard login</span>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle size={14} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleAuth} className="space-y-4">
          {isSignUp && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Full Name</label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Jane Doe"
                  className="w-full pl-9 pr-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-teal-500"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Email Address</label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full pl-9 pr-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-teal-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Password</label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-9 pr-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-teal-500"
              />
            </div>
          </div>

          {isSignUp && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Role</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setRole("attendee")}
                  className={`py-2 text-xs font-semibold rounded-lg border transition-all ${
                    role === "attendee"
                      ? "border-teal-500 bg-teal-500/20 text-teal-300"
                      : "border-white/10 bg-white/5 text-slate-400 hover:text-white"
                  }`}
                >
                  Attendee
                </button>
                <button
                  type="button"
                  onClick={() => setRole("organizer")}
                  className={`py-2 text-xs font-semibold rounded-lg border transition-all ${
                    role === "organizer"
                      ? "border-teal-500 bg-teal-500/20 text-teal-300"
                      : "border-white/10 bg-white/5 text-slate-400 hover:text-white"
                  }`}
                >
                  Organizer
                </button>
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-teal-500 hover:bg-teal-400 text-slate-950 font-bold text-sm shadow-md flex items-center justify-center gap-2 transition-colors disabled:opacity-50 mt-2"
          >
            <span>{loading ? "Processing…" : isSignUp ? "Create Account" : "Sign In"}</span>
            <ArrowRight size={16} />
          </button>
        </form>

        <div className="text-center pt-2 border-t border-white/10">
          <button
            onClick={() => setIsSignUp(!isSignUp)}
            className="text-xs text-slate-400 hover:text-teal-300 transition-colors"
          >
            {isSignUp ? "Already have an account? Sign In" : "Don't have an account? Sign Up"}
          </button>
        </div>
      </div>
    </div>
  );
};
