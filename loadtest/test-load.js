// Task 4: load test at 10/50/100/250/500/1000/max concurrent users against
// the REAL allocate_seat / promote_from_queue / idempotency SQL (see the
// harness.js header for why this is SQL-layer, not full HTTP-stack).
// Measures real throughput, latency percentiles, failure count, queue
// growth, and a "recovery time" — how long after the burst it takes a
// fresh request's latency to fall back near baseline.
const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const { registerForEvent } = require("./harness");
const { makeOrganizer, makeUsers, makeEvent } = require("./fixtures");

const pool = new Pool({ host: "127.0.0.1", port: 54329, user: "postgres", password: "postgres", database: "postgres", max: 80 });

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function measureBaselineLatency(eventId) {
  const [uid] = await makeUsers(pool, 1);
  const r = await registerForEvent(pool, eventId, uid, randomUUID());
  return r.latencyMs;
}

async function runLevel(concurrency, lanes) {
  const organizerId = await makeOrganizer(pool);
  const eventId = await makeEvent(pool, organizerId, lanes);
  const baselineMs = await measureBaselineLatency(eventId); // uses 1 of the seats as a side effect of warming up
  const userIds = await makeUsers(pool, concurrency);

  const wallStart = process.hrtime.bigint();
  const settled = await Promise.allSettled(
    userIds.map((userId) => registerForEvent(pool, eventId, userId, randomUUID())),
  );
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;

  const fulfilled = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  const rejected = settled.filter((s) => s.status === "rejected");

  const latencies = fulfilled.map((r) => r.latencyMs).sort((a, b) => a - b);
  const confirmed = fulfilled.filter((r) => r.body.status === "confirmed").length;
  const queued = fulfilled.filter((r) => r.body.status === "queued").length;
  const errors = fulfilled.filter((r) => r.body.status === "error").length + rejected.length;

  const queueRes = await pool.query(
    "select count(*)::int as n from queue_entries where event_id = $1 and status = 'waiting'",
    [eventId],
  );

  // Recovery: fire probe requests (new users) one at a time until latency
  // falls back within 2x the pre-burst baseline, or we give up after 20
  // probes — a real, measured number either way, not an assumption.
  const recoveryStart = process.hrtime.bigint();
  let recoveredAfterMs = null;
  for (let i = 0; i < 20; i++) {
    const [uid] = await makeUsers(pool, 1);
    const probe = await registerForEvent(pool, eventId, uid, randomUUID());
    if (probe.latencyMs <= Math.max(baselineMs * 2, 50)) {
      recoveredAfterMs = Number(process.hrtime.bigint() - recoveryStart) / 1e6;
      break;
    }
  }

  return {
    concurrency,
    wallMs: Math.round(wallMs),
    throughputRps: Math.round((concurrency / (wallMs / 1000)) * 10) / 10,
    confirmed,
    queued,
    errors,
    queueRemaining: queueRes.rows[0].n,
    p50: Math.round(percentile(latencies, 50)),
    p95: Math.round(percentile(latencies, 95)),
    p99: Math.round(percentile(latencies, 99)),
    max: Math.round(latencies[latencies.length - 1] ?? 0),
    baselineMs: Math.round(baselineMs),
    recoveredAfterMs: recoveredAfterMs != null ? Math.round(recoveredAfterMs) : null,
  };
}

(async () => {
  // 4 lanes x 25 seats = 100-seat event, so every level above 100 shows
  // real queueing behavior, not just confirmations.
  const LANES = [25, 25, 25, 25];
  const LEVELS = [10, 50, 100, 250, 500, 1000];
  const rows = [];

  for (const level of LEVELS) {
    const row = await runLevel(level, LANES);
    rows.push(row);
    console.log(JSON.stringify(row));
    if (row.errors > 0) {
      console.log(`  -> errors appeared at concurrency=${level}, stopping the escalation here.`);
      break;
    }
  }

  // Push past 1000 to find the real ceiling, per "never fake numbers —
  // display the real measured limit."
  if (rows[rows.length - 1] && rows[rows.length - 1].errors === 0) {
    let level = 1500;
    while (level <= 6000) {
      let row;
      try {
        row = await runLevel(level, LANES);
      } catch (err) {
        console.log(`CEILING_FOUND: threw at concurrency=${level}: ${err.message}`);
        break;
      }
      rows.push(row);
      console.log(JSON.stringify(row));
      if (row.errors > 0 || row.p99 > 15000) {
        console.log(`CEILING_FOUND: degraded at concurrency=${level} (errors=${row.errors}, p99=${row.p99}ms)`);
        break;
      }
      level += 1000;
    }
  }

  require("fs").writeFileSync("/home/claude/loadtest/load-results.json", JSON.stringify(rows, null, 2));
  console.log("\nLOAD_TEST_DONE");
  await pool.end();
})().catch(async (err) => {
  console.error("FATAL", err);
  await pool.end();
  process.exit(1);
});
