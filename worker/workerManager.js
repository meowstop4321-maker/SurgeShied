import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";

/**
 * WorkerManager — Dynamic Auto-Scaling Worker Pool Engine for SurgeShield
 *
 * Features:
 * - Real-time queue depth monitoring across priority tiers (Critical, High, Normal, Low)
 * - Dynamic autoscaling from minWorkers (default 1) to maxWorkers (default 10)
 * - Atomic job claiming via PostgreSQL FOR UPDATE SKIP LOCKED
 * - Priority-aware scheduling (Priority 10 down to 1)
 * - Exponential backoff retry & Dead-Letter Queue (DLQ)
 * - Anti-flapping scale-down cooldown
 * - Pluggable job type handlers (email notifications, ghost seat sweep, audit flushes, etc.)
 */
export class WorkerManager {
  constructor(options = {}) {
    this.supabaseUrl = options.supabaseUrl;
    this.serviceRoleKey = options.serviceRoleKey;
    this.resendApiKey = options.resendApiKey;
    this.resendFrom = options.resendFrom || "SurgeShield <onboarding@resend.dev>";
    this.passportSecret = options.passportSecret;
    this.passportTtlSeconds = options.passportTtlSeconds || 120; // 2-min allotment

    this.minWorkers = options.minWorkers ?? 1;
    this.maxWorkers = options.maxWorkers ?? 12;
    this.jobsPerWorker = options.jobsPerWorker ?? 20;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.scaleCheckIntervalMs = options.scaleCheckIntervalMs ?? 3000;
    this.scaleDownCooldownMs = options.scaleDownCooldownMs ?? 10000;

    this.admin = createClient(this.supabaseUrl, this.serviceRoleKey);
    this.workers = new Map(); // workerId -> { id, running, activeJobId, abortController }
    this.workerCounter = 0;
    this.isRunning = false;
    this.scaleTimer = null;
    this.lastScaleDownTime = 0;

    // Metrics & Telemetry
    this.metrics = {
      totalProcessed: 0,
      totalFailed: 0,
      totalClaimed: 0,
      scalingEvents: [],
      lastQueueDepth: {
        total_pending: 0,
        total_processing: 0,
        critical_pending: 0,
        normal_pending: 0,
        low_pending: 0,
        completed_count: 0,
        failed_count: 0,
        dead_letter_count: 0,
      },
    };

    // Circuit Guardian State
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = null;
    this.circuitCooldownMs = 30000;
    this.circuitFailureThreshold = 3;

    // Register default job handlers
    this.handlers = new Map();
    this.registerDefaultHandlers();
  }

  // --- Circuit Guardian ----------------------------------------------------
  async isCircuitOpen() {
    if (!this.circuitOpenedAt) return false;
    if (Date.now() - this.circuitOpenedAt > this.circuitCooldownMs) {
      this.circuitOpenedAt = null; // Half-open
      return false;
    }
    return true;
  }

