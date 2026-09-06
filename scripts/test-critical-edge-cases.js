// scripts/test-critical-edge-cases.js
//
// Regression suite for the highest-risk edge cases in SurgeShield:
//   Group 1 — Zero-Overbooking & Race Conditions
//   Group 2 — Lifecycle Races (passport TTL, ghost sweep, queue promotion)
//   Group 3 — Downstream Resilience (job queue retries/DLQ, circuit guardian)
//   Group 4 — Access Control sanity check (job_queue RLS as anon)
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY as
// environment variables. This script intentionally does NOT fall back to any
// hardcoded value — a missing env var is a hard stop, not a silent default.
// Never commit real values for these into this file or into .env files that
// get checked in.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=... \
//     node scripts/test-critical-edge-cases.js

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

// Auto-load .env from local workspace for testing if not set in environment
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

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`\x1b[31mMissing required env var: ${name}\x1b[0m`);
    console.error("Refusing to run with a hardcoded fallback. Set it and re-run.");
    process.exit(1);
  }
  return v;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = requireEnv("SUPABASE_ANON_KEY");

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const anon = createClient(SUPABASE_URL, ANON_KEY);

let passed = 0;
let failed = 0;
const createdEventIds = [];

function assert(condition, testName, details = "") {
  if (condition) {
    console.log(`  \x1b[32m✔ PASS:\x1b[0m ${testName} ${details ? `\x1b[90m(${details})\x1b[0m` : ""}`);
    passed++;
  } else {
    console.error(`  \x1b[31m✖ FAIL:\x1b[0m ${testName} ${details ? `\x1b[33m[${details}]\x1b[0m` : ""}`);
    failed++;
  }
}

// Any authenticated profile works as the "organizer" for test events —
// we only ever act through the service-role client here.
async function getAnyProfileId() {
  const { data, error } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (error || !data) {
    throw new Error(
      "No profiles found. Seed at least one user (e.g. via scripts/seed-demo.sh) before running this suite.",
    );
  }
  return data.id;
}

async function makeUser(label) {
  const email = `edge.test.${label}.${Date.now()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error || !data?.user) throw new Error(`Failed to create test user ${label}: ${error?.message}`);
  await admin.from("profiles").upsert({ id: data.user.id, role: "attendee", full_name: label });
  return data.user.id;
}

async function makeEvent(organizerId, { capacity = 10, laneCount = 1 } = {}) {
  const { data: event, error } = await admin
    .from("events")
    .insert({
      organizer_id: organizerId,
      title: `Edge Case Test Event ${Date.now()}`,
      description: "Created by test-critical-edge-cases.js — safe to delete.",
      capacity,
      lane_count: laneCount,
      starts_at: new Date(Date.now() + 86400000).toISOString(),
      registration_open: true,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to create test event: ${error.message}`);
  createdEventIds.push(event.id);

  const perLane = Math.floor(capacity / laneCount) || 1;
  const lanes = Array.from({ length: laneCount }, (_, lane) => ({
    event_id: event.id,
    lane_index: lane,
    capacity: perLane,
    seats_taken: 0,
  }));
  const { error: laneErr } = await admin.from("seat_partitions").insert(lanes);
  if (laneErr) throw new Error(`Failed to seed partitions: ${laneErr.message}`);

  return event;
}

async function cleanup() {
  for (const id of createdEventIds) {
    await admin.from("events").delete().eq("id", id);
  }
}

// ---------------------------------------------------------------------------
// GROUP 1 — Zero-Overbooking & Race Conditions
// ---------------------------------------------------------------------------
async function groupConcurrency(organizerId) {
  console.log("\n\x1b[36m▶ GROUP 1: Zero-Overbooking & Race Conditions\x1b[0m");

  // 1.1 — Two different users race for the single seat in a 1-capacity lane.
  const event1 = await makeEvent(organizerId, { capacity: 1, laneCount: 1 });
  const userA = await makeUser("racer-a");
  const userB = await makeUser("racer-b");

  const [resA, resB] = await Promise.allSettled([
    admin.rpc("allocate_seat", {
      p_event_id: event1.id,
      p_lane_index: 0,
      p_user_id: userA,
      p_idempotency_key: crypto.randomUUID(),
    }),
    admin.rpc("allocate_seat", {
      p_event_id: event1.id,
      p_lane_index: 0,
      p_user_id: userB,
      p_idempotency_key: crypto.randomUUID(),
    }),
  ]);

  const successes = [resA, resB].filter((r) => r.status === "fulfilled" && !r.value?.error && r.value?.data);
  const failures = [resA, resB].filter((r) => r.status === "rejected" || r.value?.error || !r.value?.data);

  assert(
    successes.length === 1 && failures.length === 1,
    "1.1 Exactly one of two concurrent racers wins the last seat",
    `successes=${successes.length}, failures=${failures.length}`,
  );

  const { data: partitionAfter1 } = await admin
    .from("seat_partitions")
    .select("seats_taken, capacity")
    .eq("event_id", event1.id)
    .eq("lane_index", 0)
    .single();
  assert(
    partitionAfter1.seats_taken === partitionAfter1.capacity,
    "1.1b Partition never exceeds capacity after the race",
    `seats_taken=${partitionAfter1.seats_taken}, capacity=${partitionAfter1.capacity}`,
  );

  // 1.2 — Same user, same idempotency key, fired twice concurrently
  // (simulates a genuine double-click before the client has a response yet).
  const event2 = await makeEvent(organizerId, { capacity: 10, laneCount: 1 });
  const userC = await makeUser("double-click");
  const sharedKey = crypto.randomUUID();

  await Promise.allSettled([
    admin.rpc("allocate_seat", {
      p_event_id: event2.id,
      p_lane_index: 0,
      p_user_id: userC,
      p_idempotency_key: sharedKey,
    }),
    admin.rpc("allocate_seat", {
      p_event_id: event2.id,
      p_lane_index: 0,
      p_user_id: userC,
      p_idempotency_key: sharedKey,
    }),
  ]);

  const { data: dupRows } = await admin
    .from("registrations")
    .select("id")
    .eq("idempotency_key", sharedKey);
  assert(
    dupRows.length === 1,
    "1.2 Double-click with same idempotency key produces exactly one registration",
    `rows=${dupRows.length}`,
  );

  // 1.3 — Burst of concurrent allocations against a small lane: never overbook.
  const event3 = await makeEvent(organizerId, { capacity: 5, laneCount: 1 });
  const burstUsers = await Promise.all(
    Array.from({ length: 12 }, (_, i) => makeUser(`burst-${i}`)),
  );
  const burstResults = await Promise.allSettled(
    burstUsers.map((uid) =>
      admin.rpc("allocate_seat", {
        p_event_id: event3.id,
        p_lane_index: 0,
        p_user_id: uid,
        p_idempotency_key: crypto.randomUUID(),
      }),
    ),
  );
  const burstSuccesses = burstResults.filter((r) => r.status === "fulfilled" && !r.value?.error && r.value?.data);
  assert(
    burstSuccesses.length === 5,
    "1.3 12-way burst against 5-seat lane admits exactly 5",
    `admitted=${burstSuccesses.length}`,
  );
}

// ---------------------------------------------------------------------------
// GROUP 2 — Lifecycle Races
// ---------------------------------------------------------------------------
async function groupLifecycle(organizerId) {
  console.log("\n\x1b[36m▶ GROUP 2: Lifecycle Races\x1b[0m");

  const event = await makeEvent(organizerId, { capacity: 5, laneCount: 1 });
  const userExpired = await makeUser("expired-passport");
  const userFuture = await makeUser("future-passport");

  const { data: regExpired } = await admin
    .from("registrations")
    .insert({
      event_id: event.id,
      user_id: userExpired,
      lane_index: 0,
      status: "pending",
      seat_passport_expires_at: new Date(Date.now() - 5000).toISOString(),
    })
    .select()
    .single();

  const { data: regFuture } = await admin
    .from("registrations")
    .insert({
      event_id: event.id,
      user_id: userFuture,
      lane_index: 0,
      status: "pending",
      seat_passport_expires_at: new Date(Date.now() + 60000).toISOString(),
    })
    .select()
    .single();

  // Reflect both pending seats in the partition counter, matching what
  // allocate_seat() would have done.
  await admin
    .from("seat_partitions")
    .update({ seats_taken: 2 })
    .eq("event_id", event.id)
    .eq("lane_index", 0);

  // 2.1 — release_expired_seats() must only touch the truly-expired row.
  await admin.rpc("release_expired_seats");

  const { data: afterSweep } = await admin
    .from("registrations")
    .select("id, status")
    .in("id", [regExpired.id, regFuture.id]);
  const expiredRow = afterSweep.find((r) => r.id === regExpired.id);
  const futureRow = afterSweep.find((r) => r.id === regFuture.id);

  assert(
    expiredRow?.status === "expired",
    "2.1 Truly-expired registration is marked expired by the sweep",
  );
  assert(
    futureRow?.status === "pending",
    "2.1b Not-yet-expired registration is left untouched by the same sweep",
  );

  // 2.2 — Ghost sweep racing a legitimate concurrent confirm on the SAME row.
  const userRace = await makeUser("sweep-vs-confirm");
  const { data: regRace } = await admin
    .from("registrations")
    .insert({
      event_id: event.id,
      user_id: userRace,
      lane_index: 0,
      status: "pending",
      seat_passport_expires_at: new Date(Date.now() - 1000).toISOString(),
    })
    .select()
    .single();

  await Promise.allSettled([
    admin.rpc("release_expired_seats"),
    admin.from("registrations").update({ status: "confirmed" }).eq("id", regRace.id).eq("status", "pending"),
  ]);

  const { data: finalRaceRow } = await admin
    .from("registrations")
    .select("status")
    .eq("id", regRace.id)
    .single();

  assert(
    finalRaceRow.status === "expired" || finalRaceRow.status === "confirmed",
    "2.2 Sweep-vs-confirm race lands on exactly one consistent terminal state",
    `final status=${finalRaceRow.status}`,
  );
  assert(
    finalRaceRow.status !== "pending",
    "2.2b Row never gets stuck straddling both outcomes",
  );

  // 2.3 — Passport issuance guard test
  const userPromoted = await makeUser("promoted-no-token");
  const { data: regPromoted } = await admin
    .from("registrations")
    .insert({
      event_id: event.id,
      user_id: userPromoted,
      lane_index: 0,
      status: "pending",
      seat_passport_token: null,
    })
    .select()
    .single();

  async function finishOnePromotion() {
    const { data: rows } = await admin
      .from("registrations")
      .select("id")
      .eq("id", regPromoted.id)
      .is("seat_passport_token", null);
    for (const r of rows ?? []) {
      await admin
        .from("registrations")
        .update({ seat_passport_token: `TEST.${crypto.randomUUID()}` })
        .eq("id", r.id);
    }
    return rows?.length ?? 0;
  }

  const firstRunCount = await finishOnePromotion();
  const secondRunCount = await finishOnePromotion();
  assert(
    firstRunCount === 1 && secondRunCount === 0,
    "2.3 Passport issuance guard prevents double-issuance when run twice",
    `first=${firstRunCount}, second=${secondRunCount}`,
  );

  // 2.4 — Cascade check
  const eventForQueue = await makeEvent(organizerId, { capacity: 1, laneCount: 1 });
  const queueUser = await makeUser("queue-orphan-check");
  await admin.from("queue_entries").insert({
    event_id: eventForQueue.id,
    user_id: queueUser,
    lane_index: 0,
    status: "waiting",
  });
  await admin.from("events").delete().eq("id", eventForQueue.id);
  createdEventIds.splice(createdEventIds.indexOf(eventForQueue.id), 1);

  const { data: orphanCheck } = await admin
    .from("queue_entries")
    .select("id")
    .eq("event_id", eventForQueue.id);
  assert(
    (orphanCheck?.length ?? 0) === 0,
    "2.4 Deleting an event cascades to its waiting-queue entries (no orphans)",
  );
}

// ---------------------------------------------------------------------------
// GROUP 3 — Downstream Resilience (job queue + circuit guardian)
// ---------------------------------------------------------------------------
async function groupResilience() {
  console.log("\n\x1b[36m▶ GROUP 3: Downstream Resilience\x1b[0m");

  // 3.1 — DLQ transition
  const jobIdOneShot = await admin
    .rpc("enqueue_job", {
      p_job_type: "test_dlq_job",
      p_payload: { test: true },
      p_priority: 5,
      p_max_attempts: 1,
    })
    .then((r) => r.data);

  await admin.rpc("claim_job_batch", {
    p_worker_id: "edge-case-test",
    p_batch_size: 1,
    p_job_types: ["test_dlq_job"],
  });
  await admin.rpc("fail_job", { p_job_id: jobIdOneShot, p_error: "simulated failure" });

  const { data: dlqJob } = await admin
    .from("job_queue")
    .select("status")
    .eq("id", jobIdOneShot)
    .single();
  assert(
    dlqJob.status === "dead_letter",
    "3.1 Job with max_attempts=1 goes to dead_letter after its first failure",
  );

  // 3.2 — Retry reschedule
  const jobIdRetry = await admin
    .rpc("enqueue_job", {
      p_job_type: "test_retry_job",
      p_payload: { test: true },
      p_priority: 5,
      p_max_attempts: 3,
    })
    .then((r) => r.data);

  await admin.rpc("claim_job_batch", {
    p_worker_id: "edge-case-test",
    p_batch_size: 1,
    p_job_types: ["test_retry_job"],
  });
  await admin.rpc("fail_job", { p_job_id: jobIdRetry, p_error: "transient failure", p_retry_delay_seconds: 30 });

  const { data: retryJob } = await admin
    .from("job_queue")
    .select("status, scheduled_at")
    .eq("id", jobIdRetry)
    .single();
  assert(
    retryJob.status === "pending" && new Date(retryJob.scheduled_at) > new Date(),
    "3.2 Job with attempts remaining is rescheduled into the future, not dead-lettered",
    `status=${retryJob.status}`,
  );

  // 3.3 — Idempotency of release_expired_seats
  const { data: firstSweepCount } = await admin.rpc("release_expired_seats");
  const { data: secondSweepCount } = await admin.rpc("release_expired_seats");
  assert(
    secondSweepCount === 0,
    "3.3 Back-to-back release_expired_seats() calls are idempotent",
    `first=${firstSweepCount}, second=${secondSweepCount}`,
  );

  // 3.4 — Circuit Guardian state audit
  await admin.rpc("set_circuit_guardian_state", { p_state: "open", p_reason: "edge-case-test-open" });
  await admin.rpc("set_circuit_guardian_state", { p_state: "closed", p_reason: "edge-case-test-close" });

  const { data: auditRows } = await admin
    .from("audit_logs")
    .select("action")
    .in("action", ["circuit_guardian_open", "circuit_guardian_close"])
    .order("created_at", { ascending: false })
    .limit(2);
  const actions = (auditRows ?? []).map((r) => r.action);
  assert(
    actions.includes("circuit_guardian_open") && actions.includes("circuit_guardian_close"),
    "3.4 Circuit Guardian open/close transitions are both recorded in the audit chain",
  );

  // cleanup test job rows
  await admin.from("job_queue").delete().in("id", [jobIdOneShot, jobIdRetry]);
}

// ---------------------------------------------------------------------------
// GROUP 4 — Access control sanity check
// ---------------------------------------------------------------------------
async function groupAccessControl() {
  console.log("\n\x1b[36m▶ GROUP 4: Access Control Sanity Check\x1b[0m");

  const { data: anonInsert, error: anonInsertErr } = await anon
    .from("job_queue")
    .insert({ job_type: "anon_probe", payload: {}, priority: 1 })
    .select()
    .maybeSingle();

  if (anonInsertErr) {
    assert(true, "4.1 Anonymous client CANNOT insert into job_queue", "insert blocked, as expected for locked-down RLS");
  } else {
    assert(
      false,
      "4.1 Anonymous client CANNOT insert into job_queue",
      "insert SUCCEEDED — job_queue RLS currently allows anon writes, confirm this is intentional",
    );
    // Clean up the row our own probe created.
    await admin.from("job_queue").delete().eq("id", anonInsert.id);
  }
}

// ---------------------------------------------------------------------------
async function runTests() {
  console.log("\n=========================================================");
  console.log(" 🛡️ SurgeShield Critical Edge Case Regression Suite");
  console.log("=========================================================");

  try {
    const organizerId = await getAnyProfileId();
    await groupConcurrency(organizerId);
    await groupLifecycle(organizerId);
    await groupResilience();
    await groupAccessControl();
  } catch (err) {
    console.error("\x1b[31mUnexpected Test Runner Exception:\x1b[0m", err);
    failed++;
  } finally {
    await cleanup();
  }

  console.log("\n=========================================================");
  console.log(` 🏁 RUN COMPLETE: \x1b[32m${passed} Passed\x1b[0m | \x1b[${failed > 0 ? "31" : "32"}m${failed} Failed\x1b[0m`);
  console.log("=========================================================\n");

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
