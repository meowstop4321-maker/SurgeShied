import express from "express";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WorkerManager } from "./workerManager.js";

// Auto-load .env from worker/.env or parent .env if not already loaded into process.env
const envPaths = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "worker", ".env"),
  path.resolve(process.cwd(), "..", ".env"),
  path.resolve(process.cwd(), "..", "worker", ".env")
];
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    try {
      const content = fs.readFileSync(p, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
          if (key && !process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    } catch {}
  }
}

const PORT = process.env.PORT || 8080;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "SurgeShield <onboarding@resend.dev>";
const PUBSUB_PUSH_TOKEN = process.env.PUBSUB_PUSH_TOKEN; // shared-secret query param, see scripts/setup-pubsub.sh
const SEAT_PASSPORT_SECRET = process.env.SEAT_PASSPORT_SECRET; // same secret the edge functions use
const PASSPORT_TTL_SECONDS = 2 * 60; // 2-minute booking allotment
const GHOST_SEAT_SWEEP_MS = 20_000; // 20s sweep window for fast ghost seat reclamation
const WORKER_ID = process.env.K_REVISION || `local-${crypto.randomUUID()}`;

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;

const SELF_HEAL_SWEEP_MS = 20_000; // catches jobs whose Pub/Sub push never arrived
const HEARTBEAT_MS = 20_000;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// --- Circuit Guardian (per-instance; synced to the DB so the dashboard
// and other instances can see it — see PROJECT_STATE.md for the
// multi-instance caveat) -----------------------------------------------
let consecutiveFailures = 0;
let circuitOpenedAt = null;

async function isCircuitOpen() {
  if (!circuitOpenedAt) return false;
  if (Date.now() - circuitOpenedAt > CIRCUIT_COOLDOWN_MS) {
    circuitOpenedAt = null; // move to half-open: let the next attempt through
    return false;
  }
  return true;
}

async function recordFailure(reason) {
  consecutiveFailures++;
  if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && !circuitOpenedAt) {
    circuitOpenedAt = Date.now();
    await admin.rpc("set_circuit_guardian_state", { p_state: "open", p_reason: reason });
    console.warn(`circuit guardian: OPEN (${reason})`);
  }
}

async function recordSuccess() {
  if (consecutiveFailures > 0 || circuitOpenedAt) {
    await admin.rpc("set_circuit_guardian_state", { p_state: "closed", p_reason: "send succeeded" });
    console.log("circuit guardian: CLOSED (recovered)");
  }
  consecutiveFailures = 0;
  circuitOpenedAt = null;
}

// --- Resend --------------------------------------------------------------
async function sendConfirmationEmail(toEmail, payload) {
  const { data: flags } = await admin.from("demo_flags").select("force_email_failure").eq("id", 1).single();
  if (flags?.force_email_failure) {
    throw new Error("demo: force_email_failure is enabled");
  }
  if (!RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY not configured");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [toEmail],
      subject: "You're in — SurgeShield registration confirmed",
      html: `<p>Your seat is confirmed (lane ${payload.lane_index}). See you there!</p>`,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`resend ${res.status}: ${text}`);
  }
}

// --- Job processing --------------------------------------------------------
async function processJob(jobId) {
  const { data: job } = await admin.from("notification_jobs").select("*").eq("id", jobId).single();
  if (!job || job.status === "sent" || job.status === "dead_letter") return;

  if (await isCircuitOpen()) {
    console.log(`circuit open, leaving job ${jobId} queued`);
    return;
  }

  const { data: registration } = await admin.from("registrations").select("user_id").eq("id", job.registration_id).single();
  if (!registration) {
    await admin.from("notification_jobs").update({ status: "dead_letter", last_error: "registration not found" }).eq("id", jobId);
    return;
  }

  try {
    const { data: userResp } = await admin.auth.admin.getUserById(registration.user_id);
    const email = userResp?.user?.email;
    if (!email) throw new Error("no email on file for user");

    await sendConfirmationEmail(email, job.payload ?? {});
    await admin.from("notification_jobs").update({ status: "sent", last_error: null }).eq("id", jobId);
    await recordSuccess();
  } catch (err) {
    await recordFailure(err.message);
    const attempts = job.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await admin.from("notification_jobs").update({ status: "dead_letter", attempts, last_error: String(err.message) }).eq("id", jobId);
      console.error(`job ${jobId} -> dead letter after ${attempts} attempts: ${err.message}`);
    } else {
      const backoffMs = BASE_BACKOFF_MS * 2 ** (attempts - 1);
      await admin
        .from("notification_jobs")
        .update({ status: "queued", attempts, last_error: String(err.message), next_retry_at: new Date(Date.now() + backoffMs).toISOString() })
        .eq("id", jobId);
      console.warn(`job ${jobId} attempt ${attempts} failed, retrying in ${backoffMs}ms: ${err.message}`);
    }
  }
}

