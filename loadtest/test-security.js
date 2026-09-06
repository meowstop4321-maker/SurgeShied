// Task 18: rate limiting, invalid input, duplicate requests (duplicate
// requests already covered exhaustively in test-duplicates.js; this file
// covers the other two).
const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const { registerForEvent } = require("./harness");
const { makeOrganizer, makeUsers, makeEvent } = require("./fixtures");

const pool = new Pool({ host: "127.0.0.1", port: 54329, user: "postgres", password: "postgres", database: "postgres", max: 20 });

async function testRateLimiting() {
  const key = `test-user:${randomUUID()}`;
  // Matches surge-router's real config: 8 requests / 30s window, 20s cooldown.
  const results = [];
  for (let i = 0; i < 12; i++) {
    const r = await pool.query("select check_rate_limit($1, 8, 30, 20) as res", [key]);
    results.push(r.rows[0].res);
  }
  const allowedCount = results.filter((r) => r.allowed).length;
  const firstBlockedIdx = results.findIndex((r) => !r.allowed);
  const blockedHasRetryAfter = firstBlockedIdx >= 0 && typeof results[firstBlockedIdx].retry_after === "number";
  const ok = allowedCount === 8 && firstBlockedIdx === 8 && blockedHasRetryAfter;
  console.log(
    `Rate limiting (8 req/30s window): allowed=${allowedCount}/12 first_blocked_at_request=${firstBlockedIdx + 1} ` +
      `retry_after_present=${blockedHasRetryAfter} -> ${ok ? "PASS" : "FAIL"}`,
  );
  return ok;
}

async function testInvalidEventId() {
  const [userId] = await makeUsers(pool, 1);
  // Malformed UUID — surge-router passes event_id straight into a
  // parameterized query, so Postgres itself rejects the type, and that
  // needs to surface as a clean error, not an unhandled crash.
  let threwCleanly = false;
  try {
    await registerForEvent(pool, "not-a-real-uuid", userId, randomUUID());
  } catch (err) {
    threwCleanly = err.code === "22P02"; // invalid_text_representation
  }
  console.log(`Invalid event_id (malformed UUID) -> rejected by Postgres type system: threw_clean_error=${threwCleanly} -> ${threwCleanly ? "PASS" : "FAIL"}`);

  // Well-formed but nonexistent UUID -> registerForEvent's own 404 path.
  const result = await registerForEvent(pool, randomUUID(), userId, randomUUID());
  const ok404 = result.status === 404 && result.body.status === "error";
  console.log(`Nonexistent event_id (valid UUID, no such event) -> 404: status=${result.status} body=${JSON.stringify(result.body)} -> ${ok404 ? "PASS" : "FAIL"}`);
  return threwCleanly && ok404;
}

async function testClosedRegistration() {
  const organizerId = await makeOrganizer(pool);
  const [userId] = await makeUsers(pool, 1);
  const eventId = await makeEvent(pool, organizerId, [5]);
  await pool.query("update events set registration_open = false where id = $1", [eventId]);
  const result = await registerForEvent(pool, eventId, userId, randomUUID());
  const ok = result.status === 409 && result.body.status === "closed";
  console.log(`Registration closed on event -> 409 closed (not silently queued/confirmed): status=${result.status} body=${JSON.stringify(result.body)} -> ${ok ? "PASS" : "FAIL"}`);
  return ok;
}

async function testZeroCapacityLane() {
  // Edge case: a lane drained to 0 capacity (e.g. by the elastic lane-merge
  // logic) must never be selected as "headroom > 0", and must never let
  // seats_taken go negative or over. events.capacity itself must stay > 0
  // (DB check constraint), so this uses a second, healthy lane alongside
  // the drained one — the realistic shape of a merged-away lane.
  const organizerId = await makeOrganizer(pool);
  const [userId] = await makeUsers(pool, 1);
  const eventId = await makeEvent(pool, organizerId, [0, 5]);
  const result = await registerForEvent(pool, eventId, userId, randomUUID());
  const partitions = (await pool.query("select lane_index, seats_taken, capacity from seat_partitions where event_id = $1 order by lane_index", [eventId])).rows;
  const drainedLane = partitions.find((p) => p.lane_index === 0);
  const healthyLane = partitions.find((p) => p.lane_index === 1);
  const ok =
    result.body.status === "confirmed" &&
    result.body.lane_index === 1 && // must route to the lane WITH headroom, never the drained one
    drainedLane.seats_taken === 0 &&
    healthyLane.seats_taken === 1;
  console.log(
    `Zero-capacity (drained) lane alongside a healthy one -> routes only to the healthy lane: chosen_lane=${result.body.lane_index} ` +
      `drained_seats=${drainedLane.seats_taken}/${drainedLane.capacity} healthy_seats=${healthyLane.seats_taken}/${healthyLane.capacity} -> ${ok ? "PASS" : "FAIL"}`,
  );
  return ok;
}

(async () => {
  const results = [];
  results.push(await testRateLimiting());
  results.push(await testInvalidEventId());
  results.push(await testClosedRegistration());
  results.push(await testZeroCapacityLane());
  const allPass = results.every(Boolean);
  console.log(allPass ? "\nALL_SECURITY_CHECKS_PASS" : "\nSOME_SECURITY_CHECKS_FAILED");
  await pool.end();
  process.exit(allPass ? 0 : 1);
})().catch(async (err) => {
  console.error("FATAL", err);
  await pool.end();
  process.exit(1);
});