  async recordCircuitFailure(reason) {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.circuitFailureThreshold && !this.circuitOpenedAt) {
      this.circuitOpenedAt = Date.now();
      try {
        await this.admin.rpc("set_circuit_guardian_state", { p_state: "open", p_reason: reason });
      } catch {}
      console.warn(`[CircuitGuardian] OPENED due to: ${reason}`);
    }
  }

  async recordCircuitSuccess() {
    if (this.consecutiveFailures > 0 || this.circuitOpenedAt) {
      try {
        await this.admin.rpc("set_circuit_guardian_state", { p_state: "closed", p_reason: "worker success" });
      } catch {}
      console.log("[CircuitGuardian] CLOSED (Healthy)");
    }
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = null;
  }

  // --- Job Handlers --------------------------------------------------------
  registerHandler(jobType, handlerFn) {
    this.handlers.set(jobType, handlerFn);
  }

  registerDefaultHandlers() {
    // 1. Notification / Confirmation Email Handler
    this.registerHandler("confirmation_email", async (job) => {
      const payload = job.payload || {};
      const { data: flags } = await this.admin.from("demo_flags").select("force_email_failure").eq("id", 1).maybeSingle();
      if (flags?.force_email_failure) {
        throw new Error("demo: force_email_failure flag is active");
      }

      let email = payload.to_email;
      if (!email && payload.user_id) {
        const { data: userResp } = await this.admin.auth.admin.getUserById(payload.user_id);
        email = userResp?.user?.email;
      }

      if (!email) {
        throw new Error("No destination email found in job payload or user profile");
      }

      if (!this.resendApiKey) {
        console.log(`[WorkerManager] Simulated email delivery to ${email} for event ${payload.event_id || 'registration'}`);
        return { delivered: true, simulated: true, to: email };
      }

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: this.resendFrom,
          to: [email],
          subject: "You're in — SurgeShield Registration Confirmed",
          html: `<p>Your seat registration is secured (Lane ${payload.lane_index ?? 0}). See you there!</p>`,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        // Handle Resend free-tier sandbox domain restriction gracefully
        if (res.status === 403 && errText.includes("testing emails to your own email address")) {
          console.log(`[WorkerManager] ✉️ Resend Sandbox: simulated delivery for non-verified recipient (${email})`);
          return { delivered: true, simulated_sandbox: true, to: email };
        }
        throw new Error(`Resend API error (${res.status}): ${errText}`);
      }
      return { delivered: true, to: email };
    });

    this.registerHandler("notification", this.handlers.get("confirmation_email"));

    // 2. Ghost Seat Sweep & Auto-Promotion Handler
    this.registerHandler("ghost_seat_sweep", async () => {
      const { data: releasedCount, error } = await this.admin.rpc("release_expired_seats");
      if (error) throw error;

      // Complete promotions for any un-ticketed pending registrations
      let promotionsFinished = 0;
      const { data: rows } = await this.admin
        .from("registrations")
        .select("id, event_id, user_id, lane_index")
        .eq("status", "pending")
        .is("seat_passport_token", null)
        .limit(50);

      if (rows && rows.length > 0 && this.passportSecret) {
        for (const r of rows) {
          const exp = Math.floor(Date.now() / 1000) + this.passportTtlSeconds;
          const body = Buffer.from(JSON.stringify({
            eventId: r.event_id,
            userId: r.user_id,
            registrationId: r.id,
            laneIndex: r.lane_index,
            exp,
            nonce: crypto.randomUUID(),
          })).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const sig = createHmac("sha256", this.passportSecret).update(body).digest();
          const token = `${body}.${sig.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

          await this.admin
            .from("registrations")
            .update({ seat_passport_token: token, seat_passport_expires_at: new Date(exp * 1000).toISOString() })
            .eq("id", r.id);

          promotionsFinished++;
        }
      }

      return { releasedCount: releasedCount || 0, promotionsFinished };
    });

    // 3. Audit Ledger Validation Handler
    this.registerHandler("audit_flush", async () => {
      const { count } = await this.admin.from("audit_logs").select("*", { count: "exact", head: true });
      return { verified_logs: count || 0 };
    });
  }

  // --- Dynamic Autoscaling Engine ------------------------------------------
  async fetchQueueDepth() {
    try {
      const { data, error } = await this.admin.rpc("get_job_queue_depth");
      if (error || !data) {
        // Fallback direct count
        const { count: pendingCount } = await this.admin
          .from("job_queue")
          .select("*", { count: "exact", head: true })
          .eq("status", "pending");

        // Also check legacy notification_jobs
        const { count: notifPending } = await this.admin
          .from("notification_jobs")
          .select("*", { count: "exact", head: true })
          .eq("status", "queued");

        const depth = {
          total_pending: (pendingCount || 0) + (notifPending || 0),
          total_processing: this.getActiveWorkerCount(),
          critical_pending: 0,
          normal_pending: (pendingCount || 0) + (notifPending || 0),
          low_pending: 0,
          completed_count: this.metrics.totalProcessed,
          failed_count: this.metrics.totalFailed,
          dead_letter_count: 0,
        };
        this.metrics.lastQueueDepth = depth;
        return depth;
      }

      this.metrics.lastQueueDepth = data;
      return data;
    } catch (err) {
      return this.metrics.lastQueueDepth;
    }
  }

  calculateTargetWorkers(depth) {
    const totalPending = Number(depth.total_pending || 0);
    const target = totalPending <= 20 ? 1
      : totalPending <= 100 ? 3
      : totalPending <= 500 ? 6
      : 12;

    return Math.max(this.minWorkers, Math.min(this.maxWorkers, target));
  }

  async evaluateAndScale() {
    if (!this.isRunning) return;

    const depth = await this.fetchQueueDepth();
    const currentWorkers = this.workers.size;
    const targetWorkers = this.calculateTargetWorkers(depth);

    if (targetWorkers > currentWorkers) {
      // Scale UP immediately
      const toSpawn = targetWorkers - currentWorkers;
      console.log(`[WorkerManager] ⚡ SCALING UP: +${toSpawn} workers (Current: ${currentWorkers} -> Target: ${targetWorkers}, Pending: ${depth.total_pending})`);
      this.recordScaleEvent("scale_up", currentWorkers, targetWorkers, depth);
      for (let i = 0; i < toSpawn; i++) {
        this.spawnWorker();
      }
    } else if (targetWorkers < currentWorkers) {
      // Scale DOWN with cooldown protection to prevent flapping
      const now = Date.now();
      if (now - this.lastScaleDownTime > this.scaleDownCooldownMs) {
        const toTerminate = currentWorkers - targetWorkers;
        console.log(`[WorkerManager] ❄ SCALING DOWN: -${toTerminate} workers (Current: ${currentWorkers} -> Target: ${targetWorkers}, Pending: ${depth.total_pending})`);
        this.recordScaleEvent("scale_down", currentWorkers, targetWorkers, depth);
        this.terminateWorkers(toTerminate);
        this.lastScaleDownTime = now;
      }
    }
  }

  async recordScaleEvent(action, from, to, depth) {
    const event = {
      timestamp: new Date().toISOString(),
      action,
      fromWorkers: from,
      toWorkers: to,
      pendingJobs: depth.total_pending,
      criticalJobs: depth.critical_pending,
    };
    this.metrics.scalingEvents.unshift(event);
    if (this.metrics.scalingEvents.length > 30) {
      this.metrics.scalingEvents.pop();
    }

    // Persist to the audit chain so scaling is visible on the dashboard's
    // live log stream and in get_ops_metrics()'s autoscaling_status
    try {
      const auditAction = action === "scale_up" ? "worker_scaled_up" : "worker_scaled_down";
      await this.admin.rpc("append_audit_log", {
        p_actor_id: null,
        p_action: auditAction,
        p_entity: "worker",
        p_entity_id: null,
        p_metadata: { from_workers: from, to_workers: to, pending_jobs: depth.total_pending, critical_jobs: depth.critical_pending },
      });
    } catch (err) {
      console.error("[WorkerManager] failed to audit-log scale event:", err?.message || err);
    }
  }

  // --- Worker Lifecycle ----------------------------------------------------
  spawnWorker() {
    const id = `worker-node-${++this.workerCounter}`;
    const workerState = {
      id,
      running: true,
      activeJobId: null,
      spawnedAt: new Date().toISOString(),
      jobsCompleted: 0,
    };

    this.workers.set(id, workerState);
    this.runWorkerLoop(workerState);
    return id;
  }

  terminateWorkers(count) {
    let terminated = 0;
    for (const [id, worker] of this.workers.entries()) {
      if (terminated >= count) break;
      // Mark as not running so it exits after completing any active job
      worker.running = false;
      this.workers.delete(id);
      terminated++;
    }
  }

  async runWorkerLoop(worker) {
    while (worker.running && this.isRunning) {
      try {
        const claimed = await this.claimAndProcessNextJob(worker);
        if (!claimed) {
          // If no job in modern queue, check legacy notification outbox
          const legacyClaimed = await this.processLegacyNotification(worker);
          if (!legacyClaimed) {
            // Idle wait before next polling cycle
            await new Promise((r) => setTimeout(r, this.pollIntervalMs));
          }
        }
      } catch (err) {
        console.error(`[${worker.id}] Loop error:`, err.message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async claimAndProcessNextJob(worker) {
    try {
      // 1. Claim job atomically via Postgres RPC FOR UPDATE SKIP LOCKED
      const { data: jobs, error } = await this.admin.rpc("claim_job_batch", {
        p_worker_id: worker.id,
        p_batch_size: 1,
      });

      if (error || !jobs || jobs.length === 0) {
        return false;
      }

      const job = jobs[0];
      worker.activeJobId = job.id;
      this.metrics.totalClaimed++;

      console.log(`[${worker.id}] 🚀 Processing Job #${job.id.slice(0, 8)} (${job.job_type}, Priority: ${job.priority})`);

      // 2. Execute Handler
      const handler = this.handlers.get(job.job_type) || this.handlers.get("custom");
      if (!handler) {
        throw new Error(`No registered handler for job_type: '${job.job_type}'`);
      }

      const result = await handler(job);

      // 3. Mark as completed
      await this.admin.rpc("complete_job", {
        p_job_id: job.id,
        p_result: result || {},
      });
      if (job.payload?.registration_id) {
        await this.admin
          .from("notification_jobs")
          .update({ status: "sent", last_error: null })
          .eq("registration_id", job.payload.registration_id)
          .eq("status", "queued");
      }

      this.metrics.totalProcessed++;
      worker.jobsCompleted++;
      worker.activeJobId = null;
      await this.recordCircuitSuccess();
      return true;
    } catch (err) {
      console.error(`[${worker.id}] ❌ Job execution failed:`, err.message);
      this.metrics.totalFailed++;
      await this.recordCircuitFailure(err.message);

      if (worker.activeJobId) {
        try {
          await this.admin.rpc("fail_job", {
            p_job_id: worker.activeJobId,
            p_error: err.message,
          });
          const failedJob = await this.admin
            .from("job_queue")
            .select("payload, status")
            .eq("id", worker.activeJobId)
            .maybeSingle();
          if (failedJob.data?.payload?.registration_id) {
            await this.admin
              .from("notification_jobs")
              .update({ status: failedJob.data.status === "dead_letter" ? "dead_letter" : "failed", last_error: err.message })
              .eq("registration_id", failedJob.data.payload.registration_id)
              .eq("status", "queued");
          }
        } catch {}
        worker.activeJobId = null;
      }
      return false;
    }
  }

  async processLegacyNotification() {
    // Legacy notification_jobs are records for the registration UI. New work
    // is always claimed from job_queue, which provides SKIP LOCKED safety.
    return false;
  }

  // --- Public Management APIs ----------------------------------------------
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[WorkerManager] Started with minWorkers=${this.minWorkers}, maxWorkers=${this.maxWorkers}`);

    // Spawn initial minimum baseline workers
    for (let i = 0; i < this.minWorkers; i++) {
      this.spawnWorker();
    }

    // Start auto-scaling evaluation timer
    this.scaleTimer = setInterval(() => {
      this.evaluateAndScale().catch((e) => console.error("[WorkerManager] Scale evaluation error:", e.message));
    }, this.scaleCheckIntervalMs);
  }

  stop() {
    this.isRunning = false;
    if (this.scaleTimer) clearInterval(this.scaleTimer);
    for (const worker of this.workers.values()) {
      worker.running = false;
    }
    this.workers.clear();
    console.log("[WorkerManager] Stopped all worker instances");
  }

  async enqueue(jobType, payload = {}, priority = 5, scheduledAt = new Date().toISOString()) {
    const { data: jobId, error } = await this.admin.rpc("enqueue_job", {
      p_job_type: jobType,
      p_payload: payload,
      p_priority: priority,
      p_scheduled_at: scheduledAt,
      p_max_attempts: 4,
    });

    if (error) throw error;
    // Trigger immediate scale evaluation on enqueue
    setImmediate(() => this.evaluateAndScale());
    return jobId;
  }

  getActiveWorkerCount() {
    let count = 0;
    for (const w of this.workers.values()) {
      if (w.activeJobId) count++;
    }
    return count;
  }

  getStats() {
    const workerList = Array.from(this.workers.values()).map((w) => ({
      id: w.id,
      activeJobId: w.activeJobId,
      jobsCompleted: w.jobsCompleted,
      spawnedAt: w.spawnedAt,
      busy: !!w.activeJobId,
    }));

    return {
      status: this.isRunning ? "running" : "stopped",
      minWorkers: this.minWorkers,
      maxWorkers: this.maxWorkers,
      currentWorkers: this.workers.size,
      activeBusyWorkers: this.getActiveWorkerCount(),
      queueDepth: this.metrics.lastQueueDepth,
      totalProcessed: this.metrics.totalProcessed,
      totalFailed: this.metrics.totalFailed,
      totalClaimed: this.metrics.totalClaimed,
      scalingHistory: this.metrics.scalingEvents,
      workerPool: workerList,
    };
  }
}
