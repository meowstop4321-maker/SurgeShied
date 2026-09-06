const { randomUUID } = require("crypto");

// Note: inserting into auth.users fires the real on_auth_user_created
// trigger (0006_worker_infra.sql), which already creates the matching
// profiles row (role='attendee') — mirroring exactly what happens on a real
// Supabase signup. Don't insert into profiles separately, just adjust role.
async function makeOrganizer(pool) {
  const id = randomUUID();
  await pool.query("insert into auth.users (id, email) values ($1, $2)", [id, `organizer-${id}@test.local`]);
  await pool.query("update profiles set role = 'organizer', full_name = 'Test Organizer' where id = $1", [id]);
  return id;
}

async function makeUsers(pool, n) {
  const ids = Array.from({ length: n }, () => randomUUID());
  // Batch insert for speed at n=1000+.
  const values = [];
  const params = [];
  ids.forEach((id, i) => {
    params.push(id, `user-${id}@test.local`);
    values.push(`($${i * 2 + 1}, $${i * 2 + 2})`);
  });
  await pool.query(`insert into auth.users (id, email) values ${values.join(",")}`, params);
  return ids;
}

// lanes: array of capacities, e.g. [1] for a single 1-seat lane, or
// [25,25,25,25] for a 100-seat, 4-lane event.
async function makeEvent(pool, organizerId, lanes) {
  const totalCapacity = lanes.reduce((a, b) => a + b, 0);
  const eventRes = await pool.query(
    `insert into events (organizer_id, title, capacity, lane_count, starts_at, registration_open)
     values ($1, 'Load Test Event', $2, $3, now() + interval '1 day', true) returning id`,
    [organizerId, totalCapacity, lanes.length],
  );
  const eventId = eventRes.rows[0].id;
  for (let i = 0; i < lanes.length; i++) {
    await pool.query(
      "insert into seat_partitions (event_id, lane_index, capacity, seats_taken) values ($1, $2, $3, 0)",
      [eventId, i, lanes[i]],
    );
  }
  await pool.query(
    "insert into system_status (event_id, lite_mode, surge_score) values ($1, false, 0) on conflict do nothing",
    [eventId],
  );
  return eventId;
}

module.exports = { makeOrganizer, makeUsers, makeEvent };
