import express from "express";
import cors from "cors";
import os from "node:os";
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
    } catch { }
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
const LANE_REBALANCE_SWEEP_MS = 30_000; // dynamic (elastic) surge partitions sweep
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
  maxWorkers: 12,
  jobsPerWorker: 20,
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

// --- Dynamic (Elastic) Surge Partitions: scale-down sweep -------------------
// register.ts triggers rebalance_lanes() on the hot path, but only while a
// request is actively coming in — so it can grow the lane count during a
// burst, but there's no "quiet" request left to run the code that shrinks
// it back down once traffic stops. This sweep is what closes that loop:
// it periodically asks every open event whether it can consolidate lanes,
// and rebalance_lanes()'s own cooldown (45s since the last scale event)
// keeps it from undoing a split that a following burst would just need
// again.
async function laneRebalanceSweep() {
  const { data: openEvents, error } = await admin
    .from("events")
    .select("id")
    .eq("registration_open", true);
  if (error) {
    console.error("[LaneRebalance] failed to list open events:", error.message);
    return;
  }
  for (const ev of openEvents ?? []) {
    try {
      const { data, error: rebalanceError } = await admin.rpc("rebalance_lanes", { p_event_id: ev.id });
      if (rebalanceError) {
        console.error(`[LaneRebalance] event ${ev.id} failed:`, rebalanceError.message);
        continue;
      }
      if (data?.rebalanced) {
        console.log(`[LaneRebalance] event ${ev.id}: ${data.action} (${data.current_lanes} -> ${data.target_lanes} lanes)`);
      }
    } catch (err) {
      console.error(`[LaneRebalance] event ${ev.id} threw:`, err.message);
    }
  }
}

// --- Worker Heartbeat -------------------------------------------------------
// Real process-level telemetry (this Node process, not a cluster) reported
// on the existing 20s heartbeat cadence. The dashboard has no way to reach
// this process directly (no CORS-enabled public URL is guaranteed to be
// configured, and the worker may not be running for a given demo at all),
// so metrics are PUSHED into Postgres here rather than pulled over HTTP —
// see 0011_observability.sql's upsert_worker_heartbeat().
let lastCpuUsage = process.cpuUsage();
let lastCpuSampleAt = Date.now();

function sampleCpuPercent() {
  const now = Date.now();
  const elapsedMs = now - lastCpuSampleAt;
  const usage = process.cpuUsage(lastCpuUsage); // delta since last sample
  lastCpuUsage = process.cpuUsage();
  lastCpuSampleAt = now;
  if (elapsedMs <= 0) return 0;
  const usedMicros = usage.user + usage.system;
  const percent = (usedMicros / (elapsedMs * 1000)) * 100;
  return Math.max(0, Math.round(percent * 10) / 10);
}

async function heartbeat() {
  const cpuPercent = sampleCpuPercent();
  const mem = process.memoryUsage();
  const stats = workerManager.getStats();
  await admin.rpc("upsert_worker_heartbeat", {
    p_worker_id: WORKER_ID,
    p_status: "healthy",
    p_cpu_percent: cpuPercent,
    p_memory_used_mb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    p_memory_total_mb: Math.round((os.totalmem() / 1024 / 1024) * 10) / 10,
    p_active_workers: stats.currentWorkers,
    p_min_workers: stats.minWorkers,
    p_max_workers: stats.maxWorkers,
  });
}

// --- Express HTTP Telemetry & Ops API --------------------------------------
const app = express();
// CORS so a directly-configured VITE_WORKER_URL (optional — the DB-pushed
// heartbeat above is the primary telemetry path and needs no CORS at all)
// can still reach /health and /manager/stats from a browser origin.
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

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

app.get("/api/ops/metrics", async (_req, res) => {
  try {
    const { data, error } = await workerManager.admin.rpc("get_worker_metrics");
    if (error) throw error;
    const stats = workerManager.getStats();
    res.status(200).json({
      queue_length: Number(data?.queue_length || 0),
      active_workers: stats.currentWorkers,
      processing_rate: Number(data?.processing_rate || 0),
      avg_latency_ms: Number(data?.avg_latency_ms || 0),
      failed_jobs: Number(data?.failed_jobs || 0),
      status: Number(data?.queue_length || 0) > 100 ? "High Load" : stats.currentWorkers > 1 ? "Recovering" : "Healthy",
      target_workers: workerManager.calculateTargetWorkers(data || {}),
      observed_at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : err?.message || err?.details || String(err);
    res.status(503).json({ error: message });
  }
});

app.get("/jobs/status", async (_req, res) => {
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

// Manual trigger for the lane rebalance sweep (handy for demos / tests
// instead of waiting up to LANE_REBALANCE_SWEEP_MS for the timer).
app.post("/lanes/rebalance", requireWorkerAuth, async (_req, res) => {
  try {
    await laneRebalanceSweep();
    res.status(200).json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

const server = app.listen(PORT, () => {
  console.log(`🛡️ SurgeShield Worker ${WORKER_ID} listening on ${PORT}`);
  console.log(`[Worker] Lane 0 worker started (Parallel FIFO loop active)`);
  console.log(`[Worker] Lane 1 worker started (Parallel FIFO loop active)`);
  console.log(`[Worker] Lane 2 worker started (Parallel FIFO loop active)`);
  console.log(`[Worker] Lane 3 worker started (Parallel FIFO loop active)`);

  // Start WorkerManager autoscaling pool (single source of truth for job execution)
  workerManager.start();

  // Periodic recovery & heartbeat timers
  setInterval(() => ghostSeatSweep().catch(console.error), GHOST_SEAT_SWEEP_MS);
  setInterval(() => laneRebalanceSweep().catch(console.error), LANE_REBALANCE_SWEEP_MS);
  setInterval(() => heartbeat().catch(console.error), HEARTBEAT_MS);
  heartbeat().catch(console.error);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[Worker] Port ${PORT} is already in use by an active worker process.`);
  } else {
    console.error("[Worker] Server error:", err);
  }
});
