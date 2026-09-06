// scripts/test-worker-scaling.js
// Automated test script to validate job_queue priority scheduling & WorkerManager autoscaling

import { createClient } from "@supabase/supabase-js";
import { WorkerManager } from "../worker/workerManager.js";
import fs from "node:fs";
import path from "node:path";

// Auto-load .env
const envPaths = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "worker", ".env"),
  path.resolve(process.cwd(), "..", ".env"),
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
          if (key && !process.env[key]) process.env[key] = val;
        }
      }
    } catch {}
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || "https://uyafreiwfuansdfacxye.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY required");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
let passed = 0;
let failed = 0;

function assert(condition, name, detail = "") {
  if (condition) {
    console.log(`  \x1b[32m✔ PASS:\x1b[0m ${name} ${detail ? `\x1b[90m(${detail})\x1b[0m` : ""}`);
    passed++;
  } else {
    console.error(`  \x1b[31m✖ FAIL:\x1b[0m ${name} ${detail ? `\x1b[33m[${detail}]\x1b[0m` : ""}`);
    failed++;
  }
}

async function runTests() {
  console.log("\n=========================================================");
  console.log(" ⚙️ SurgeShield Job Queue & WorkerManager Scaling Test");
  console.log("=========================================================\n");

  try {
    // 1. WorkerManager Instantiation
    console.log("\x1b[36m▶ TEST 1: WorkerManager Initialization\x1b[0m");
    const manager = new WorkerManager({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      minWorkers: 2,
      maxWorkers: 8,
      jobsPerWorker: 2,
      scaleCheckIntervalMs: 500,
      scaleDownCooldownMs: 1000,
    });

    assert(manager.minWorkers === 2 && manager.maxWorkers === 8, "1.1 WorkerManager initializes with min/max worker bounds");

    // 2. Queue Depth & Target Calculation
    console.log("\n\x1b[36m▶ TEST 2: Scaling Algorithm Evaluation\x1b[0m");
    
    // Depth 0 -> 2 min workers
    const target0 = manager.calculateTargetWorkers({ total_pending: 0, critical_pending: 0 });
    assert(target0 === 2, "2.1 Zero queue depth calculates target = minWorkers (2)", `Target: ${target0}`);

    // Depth 6 normal -> 3 workers (6 / 2)
    const target6 = manager.calculateTargetWorkers({ total_pending: 6, critical_pending: 0 });
    assert(target6 === 3, "2.2 6 pending jobs with ratio 2 calculates target = 3 workers", `Target: ${target6}`);

    // Depth 10 with 4 critical -> 5 + 2 = 7 workers
    const targetCrit = manager.calculateTargetWorkers({ total_pending: 10, critical_pending: 4 });
    assert(targetCrit === 7, "2.3 High priority spike calculates immediate surge capacity boost", `Target: ${targetCrit}`);

    // Depth 100 -> clamped at maxWorkers (8)
    const targetMax = manager.calculateTargetWorkers({ total_pending: 100, critical_pending: 20 });
    assert(targetMax === 8, "2.4 Extreme backlog clamps cleanly to maxWorkers (8)", `Target: ${targetMax}`);

    // 3. Worker Spawn and Scale Lifecycle
    console.log("\n\x1b[36m▶ TEST 3: Dynamic Worker Pool Lifecycle\x1b[0m");
    manager.start();
    assert(manager.workers.size === 2, "3.1 WorkerManager spawns initial baseline workers upon start()", `Active: ${manager.workers.size}`);

    // Enqueue a test handler
    let customJobProcessed = false;
    manager.registerHandler("test_job", async (job) => {
      customJobProcessed = true;
      return { success: true, processed_payload: job.payload };
    });

    const stats = manager.getStats();
    assert(stats.status === "running" && stats.workerPool.length === 2, "3.2 getStats() returns complete telemetry & pool status");

    // Stop manager
    manager.stop();
    assert(manager.workers.size === 0 && !manager.isRunning, "3.3 stop() cleanly terminates all active workers");

    console.log("\n=========================================================");
    console.log(` Summary: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
    console.log("=========================================================\n");
  } catch (err) {
    console.error("Test Suite crashed:", err);
  }
}

runTests();
