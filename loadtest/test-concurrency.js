// Task 5 requirement: "Verify 1 seat / 100 simultaneous clicks -> exactly
// one succeeds, everyone else gets a proper response, no duplicate
// allocation, no negative seat counts." Run several times to rule out a
// lucky race ordering.
const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const { registerForEvent } = require("./harness");
const { makeOrganizer, makeUsers, makeEvent } = require("./fixtures");

const pool = new Pool({ host: "127.0.0.1", port: 54329, user: "postgres", password: "postgres", database: "postgres", max: 60 });

async function runOnce(runNumber, concurrency) {
  const organizerId = await makeOrganizer(pool);
  const userIds = await makeUsers(pool, concurrency);
  const eventId = await makeEvent(pool, organizerId, [1]); // exactly 1 seat, 1 lane

  const results = await Promise.all(
    userIds.map((userId) => registerForEvent(pool, eventId, userId, randomUUID())),
  );

  const confirmed = results.filter((r) => r.body.status === "confirmed");
  const queued = results.filter((r) => r.body.status === "queued");
  const errored = results.filter((r) => r.body.status === "error");
  const other = results.filter((r) => !["confirmed", "queued", "error"].includes(r.body.status));

  const partitionRes = await pool.query("select seats_taken, capacity from seat_partitions where event_id = $1", [eventId]);
  const { seats_taken, capacity } = partitionRes.rows[0];

  const regRes = await pool.query(
    "select count(*)::int as n from registrations where event_id = $1 and status = 'confirmed'",
    [eventId],
  );
  const confirmedRegistrationRows = regRes.rows[0].n;

  const ok =
    confirmed.length === 1 &&
    seats_taken === 1 &&
    seats_taken <= capacity &&
    seats_taken >= 0 &&
    confirmedRegistrationRows === 1 &&
    queued.length === concurrency - 1 &&
    errored.length === 0;

  console.log(
    `Run ${runNumber}: confirmed=${confirmed.length} queued=${queued.length} error=${errored.length} other=${other.length} ` +
      `seats_taken=${seats_taken}/${capacity} confirmed_rows_in_db=${confirmedRegistrationRows} -> ${ok ? "PASS" : "FAIL"}`,
  );
  if (!ok) {
    console.log("  sample non-queued/confirmed:", JSON.stringify(other.slice(0, 3)));
  }
  return ok;
}

(async () => {
  const CONCURRENCY = 100;
  const RUNS = 5;
  let allPass = true;
  for (let i = 1; i <= RUNS; i++) {
    const ok = await runOnce(i, CONCURRENCY);
    allPass = allPass && ok;
  }
  console.log(allPass ? "\nALL_RUNS_PASS" : "\nSOME_RUNS_FAILED");
  await pool.end();
  process.exit(allPass ? 0 : 1);
})().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
