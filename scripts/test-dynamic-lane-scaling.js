// scripts/test-dynamic-lane-scaling.js
//
// Regression suite for Dynamic (Elastic) Surge Partitions (migration
// 0010_dynamic_lane_scaling.sql): split_lane, merge_lanes, rebalance_lanes,
// and — most importantly — that none of this ever breaks the
// zero-overbooking invariant even while lanes are being split/merged
// concurrently with real registrations landing on them.
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY as environment
// variables (same convention as test-critical-edge-cases.js). Never
// commit real values for these.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/test-dynamic-lane-scaling.js

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

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
    process.exit(1);
  }
  return v;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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

async function getAnyProfileId() {
  const { data, error } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  if (error || !data) {
    throw new Error("No profiles found. Seed at least one user (e.g. via scripts/seed-demo.sh) before running this suite.");
  }
  return data.id;
}

async function makeUser(label) {
  const email = `lane.test.${label}.${Date.now()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: "TestPassword123!", email_confirm: true });
  if (error || !data?.user) throw new Error(`Failed to create test user ${label}: ${error?.message}`);
  await admin.from("profiles").upsert({ id: data.user.id, role: "attendee", full_name: label });
  return data.user.id;
}

async function makeEvent(organizerId, { capacity = 20, laneCount = 2 } = {}) {
  const { data: event, error } = await admin
    .from("events")
    .insert({
      organizer_id: organizerId,
      title: `Dynamic Lane Test Event ${Date.now()}`,
      description: "Created by test-dynamic-lane-scaling.js — safe to delete.",
      capacity,
      lane_count: laneCount,
      min_lane_count: laneCount,
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

async function totalCapacityAndSeats(eventId) {
  const { data } = await admin.from("seat_partitions").select("capacity, seats_taken").eq("event_id", eventId);
  return {
    totalCapacity: (data ?? []).reduce((s, l) => s + l.capacity, 0),
    totalSeats: (data ?? []).reduce((s, l) => s + l.seats_taken, 0),
    laneCount: (data ?? []).length,
  };
}

async function cleanup() {
  for (const id of createdEventIds) {
    await admin.from("events").delete().eq("id", id);
  }
}

// ---------------------------------------------------------------------------
async function groupSplitMerge(organizerId) {
  console.log("\n\x1b[36m▶ GROUP 1: split_lane / merge_lanes capacity conservation\x1b[0m");

  const event = await makeEvent(organizerId, { capacity: 20, laneCount: 2 });
  const before = await totalCapacityAndSeats(event.id);

  const { data: splitResult, error: splitErr } = await admin.rpc("split_lane", { p_event_id: event.id, p_lane_index: 0 });
  assert(!splitErr && splitResult, "1.1 split_lane succeeds on a lane with spare headroom");

  const afterSplit = await totalCapacityAndSeats(event.id);
  assert(
    afterSplit.totalCapacity === before.totalCapacity,
    "1.2 Total capacity is unchanged by a split",
    `before=${before.totalCapacity}, after=${afterSplit.totalCapacity}`,
  );
  assert(afterSplit.laneCount === before.laneCount + 1, "1.3 Lane count increases by exactly one after a split");

  const { data: lanesAfterSplit } = await admin.from("seat_partitions").select("lane_index").eq("event_id", event.id).order("lane_index");
  const laneIndexes = lanesAfterSplit.map((l) => l.lane_index);
  const [laneA, laneB] = laneIndexes.slice(0, 2);
  const { data: mergeResult, error: mergeErr } = await admin.rpc("merge_lanes", { p_event_id: event.id, p_lane_a: laneA, p_lane_b: laneB });
  assert(!mergeErr && mergeResult, "1.4 merge_lanes succeeds on two existing lanes");

  const afterMerge = await totalCapacityAndSeats(event.id);
  assert(
    afterMerge.totalCapacity === before.totalCapacity,
    "1.5 Total capacity is unchanged by a merge",
    `before=${before.totalCapacity}, after=${afterMerge.totalCapacity}`,
  );
  assert(afterMerge.laneCount === afterSplit.laneCount - 1, "1.6 Lane count decreases by exactly one after a merge");

  // Splitting a fully-saturated lane should be a safe no-op, not an error.
  const fullEvent = await makeEvent(organizerId, { capacity: 2, laneCount: 1 });
  await admin.from("seat_partitions").update({ seats_taken: 2 }).eq("event_id", fullEvent.id).eq("lane_index", 0);
  const { data: noSplit, error: noSplitErr } = await admin.rpc("split_lane", { p_event_id: fullEvent.id, p_lane_index: 0 });
  assert(!noSplitErr && noSplit === null, "1.7 Splitting a fully-saturated lane is a safe no-op (nothing to move)");
}

// ---------------------------------------------------------------------------
async function groupQueueReassignment(organizerId) {
  console.log("\n\x1b[36m▶ GROUP 2: merge_lanes preserves waiting-queue FIFO order\x1b[0m");

  const event = await makeEvent(organizerId, { capacity: 4, laneCount: 2 });
  await admin.from("seat_partitions").update({ seats_taken: 2 }).eq("event_id", event.id).eq("lane_index", 1);

  const waiterA = await makeUser("waiter-a");
  const waiterB = await makeUser("waiter-b");
  await admin.from("queue_entries").insert({ event_id: event.id, user_id: waiterA, lane_index: 1, status: "waiting" });
  await new Promise((r) => setTimeout(r, 50));
  await admin.from("queue_entries").insert({ event_id: event.id, user_id: waiterB, lane_index: 1, status: "waiting" });

  await admin.rpc("merge_lanes", { p_event_id: event.id, p_lane_a: 0, p_lane_b: 1 });

  const { data: entries } = await admin
    .from("queue_entries")
    .select("user_id, lane_index, created_at")
    .eq("event_id", event.id)
    .eq("status", "waiting")
    .order("created_at", { ascending: true });

  assert(
    (entries ?? []).length === 2 && entries[0].user_id === waiterA && entries[1].user_id === waiterB,
    "2.1 Both waiting entries survive the merge in original arrival order",
    `count=${entries?.length}`,
  );
  assert(
    (entries ?? []).every((e) => e.lane_index === 0),
    "2.2 Waiting entries are reassigned to the surviving lane",
  );
}

// ---------------------------------------------------------------------------
async function groupRebalanceConcurrency(organizerId) {
  console.log("\n\x1b[36m▶ GROUP 3: rebalance_lanes concurrency (no stampede, no overbooking)\x1b[0m");

  const event = await makeEvent(organizerId, { capacity: 200, laneCount: 2 });
  // Manufacture a clear "surge": lanes hot, queue deep.
  await admin.from("seat_partitions").update({ seats_taken: 95 }).eq("event_id", event.id).eq("lane_index", 0);
  await admin.from("seat_partitions").update({ seats_taken: 95 }).eq("event_id", event.id).eq("lane_index", 1);
  const waiters = await Promise.all(Array.from({ length: 25 }, (_, i) => makeUser(`surge-waiter-${i}`)));
  for (const uid of waiters) {
    await admin.from("queue_entries").insert({ event_id: event.id, user_id: uid, lane_index: 0, status: "waiting" });
  }

  const before = await totalCapacityAndSeats(event.id);

  // Fire 10 concurrent rebalance calls, exactly like 10 concurrent
  // registrations all noticing the same surge at once would.
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => admin.rpc("rebalance_lanes", { p_event_id: event.id })),
  );
  const rebalancedCount = results.filter((r) => r.status === "fulfilled" && r.value.data?.rebalanced).length;

  assert(
    rebalancedCount === 1,
    "3.1 Exactly one of 10 concurrent rebalance calls actually performs a split (advisory lock dedup)",
    `rebalanced=${rebalancedCount}/10`,
  );

  const after = await totalCapacityAndSeats(event.id);
  assert(after.totalCapacity === before.totalCapacity, "3.2 Total capacity is still conserved after a concurrent rebalance burst");
  assert(after.laneCount === before.laneCount + 1, "3.3 Lane count grew by exactly one, not by ten");

  // The core invariant: hammer allocate_seat concurrently on the newly-
  // split lanes and confirm the partition constraint (seats_taken <=
  // capacity) is never violated, even immediately after a split.
  const { data: lanesNow } = await admin.from("seat_partitions").select("lane_index, capacity, seats_taken").eq("event_id", event.id);
  const targetLane = lanesNow.sort((a, b) => (b.capacity - b.seats_taken) - (a.capacity - a.seats_taken))[0];
  const headroom = targetLane.capacity - targetLane.seats_taken;
  const burstUsers = await Promise.all(Array.from({ length: headroom + 5 }, (_, i) => makeUser(`post-split-burst-${i}`)));
  const burstResults = await Promise.allSettled(
    burstUsers.map((uid) =>
      admin.rpc("allocate_seat", {
        p_event_id: event.id,
        p_lane_index: targetLane.lane_index,
        p_user_id: uid,
        p_idempotency_key: crypto.randomUUID(),
        p_confirmed: true,
      }),
    ),
  );
  const admitted = burstResults.filter((r) => r.status === "fulfilled" && !r.value?.error && r.value?.data).length;
  const { data: finalLane } = await admin
    .from("seat_partitions")
    .select("seats_taken, capacity")
    .eq("event_id", event.id)
    .eq("lane_index", targetLane.lane_index)
    .single();

  assert(admitted === headroom, `3.4 Post-split burst admits exactly the lane's headroom (${headroom}), never more`, `admitted=${admitted}`);
  assert(finalLane.seats_taken <= finalLane.capacity, "3.5 Post-split lane never exceeds its own capacity", `${finalLane.seats_taken}/${finalLane.capacity}`);
}

