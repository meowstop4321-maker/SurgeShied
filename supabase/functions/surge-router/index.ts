// supabase/functions/surge-router/index.ts
// Thin edge orchestrator: validates JWT, idempotency key, then delegates to _shared/register.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { registerForEvent } from "../_shared/register.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TURNSTILE_SECRET_KEY = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";

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

async function verifyTurnstile(token: string, remoteIp: string | null) {
  if (!TURNSTILE_SECRET_KEY) {
    return { ok: false, status: 503, message: "CAPTCHA verification is not configured" };
  }

  const form = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token });
  if (remoteIp) form.set("remoteip", remoteIp);

  let verification: { success?: boolean; [key: string]: unknown };
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!response.ok) {
      return { ok: false, status: 503, message: "CAPTCHA verification service is unavailable" };
    }
    verification = await response.json();
  } catch (_error) {
    return { ok: false, status: 503, message: "CAPTCHA verification network failure" };
  }

  if (verification.success) return { ok: true, status: 200, message: "" };

  const errorCodes = Array.isArray(verification["error-codes"])
    ? verification["error-codes"] as string[]
    : [];
  if (errorCodes.includes("timeout-or-duplicate")) {
    return { ok: false, status: 403, message: "CAPTCHA expired. Please complete the CAPTCHA again." };
  }
  return { ok: false, status: 403, message: "CAPTCHA verification failed. Please try again." };
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

    const { event_id, turnstile_token } = await req.json().catch(() => ({}));
    if (!event_id) {
      return json({ status: "error", message: "event_id is required" }, 400);
    }
    if (typeof turnstile_token !== "string" || !turnstile_token) {
      return json({ status: "error", code: "CAPTCHA_MISSING", message: "CAPTCHA verification is required" }, 403);
    }

    const captcha = await verifyTurnstile(turnstile_token, req.headers.get("CF-Connecting-IP"));
    if (!captcha.ok) {
      return json({ status: "error", code: "CAPTCHA_VERIFICATION_FAILED", message: captcha.message }, captcha.status);
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
