// Task 6 requirement: double-click, refresh-during-registration,
// retry-after-timeout, repeated API calls — verify idempotency and no
// duplicate seat allocation, regardless of which of these causes the retry.
const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const { registerForEvent } = require("./harness");
const { makeOrganizer, makeUsers, makeEvent } = require("./fixtures");

const pool = new Pool({ host: "127.0.0.1", port: 54329, user: "postgres", password: "postgres", database: "postgres", max: 60 });

async function seatsAndConfirmedCount(eventId) {
  const p = await pool.query("select seats_taken, capacity from seat_partitions where event_id = $1", [eventId]);
  const r = await pool.query("select count(*)::int as n from registrations where event_id = $1 and status = 'confirmed'", [eventId]);
  return { seats_taken: p.rows[0].seats_taken, capacity: p.rows[0].capacity, confirmed_rows: r.rows[0].n };
}

async function scenarioA_doubleClickDifferentKeys() {
  // Real frontend behavior today: api.ts generates a NEW crypto.randomUUID()
  // Idempotency-Key on every call, so a literal double-click produces two
  // requests with DIFFERENT keys. The idempotency_keys cache can't catch
  // this — the backstop has to be the DB's unique index on (event_id,
  // user_id). This test proves that backstop actually holds.
  const organizerId = await makeOrganizer(pool);
  const [userId] = await makeUsers(pool, 1);
  const eventId = await makeEvent(pool, organizerId, [10]);

  const CLICKS = 20; // simulate a very trigger-happy double-click
  const results = await Promise.all(
    Array.from({ length: CLICKS }, () => registerForEvent(pool, eventId, userId, randomUUID())),
  );
  const statuses = results.map((r) => r.body.status);
  const confirmed = statuses.filter((s) => s === "confirmed").length;
  const alreadyReg = statuses.filter((s) => s === "already_registered").length;
  const { seats_taken, confirmed_rows } = await seatsAndConfirmedCount(eventId);

  const ok = confirmed === 1 && alreadyReg === CLICKS - 1 && seats_taken === 1 && confirmed_rows === 1;
  console.log(
    `Scenario A (double-click, ${CLICKS} distinct idempotency keys, same user): confirmed=${confirmed} already_registered=${alreadyReg} ` +
      `seats_taken=${seats_taken} confirmed_rows=${confirmed_rows} -> ${ok ? "PASS" : "FAIL"}`,
  );
  return ok;
}

async function scenarioB_retrySameKey() {
  // True "retry after timeout": client resends the exact same request,
  // including the same Idempotency-Key, because it never saw the first
  // response. This should hit the idempotency_keys fast-path cache and
  // return the cached response WITHOUT touching seat counts again.
  const organizerId = await makeOrganizer(pool);
  const [userId] = await makeUsers(pool, 1);
  const eventId = await makeEvent(pool, organizerId, [10]);
  const key = randomUUID();

  const first = await registerForEvent(pool, eventId, userId, key);
  const retries = await Promise.all(Array.from({ length: 10 }, () => registerForEvent(pool, eventId, userId, key)));

  const allSameStatus = [first, ...retries].every((r) => r.body.status === first.body.status);
  const { seats_taken, confirmed_rows } = await seatsAndConfirmedCount(eventId);
  const ok = first.body.status === "confirmed" && allSameStatus && seats_taken === 1 && confirmed_rows === 1;
  console.log(
    `Scenario B (retry-after-timeout, same idempotency key x11): first=${first.body.status} all_identical=${allSameStatus} ` +
      `seats_taken=${seats_taken} confirmed_rows=${confirmed_rows} -> ${ok ? "PASS" : "FAIL"}`,
  );
  return ok;
}

async function scenarioC_refreshDuringRegistration() {
  // "Refresh during registration": user's first request is still in flight
  // (simulated by firing it and, before awaiting it, firing a second
  // request for the same user with a fresh key — like a page reload
  // re-submitting before the first response ever arrived).
  const organizerId = await makeOrganizer(pool);
  const [userId] = await makeUsers(pool, 1);
  const eventId = await makeEvent(pool, organizerId, [10]);

  const p1 = registerForEvent(pool, eventId, userId, randomUUID());
  const p2 = registerForEvent(pool, eventId, userId, randomUUID());
  const [r1, r2] = await Promise.all([p1, p2]);
  const statuses = [r1.body.status, r2.body.status].sort();
  const { seats_taken, confirmed_rows } = await seatsAndConfirmedCount(eventId);
  const ok =
    statuses.filter((s) => s === "confirmed").length === 1 &&
    statuses.filter((s) => s === "already_registered").length === 1 &&
    seats_taken === 1 &&
    confirmed_rows === 1;
  console.log(
    `Scenario C (refresh mid-registration, 2 concurrent requests, same user): statuses=${JSON.stringify(statuses)} ` +
      `seats_taken=${seats_taken} confirmed_rows=${confirmed_rows} -> ${ok ? "PASS" : "FAIL"}`,
  );
  return ok;
}

async function scenarioD_repeatedApiCallsSequential() {
  // Repeated API calls, sequential (e.g. a buggy client polling register on
  // an interval). Every call after the first must be a no-op w.r.t. seats.
  const organizerId = await makeOrganizer(pool);
  const [userId] = await makeUsers(pool, 1);
  const eventId = await makeEvent(pool, organizerId, [10]);

  const outcomes = [];
  for (let i = 0; i < 8; i++) {
    const r = await registerForEvent(pool, eventId, userId, randomUUID());
    outcomes.push(r.body.status);
  }
  const { seats_taken, confirmed_rows } = await seatsAndConfirmedCount(eventId);
  const ok = outcomes[0] === "confirmed" && outcomes.slice(1).every((s) => s === "already_registered") && seats_taken === 1 && confirmed_rows === 1;
  console.log(
    `Scenario D (8 sequential repeated calls, same user): outcomes=${JSON.stringify(outcomes)} ` +
      `seats_taken=${seats_taken} confirmed_rows=${confirmed_rows} -> ${ok ? "PASS" : "FAIL"}`,
  );
  return ok;
}

(async () => {
  const results = await Promise.all([
    scenarioA_doubleClickDifferentKeys(),
    scenarioB_retrySameKey(),
    scenarioC_refreshDuringRegistration(),
    scenarioD_repeatedApiCallsSequential(),
  ]);
  const allPass = results.every(Boolean);
  console.log(allPass ? "\nALL_SCENARIOS_PASS" : "\nSOME_SCENARIOS_FAILED");
  await pool.end();
  process.exit(allPass ? 0 : 1);
})().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
