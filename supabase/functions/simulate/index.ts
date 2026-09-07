// supabase/functions/simulate/index.ts
// POST { action, event_id, count?, duration_seconds? }
// action: "load" | "load_rate" | "trigger_surge" | "trigger_email_failure" | "enable_lite_mode" | "recover_system"
//
// Gated behind DEMO_MODE=true (edge function secret) — returns 403 otherwise,
// so this can never run against a production deployment by accident.
//
// Maps 1:1 onto the requested demo flags:
//   users=100         -> {action:"load", count:100}            (instant burst)
//   users=1000        -> {action:"load", count:1000}            (instant burst)
//   rate=100/min      -> {action:"load_rate", count:100, duration_seconds:60}
//   rate=1000/min     -> {action:"load_rate", count:1000, duration_seconds:60}
//   surge=true        -> {action:"trigger_surge"}
//   email_failure=true -> {action:"trigger_email_failure"}
//   lite_mode=true    -> {action:"enable_lite_mode"}
//   recover=true      -> {action:"recover_system"}
// Kept as POST+JSON rather than query flags because SimulationPanel.tsx
// already calls it this way — same capability, one wire format instead of two.
//
// Requires a valid user JWT (any authenticated user) — not open to the
// public internet, but not organizer-gated either; tighten if this ever
// leaves hackathon scope.
//
// "load", "load_rate", and "trigger_surge" all drive real registrations
// through registerForEvent() against a pool of seeded demo attendees (see
// scripts/seed-demo.sh) — this is not a fake progress bar, it actually
// exercises CPR/ASP/the queue/Lite Mode detection.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { registerForEvent } from "../_shared/register.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const DEMO_MODE = Deno.env.get("DEMO_MODE") !== "false";
const BATCH_SIZE = 50;
const RATE_WAVE_INTERVAL_MS = 2000; // how often a new wave of arrivals fires during a "load_rate" ramp

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Same pattern as surge-router/register.ts: let a long-running simulation
// keep executing after the HTTP response has already gone out, instead of
// making the caller's button spin for 60 seconds. Without EdgeRuntime's
// waitUntil, the Deno isolate can be frozen/recycled the instant the
// response is sent, silently truncating the ramp partway through.
function background(promise: Promise<unknown>) {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  const guarded = promise.catch((err) => {
    console.error("[SimulateBackground] task failed:", err instanceof Error ? err.message : err);
  });
  if (runtime?.waitUntil) runtime.waitUntil(guarded);
}

async function getDemoUserPool(admin: ReturnType<typeof createClient>, count: number) {
  const { data: pool } = await admin
    .from("profiles")
    .select("id")
    .eq("role", "attendee")
    .order("id")
    .limit(count);

  const users: { id: string }[] = [...(pool ?? [])];
  while (users.length < count) {
    users.push({ id: crypto.randomUUID() });
  }
  return users;
}

async function runLoad(admin: ReturnType<typeof createClient>, eventId: string, count: number) {
  const users = await getDemoUserPool(admin, count);
  const tally = { attempted: users.length, confirmed: 0, queued: 0, already_registered: 0, error: 0 };

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((u) => registerForEvent(admin, eventId, u.id, crypto.randomUUID())),
    );
    for (const r of results) {
      if (r.status !== "fulfilled") { tally.error++; continue; }
      const s = r.value.body.status as string;
      if (s === "confirmed") tally.confirmed++;
      else if (s === "queued") tally.queued++;
      else if (s === "already_registered") tally.already_registered++;
      else tally.error++;
    }
  }
  return tally;
}

