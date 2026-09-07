// supabase/functions/surge-router/index.ts
// Thin edge orchestrator: validates JWT, rate-limits, checks idempotency key,
// delegates to _shared/register.ts, and records latency/outcome for every
// request — real data behind the Operations Dashboard's response-time,
// P95/P99, and failed-registration metrics (0011_observability.sql).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { registerForEvent } from "../_shared/register.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Anti-bot / retry-storm guard. migrations/0007_antibot.sql defines
// check_rate_limit() (sliding window + cooldown) but nothing ever called
// it — a client that double-clicks, or a buggy/malicious script that
// retries in a hot loop, could hit the registration path with unbounded
// concurrency, which is exactly the kind of amplification that turns a
// real surge into a database-connection-exhaustion outage. Keyed per user
// (post-JWT-verification) rather than per IP, since IP is unreliable
// behind shared NATs/proxies and every caller here is already authenticated.
const RATE_LIMIT_MAX_REQUESTS = 8;
const RATE_LIMIT_WINDOW_SECONDS = 30;
const RATE_LIMIT_COOLDOWN_SECONDS = 20;
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

  let verification: { success?: boolean;[key: string]: unknown };
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

function background(promise: Promise<unknown>) {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  const guarded = promise.catch((err) => {
    console.error("[background] task failed:", err instanceof Error ? err.message : err);
  });
  if (runtime?.waitUntil) runtime.waitUntil(guarded);
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
    eventId = event_id ?? null;
    if (!event_id) {
      responseStatus = 400;
      return json({ status: "error", message: "event_id is required" }, 400);
    }
    if (typeof turnstile_token !== "string" || !turnstile_token) {
      return json({ status: "error", code: "CAPTCHA_MISSING", message: "CAPTCHA verification is required" }, 403);
    }

    const captcha = await verifyTurnstile(turnstile_token, req.headers.get("CF-Connecting-IP"));
    if (!captcha.ok) {
      return json({ status: "error", code: "CAPTCHA_VERIFICATION_FAILED", message: captcha.message }, captcha.status);
    }

    const { data: rateLimit, error: rateLimitError } = await admin.rpc("check_rate_limit", {
      p_key: `user:${userId}`,
      p_max_requests: RATE_LIMIT_MAX_REQUESTS,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      p_cooldown_seconds: RATE_LIMIT_COOLDOWN_SECONDS,
    });
    // Fail OPEN on a rate-limiter error (e.g. migration not applied yet on
    // an older environment) — registration should degrade gracefully, not
    // go down because the anti-bot table is unreachable.
    if (!rateLimitError && rateLimit && rateLimit.allowed === false) {
      outcome = "rate_limited";
      responseStatus = 429;
      background(admin.rpc("append_audit_log", {
        p_actor_id: userId, p_action: "rate_limited", p_entity: "event", p_entity_id: eventId,
        p_metadata: { retry_after: rateLimit.retry_after ?? RATE_LIMIT_COOLDOWN_SECONDS },
      }));
      return json(
        {
          status: "rate_limited",
          message: "Too many registration attempts — please wait before retrying.",
          retry_after: rateLimit.retry_after ?? RATE_LIMIT_COOLDOWN_SECONDS,
        },
        429,
      );
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
