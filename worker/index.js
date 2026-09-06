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
  path.resolve(process.cwd(), "..", "worker", ".env"),
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
const PUBSUB_PUSH_TOKEN = process.env.PUBSUB_PUSH_TOKEN;
const SEAT_PASSPORT_SECRET = process.env.SEAT_PASSPORT_SECRET;
const PASSPORT_TTL_SECONDS = 2 * 60; // 2-minute booking window
const GHOST_SEAT_SWEEP_MS = 20_000; // 20s sweep interval
const HEARTBEAT_MS = 20_000;
const WORKER_ID = process.env.K_REVISION || `local-${crypto.randomUUID()}`;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// --- Initialize Unified WorkerManager --------------------------------------
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
  pollIntervalMs: 2000,
  scaleCheckIntervalMs: 3000,
  scaleDownCooldownMs: 10000,
});

// --- Finishing queue promotions -------------------------------------------
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
    if (!SEAT_PASSPORT_SECRET) continue;
    const exp = Math.floor(Date.now() / 1000) + PASSPORT_TTL_SECONDS;
    const token = issueSeatPassport(
      { eventId: r.event_id, userId: r.user_id, registrationId: r.id, laneIndex: r.lane_index, exp, nonce: crypto.randomUUID() },
      SEAT_PASSPORT_SECRET,
    );
    await admin
      .from("registrations")
      .update({ seat_passport_token: token, seat_passport_expires_at: new Date(exp * 1000).toISOString() })
      .eq("id", r.id);

    // Enqueue confirmation notification with Priority 8 into the unified job_queue
    await workerManager.enqueue("confirmation_email", {
      event_id: r.event_id,
      user_id: r.user_id,
      lane_index: r.lane_index,
      registration_id: r.id,
    }, 8);
  }
  if (rows?.length) {
    console.log(`[Worker] Finished ${rows.length} promoted registration(s): Passport issued + Priority 8 notification enqueued`);
  }
}

// --- Ghost Seat Recovery Sweep --------------------------------------------
async function ghostSeatSweep() {
  const { data, error } = await admin.rpc("release_expired_seats");
  if (error) {
    console.error("[GhostSeatRecovery] release_expired_seats failed:", error.message);
  } else if (data > 0) {
    console.log(`[GhostSeatRecovery] Released ${data} expired seat(s), trigger queue promotions`);
  }
  await finishPromotions();
}

// --- Worker Heartbeat ------------------------------------------------------
async function heartbeat() {
  await admin.rpc("upsert_worker_heartbeat", { p_worker_id: WORKER_ID, p_status: "healthy" });
}

// --- Express HTTP Telemetry & Ops API --------------------------------------
const app = express();
app.use(express.json());

// Auth middleware for administrative/job routes
const requireWorkerAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const workerSecretHeader = req.headers["x-worker-secret"];
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const providedToken = bearerToken || workerSecretHeader || req.query.token;

  const validTokens = [
    process.env.WORKER_SECRET,
    SERVICE_ROLE_KEY,
    PUBSUB_PUSH_TOKEN,
  ].filter(Boolean);

  // If credentials are configured, enforce matching token
  if (validTokens.length > 0) {
    if (!providedToken || !validTokens.includes(providedToken)) {
      return res.status(401).json({ error: "Unauthorized: valid worker token or service role key required" });
    }
  }
  next();
};

app.get("/health", (_req, res) => res.status(200).json({ status: "ok", worker_id: WORKER_ID }));

// Telemetry & scaling stats for Operations Dashboard
app.get("/manager/stats", (_req, res) => {
  res.status(200).json(workerManager.getStats());
});

app.get("/jobs/status", requireWorkerAuth, async (_req, res) => {
  try {
    const depth = await workerManager.fetchQueueDepth();
    res.status(200).json({ status: "ok", depth, stats: workerManager.getStats() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/jobs/enqueue", requireWorkerAuth, async (req, res) => {
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

app.post("/manager/scale", requireWorkerAuth, (req, res) => {
  const { minWorkers, maxWorkers } = req.body;
  if (typeof minWorkers === "number") workerManager.minWorkers = Math.max(1, minWorkers);
  if (typeof maxWorkers === "number") workerManager.maxWorkers = Math.max(workerManager.minWorkers, maxWorkers);
  workerManager.evaluateAndScale().catch(console.error);
  res.status(200).json({ status: "ok", config: { minWorkers: workerManager.minWorkers, maxWorkers: workerManager.maxWorkers } });
});

// Pub/Sub Push Subscription Endpoint (bridges push hints directly into unified WorkerManager)
app.post("/pubsub/notification-jobs", async (req, res) => {
  if (PUBSUB_PUSH_TOKEN && req.query.token !== PUBSUB_PUSH_TOKEN) {
    return res.status(401).send("bad token");
  }
  try {
    const dataB64 = req.body?.message?.data;
    if (!dataB64) return res.status(204).send();
    const payload = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));
    
    // Enqueue with High Priority (8) into WorkerManager
    await workerManager.enqueue("confirmation_email", payload, 8);
    res.status(204).send();
  } catch (err) {
    console.error("[PubSubPush] Error processing push message:", err.message);
    res.status(500).send("processing error");
  }
});

app.listen(PORT, () => {
  console.log(`🛡️ SurgeShield Worker ${WORKER_ID} listening on ${PORT}`);
  
  // Start WorkerManager autoscaling pool (single source of truth for job execution)
  workerManager.start();

  // Periodic recovery & heartbeat timers
  setInterval(() => ghostSeatSweep().catch(console.error), GHOST_SEAT_SWEEP_MS);
  setInterval(() => heartbeat().catch(console.error), HEARTBEAT_MS);
  heartbeat().catch(console.error);
});
