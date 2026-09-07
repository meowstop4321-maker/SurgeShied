// supabase/functions/surge-router/index.ts
// Thin edge orchestrator: validates JWT, rate-limits, checks idempotency key,
// delegates to _shared/register.ts, and records latency/outcome for every
// request — real data behind the Operations Dashboard's response-time,
// P95/P99, and failed-registration metrics (0011_observability.sql).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { registerForEvent } from "../_shared/register.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ status: "error", message: "POST method required" }, 405);
  }

  const startedAt = performance.now();
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  // Populated as the handler learns more; whatever we have when the
  // response goes out is what gets logged, so a metric row is written for
  // EVERY request — including ones that fail before reaching registerForEvent.
  let userId: string | null = null;
  let eventId: string | null = null;
  let outcome = "error";
  let responseStatus = 500;

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");

    const { data: userData, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !userData?.user) {
      outcome = "error";
      responseStatus = 401;
      return json({ status: "error", message: "Unauthorized: valid session token required" }, 401);
    }
    userId = userData.user.id;

    const { event_id } = await req.json().catch(() => ({}));
    if (!event_id) {
      responseStatus = 400;
      return json({ status: "error", message: "event_id is required" }, 400);
    }

    const idempotencyKey =
      req.headers.get("Idempotency-Key") ||
      req.headers.get("idempotency-key") ||
      crypto.randomUUID();

    const result = await registerForEvent(admin, event_id, userId, idempotencyKey);
    outcome = (result.body.status as string) ?? "error";
    responseStatus = result.status;
    return json(result.body, result.status);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    outcome = "error";
    responseStatus = 500;
    background(admin.rpc("append_audit_log", {
      p_actor_id: userId, p_action: "registration_failed", p_entity: "event", p_entity_id: eventId,
      p_metadata: { message },
    }));
    return json({ status: "error", message }, 500);
  } finally {
    const latencyMs = Math.round(performance.now() - startedAt);
    background(admin.rpc("log_request_metric", {
      p_event_id: eventId,
      p_user_id: userId,
      p_outcome: outcome,
      p_status_code: responseStatus,
      p_latency_ms: latencyMs,
    }));
  }
});
