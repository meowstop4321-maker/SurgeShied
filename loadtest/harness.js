// Faithful port of the ACTUAL orchestration in
// supabase/functions/_shared/register.ts, expressed as direct SQL/RPC calls
// through `pg` instead of going through Deno + PostgREST (neither of which
// is reachable in this environment — see the message sent to the user).
// Every guarantee this test suite measures (no overbooking, no duplicate
// registrations, idempotent retries, FIFO queueing) is enforced by the real
// Postgres functions below (allocate_seat, promote_from_queue, the
// registrations_one_active_per_user unique index) — nothing here
// reimplements or weakens that logic, it just calls it the same way
// register.ts does, in the same order, with the same fallback rules.

const ESTIMATED_SECONDS_PER_BOOKING = 120;

async function registerForEvent(pool, eventId, userId, idempotencyKey) {
  const client = await pool.connect();
  const startedAt = process.hrtime.bigint();
  try {
    const existingKey = await client.query(
      "select response from idempotency_keys where key = $1",
      [idempotencyKey],
    );
    if (existingKey.rows[0]?.response) {
      return { status: 200, body: existingKey.rows[0].response, latencyMs: elapsed(startedAt) };
    }

    const eventRes = await client.query(
      "select id, capacity, lane_count, registration_open from events where id = $1",
      [eventId],
    );
    const event = eventRes.rows[0];
    if (!event) return { status: 404, body: { status: "error", message: "event not found" }, latencyMs: elapsed(startedAt) };
    if (!event.registration_open) return { status: 409, body: { status: "closed" }, latencyMs: elapsed(startedAt) };

    const existingQueueRes = await client.query(
      "select id, lane_index from queue_entries where event_id = $1 and user_id = $2 and status = 'waiting' limit 1",
      [eventId, userId],
    );
    if (existingQueueRes.rows[0]) {
      const row = existingQueueRes.rows[0];
      const posRes = await client.query("select queue_position($1, $2, $3) as pos", [eventId, row.lane_index, userId]);
      const position = posRes.rows[0]?.pos ?? 1;
      return {
        status: 200,
        body: { status: "queued", lane_index: row.lane_index, position, locked_lane: true },
        latencyMs: elapsed(startedAt),
      };
    }

    const lanesRes = await client.query(
      "select lane_index, capacity, seats_taken from seat_partitions where event_id = $1 order by lane_index",
      [eventId],
    );
    const lanes = lanesRes.rows;
    if (!lanes.length) return { status: 500, body: { status: "error", message: "no lanes configured" }, latencyMs: elapsed(startedAt) };

    const ranked = lanes
      .map((l) => ({ ...l, headroom: l.capacity - l.seats_taken }))
      .filter((l) => l.headroom > 0)
      .sort((a, b) => b.headroom / b.capacity - a.headroom / a.capacity);

    const enqueueUser = async () => {
      const qLensRes = await client.query(
        "select lane_index, count(*)::int as waiting_count from queue_entries where event_id = $1 and status = 'waiting' group by lane_index",
        [eventId],
      );
      const countByLane = new Map(qLensRes.rows.map((r) => [r.lane_index, r.waiting_count]));
      const laneQueueLens = lanes.map((l) => ({
        lane_index: l.lane_index,
        count: countByLane.get(l.lane_index) ?? 0,
      }));
      const optimalLane = laneQueueLens.sort((a, b) => a.count - b.count)[0];
      try {
        await client.query(
          "insert into queue_entries (event_id, user_id, lane_index, status) values ($1, $2, $3, 'waiting')",
          [eventId, userId, optimalLane.lane_index],
        );
      } catch (err) {
        if (!String(err.message).includes("duplicate")) {
          return { status: 500, body: { status: "error", message: "join queue failed" }, latencyMs: elapsed(startedAt) };
        }
      }
      const body = {
        status: "queued",
        lane_index: optimalLane.lane_index,
        position: optimalLane.count + 1,
        estimated_wait_seconds: (optimalLane.count + 1) * ESTIMATED_SECONDS_PER_BOOKING,
        locked_lane: true,
      };
      await client.query(
        "insert into idempotency_keys (key, request_hash, response) values ($1, $2, $3) on conflict do nothing",
        [idempotencyKey, eventId, body],
      );
      return { status: 200, body, latencyMs: elapsed(startedAt) };
    };

    if (ranked.length === 0) {
      return await enqueueUser();
    }

    let registration = null;
    let chosenLane = -1;
    const nonCapacityErrors = [];
    for (const lane of ranked) {
      try {
        const allocRes = await client.query(
          "select * from allocate_seat($1, $2, $3, $4, true)",
          [eventId, lane.lane_index, userId, idempotencyKey],
        );
        registration = allocRes.rows[0];
        chosenLane = lane.lane_index;
        break;
      } catch (err) {
        if (err.code === "23505") {
          const body = { status: "already_registered", message: "you already have an active registration for this event" };
          await client.query(
            "insert into idempotency_keys (key, request_hash, response) values ($1, $2, $3) on conflict do nothing",
            [idempotencyKey, eventId, body],
          );
          return { status: 200, body, latencyMs: elapsed(startedAt) };
        }
        const isLaneFull = err.code === "P0001" || String(err.message).toLowerCase().includes("lane_full");
        if (!isLaneFull) nonCapacityErrors.push(err.message);
      }
    }

    if (!registration) {
      if (nonCapacityErrors.length > 0 && nonCapacityErrors.length === ranked.length) {
        return {
          status: 503,
          body: { status: "error", message: "registration is temporarily unavailable — please retry", detail: nonCapacityErrors[0] },
          latencyMs: elapsed(startedAt),
        };
      }
      return await enqueueUser();
    }

    const body = { status: "confirmed", registration, lane_index: chosenLane };
    await client.query(
      "insert into idempotency_keys (key, request_hash, response) values ($1, $2, $3) on conflict do nothing",
      [idempotencyKey, eventId, body],
    );
    return { status: 200, body, latencyMs: elapsed(startedAt) };
  } finally {
    client.release();
  }
}

function elapsed(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

module.exports = { registerForEvent };
