// supabase/functions/simulate/index.ts
// POST { action, event_id, count? }
// action: "load" | "trigger_surge" | "trigger_email_failure" | "enable_lite_mode" | "recover_system"
//
// Gated behind DEMO_MODE=true (edge function secret) — returns 403 otherwise,
// so this can never run against a production deployment by accident.
//
// Maps 1:1 onto the requested demo flags:
//   users=100         -> {action:"load", count:100}
//   users=1000        -> {action:"load", count:1000}
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
// "load" and "trigger_surge" both drive real registrations through
// registerForEvent() against a pool of seeded demo attendees (see
// scripts/seed-demo.sh) — this is not a fake progress bar, it actually
// exercises CPR/ASP/the queue/Lite Mode detection.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { registerForEvent } from "../_shared/register.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEMO_MODE = Deno.env.get("DEMO_MODE") === "true";
const BATCH_SIZE = 50;

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

async function runLoad(admin: ReturnType<typeof createClient>, eventId: string, count: number) {
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
  const { data: userData, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !userData?.user) return json({ status: "error", message: "unauthenticated" }, 401);

  const { action, event_id, count } = await req.json().catch(() => ({}));
  if (!action) return json({ status: "error", message: "action required" }, 400);

  switch (action) {
    case "load": {
      if (!event_id || !count) return json({ status: "error", message: "event_id and count required" }, 400);
      const tally = await runLoad(admin, event_id, count);
      return json({ status: "ok", action, ...tally });
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