// Spreads `count` registrations evenly across `durationSeconds`, instead of
// firing them all in one instant burst — this is what makes "100 users/min"
// actually mean users arriving over a minute, visible as a real, sustained
// climb in the dashboard's Requests/sec and Active Users tiles rather than
// a single spike-and-drop. Runs entirely in the background (see
// `background()` above); the HTTP response returns immediately.
async function runLoadRate(admin: ReturnType<typeof createClient>, eventId: string, count: number, durationSeconds: number) {
  const totalWaves = Math.max(1, Math.round((durationSeconds * 1000) / RATE_WAVE_INTERVAL_MS));
  const perWave = Math.max(1, Math.ceil(count / totalWaves));
  const users = await getDemoUserPool(admin, count);

  let sent = 0;
  const tally = { attempted: 0, confirmed: 0, queued: 0, already_registered: 0, error: 0 };
  for (let w = 0; w < totalWaves && sent < users.length; w++) {
    const wave = users.slice(sent, sent + perWave);
    sent += wave.length;
    const results = await Promise.allSettled(
      wave.map((u) => registerForEvent(admin, eventId, u.id, crypto.randomUUID())),
    );
    for (const r of results) {
      tally.attempted++;
      if (r.status !== "fulfilled") { tally.error++; continue; }
      const s = r.value.body.status as string;
      if (s === "confirmed") tally.confirmed++;
      else if (s === "queued") tally.queued++;
      else if (s === "already_registered") tally.already_registered++;
      else tally.error++;
    }
    if (sent < users.length) await new Promise((r) => setTimeout(r, RATE_WAVE_INTERVAL_MS));
  }
  console.log(
    `[SimulateLoadRate] event ${eventId}: ramped ${tally.attempted}/${count} over ~${durationSeconds}s ` +
    `(confirmed=${tally.confirmed} queued=${tally.queued} already_registered=${tally.already_registered} error=${tally.error})`,
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") return json({ status: "error", message: "POST only" }, 405);
  if (!DEMO_MODE) {
    return json({ status: "error", message: "simulate endpoint is disabled — set DEMO_MODE=true for this deployment to enable it" }, 403);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");

  if (jwt === SERVICE_ROLE_KEY) {
    // Internal service-role callers remain available for controlled automation.
  } else {
    const { data: userData, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !userData?.user) {
      return json({ status: "error", message: "unauthenticated" }, 401);
    }

    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profileError || (profile?.role !== "organizer" && profile?.role !== "admin")) {
      return json({ status: "error", message: "organizer access required" }, 403);
    }
  }

  const { action, event_id, count, duration_seconds } = await req.json().catch(() => ({}));
  if (!action) return json({ status: "error", message: "action required" }, 400);

  switch (action) {
    case "load": {
      if (!event_id || !count) return json({ status: "error", message: "event_id and count required" }, 400);
      const tally = await runLoad(admin, event_id, count);
      return json({ status: "ok", action, ...tally });
    }
    case "load_rate": {
      if (!event_id || !count) return json({ status: "error", message: "event_id and count required" }, 400);
      const durationSeconds = Math.max(5, Math.min(300, Number(duration_seconds) || 60));
      background(runLoadRate(admin, event_id, count, durationSeconds));
      return json({
        status: "ok",
        action,
        started: true,
        target_count: count,
        duration_seconds: durationSeconds,
        message: `Ramping ${count} registrations over ${durationSeconds}s — watch Requests/sec and Active Users climb on the dashboard.`,
      });
    }
    case "trigger_surge": {
      if (!event_id) return json({ status: "error", message: "event_id required" }, 400);
      const tally = await runLoad(admin, event_id, 300);
      return json({ status: "ok", action, ...tally });
    }
    case "trigger_email_failure": {
      await admin.from("demo_flags").update({ force_email_failure: true, updated_at: new Date().toISOString() }).eq("id", 1);
      return json({ status: "ok", action });
    }
    case "enable_lite_mode": {
      if (!event_id) return json({ status: "error", message: "event_id required" }, 400);
      await admin.rpc("set_system_status", { p_event_id: event_id, p_lite_mode: true, p_reason: "manual demo override", p_surge_score: 1 });
      return json({ status: "ok", action });
    }
    case "recover_system": {
      await admin.from("demo_flags").update({ force_email_failure: false, updated_at: new Date().toISOString() }).eq("id", 1);
      await admin.rpc("set_circuit_guardian_state", { p_state: "closed", p_reason: "manual recovery" });
      if (event_id) {
        await admin.rpc("set_system_status", { p_event_id: event_id, p_lite_mode: false, p_reason: "manual recovery", p_surge_score: 0 });
      }
      return json({ status: "ok", action });
    }
    default:
      return json({ status: "error", message: `unknown action: ${action}` }, 400);
  }
});