// ---------------------------------------------------------------------------
async function groupScaleDownCooldown(organizerId) {
  console.log("\n\x1b[36m▶ GROUP 4: scale-down cooldown\x1b[0m");

  const event = await makeEvent(organizerId, { capacity: 100, laneCount: 3 });
  // Force a very recent scale event, then confirm a would-be scale-down is
  // held back by the 45s cooldown instead of firing immediately.
  await admin.from("events").update({ last_lane_scale_at: new Date().toISOString() }).eq("id", event.id);
  // Drain all lanes so suggest_lane_count() wants to shrink.
  const { data: lanes } = await admin.from("seat_partitions").select("id").eq("event_id", event.id);
  for (const l of lanes) {
    await admin.from("seat_partitions").update({ seats_taken: 0 }).eq("id", l.id);
  }

  const { data: result } = await admin.rpc("rebalance_lanes", { p_event_id: event.id });
  assert(
    result?.rebalanced === false && result?.reason === "scale-down cooldown",
    "4.1 Scale-down is held back within the cooldown window",
    JSON.stringify(result),
  );

  const after = await totalCapacityAndSeats(event.id);
  assert(after.laneCount === 3, "4.2 Lane count is unchanged while the cooldown is active");
}

// ---------------------------------------------------------------------------
async function runTests() {
  console.log("\n=========================================================");
  console.log(" 🛡️ SurgeShield Dynamic Lane Scaling Regression Suite");
  console.log("=========================================================");

  try {
    const organizerId = await getAnyProfileId();
    await groupSplitMerge(organizerId);
    await groupQueueReassignment(organizerId);
    await groupRebalanceConcurrency(organizerId);
    await groupScaleDownCooldown(organizerId);
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
