// supabase/functions/surge-router/index.ts
// Thin edge orchestrator: validates JWT, idempotency key, then delegates to _shared/register.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { registerForEvent } from "../_shared/register.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");

    const { data: userData, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !userData?.user) {
      return json({ status: "error", message: "Unauthorized: valid session token required" }, 401);
    }

    const { event_id } = await req.json().catch(() => ({}));
    if (!event_id) {
      return json({ status: "error", message: "event_id is required" }, 400);
    }

    const idempotencyKey =
      req.headers.get("Idempotency-Key") ||
      req.headers.get("idempotency-key") ||
      crypto.randomUUID();

    const result = await registerForEvent(admin, event_id, userData.user.id, idempotencyKey);
    return json(result.body, result.status);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ status: "error", message }, 500);
  }
});