// --- Finishing queue promotions -------------------------------------------
// promote_from_queue() (in Postgres) creates the registration row directly —
// it never goes through Surge Router, so nothing has issued a Seat Passport
// or queued a notification for it. The worker closes that gap here, using
// the exact same token format as supabase/functions/_shared/seatPassport.ts
// so it's verifiable the same way regardless of which path issued it.
function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function issueSeatPassport(payload, secret) {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", secret).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

async function finishPromotions() {
  const { data: rows } = await admin
    .from("registrations")
    .select("id, event_id, user_id, lane_index")
    .eq("status", "pending")
    .is("seat_passport_token", null)
    .limit(50);

  for (const r of rows ?? []) {
    const exp = Math.floor(Date.now() / 1000) + PASSPORT_TTL_SECONDS;
    const token = issueSeatPassport(
      { eventId: r.event_id, userId: r.user_id, registrationId: r.id, laneIndex: r.lane_index, exp, nonce: crypto.randomUUID() },
      SEAT_PASSPORT_SECRET,
    );
    await admin
      .from("registrations")
      .update({ seat_passport_token: token, seat_passport_expires_at: new Date(exp * 1000).toISOString() })
      .eq("id", r.id);
    await admin.from("notification_jobs").insert({
      registration_id: r.id,
      job_type: "confirmation_email",
      status: "queued",
      payload: { event_id: r.event_id, user_id: r.user_id, lane_index: r.lane_index },
    });
    // left queued — the self-heal sweep picks it up within SELF_HEAL_SWEEP_MS.
  }
  if (rows?.length) console.log(`finished ${rows.length} promoted registration(s): passport + notification queued`);
}

// --- Background loops --------------------------------------------------
async function selfHealSweep() {
  const { data: due } = await admin
    .from("notification_jobs")
    .select("id")
    .eq("status", "queued")
    .or(`next_retry_at.is.null,next_retry_at.lte.${new Date().toISOString()}`)
    .limit(50);
  for (const row of due ?? []) await processJob(row.id);
}

async function ghostSeatSweep() {
  const { data, error } = await admin.rpc("release_expired_seats");
  if (error) console.error("release_expired_seats failed", error.message);
  else if (data > 0) console.log(`ghost seat recovery: released ${data} seat(s), queue promotion attempted`);
  await finishPromotions();
}

async function heartbeat() {
  await admin.rpc("upsert_worker_heartbeat", { p_worker_id: WORKER_ID, p_status: "healthy" });
}

// Initialize WorkerManager for dynamic autoscaling queue processing
const workerManager = new WorkerManager({
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SERVICE_ROLE_KEY,
  resendApiKey: RESEND_API_KEY,
  resendFrom: RESEND_FROM,
  passportSecret: SEAT_PASSPORT_SECRET,
  passportTtlSeconds: PASSPORT_TTL_SECONDS,
  minWorkers: 1,
  maxWorkers: 10,
  jobsPerWorker: 3,
});

// --- HTTP server ---------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.status(200).json({ status: "ok", worker_id: WORKER_ID }));

// Worker Manager Stats and Scaling Metrics
app.get("/manager/stats", (_req, res) => {
  res.status(200).json(workerManager.getStats());
});

app.get("/jobs/status", async (_req, res) => {
  try {
    const depth = await workerManager.fetchQueueDepth();
    res.status(200).json({ status: "ok", depth, stats: workerManager.getStats() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/jobs/enqueue", async (req, res) => {
  try {
    const { job_type, payload, priority, scheduled_at } = req.body;
    if (!job_type) {
      return res.status(400).json({ error: "job_type is required" });
    }
    const jobId = await workerManager.enqueue(
      job_type,
      payload || {},
      priority ?? 5,
      scheduled_at || new Date().toISOString()
    );
    res.status(201).json({ status: "enqueued", job_id: jobId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/manager/scale", (req, res) => {
  const { minWorkers, maxWorkers } = req.body;
  if (typeof minWorkers === "number") workerManager.minWorkers = Math.max(1, minWorkers);
  if (typeof maxWorkers === "number") workerManager.maxWorkers = Math.max(workerManager.minWorkers, maxWorkers);
  workerManager.evaluateAndScale().catch(console.error);
  res.status(200).json({ status: "ok", config: { minWorkers: workerManager.minWorkers, maxWorkers: workerManager.maxWorkers } });
});

app.post("/pubsub/notification-jobs", async (req, res) => {
  if (PUBSUB_PUSH_TOKEN && req.query.token !== PUBSUB_PUSH_TOKEN) {
    return res.status(401).send("bad token");
  }
  try {
    const dataB64 = req.body?.message?.data;
    if (!dataB64) return res.status(204).send(); // ack malformed/empty pushes so Pub/Sub stops retrying them
    const { job_id } = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));
    await processJob(job_id);
    res.status(204).send();
  } catch (err) {
    console.error("push handler error", err);
    // 500 tells Pub/Sub to retry; the self-heal sweep is the fallback if it never does.
    res.status(500).send("processing error");
  }
});

app.listen(PORT, () => {
  console.log(`surgeshield worker ${WORKER_ID} listening on ${PORT}`);
  
  // Start WorkerManager autoscaling pool
  workerManager.start();

  setInterval(() => ghostSeatSweep().catch(console.error), GHOST_SEAT_SWEEP_MS);
  setInterval(() => selfHealSweep().catch(console.error), SELF_HEAL_SWEEP_MS);
  setInterval(() => heartbeat().catch(console.error), HEARTBEAT_MS);
  heartbeat().catch(console.error);
});
