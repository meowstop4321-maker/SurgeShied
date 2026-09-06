// supabase/functions/_shared/register.ts
// The actual Surge Router brain: CPR ranking, ASP allocation, Seat Passport,
// surge scoring, notification job insert, audit chain calls. Callable with
// any (eventId, userId) pair — the caller is responsible for deciding who
// userId is (a real authenticated user, or a synthetic demo user for the
// Simulation Panel).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { issueSeatPassport } from "./seatPassport.ts";
import { publishBestEffort } from "./pubsub.ts";

const SEAT_PASSPORT_SECRET = Deno.env.get("SEAT_PASSPORT_SECRET")!;
const PASSPORT_TTL_SECONDS = 10 * 60;
const SURGE_QUEUE_LEN_THRESHOLD = 20;
const SURGE_LANE_SATURATION_THRESHOLD = 0.9;

export type RegisterResult = { status: number; body: Record<string, unknown> };

export async function registerForEvent(
  admin: SupabaseClient,
  eventId: string,
  userId: string,
  idempotencyKey: string,
): Promise<RegisterResult> {
  const { data: existingKey } = await admin
    .from("idempotency_keys")
    .select("response")
    .eq("key", idempotencyKey)
    .maybeSingle();
  if (existingKey?.response) return { status: 200, body: existingKey.response };

  const { data: event, error: eventError } = await admin
    .from("events")
    .select("id, capacity, lane_count, registration_open")
    .eq("id", eventId)
    .single();
  if (eventError || !event) return { status: 404, body: { status: "error", message: "event not found" } };
  if (!event.registration_open) return { status: 409, body: { status: "closed", message: "registration is closed" } };

  await admin.rpc("append_audit_log", {
    p_actor_id: userId,
    p_action: "registration_attempt",
    p_entity: "event",
    p_entity_id: eventId,
    p_metadata: { idempotency_key: idempotencyKey },
  });

  const { data: lanes, error: lanesError } = await admin
    .from("seat_partitions")
    .select("lane_index, capacity, seats_taken")
    .eq("event_id", eventId)
    .order("lane_index", { ascending: true });
  if (lanesError || !lanes?.length) return { status: 500, body: { status: "error", message: "no lanes configured" } };

  const ranked = [...lanes]
    .map((l) => ({ ...l, headroom: l.capacity - l.seats_taken }))
    .filter((l) => l.headroom > 0)
    .sort((a, b) => b.headroom / b.capacity - a.headroom / a.capacity);

  const avgSaturation = lanes.reduce((s, l) => s + l.seats_taken / l.capacity, 0) / lanes.length;
  const { count: queueLen } = await admin
    .from("queue_entries")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId)
    .eq("status", "waiting");
  const isSurge = avgSaturation >= SURGE_LANE_SATURATION_THRESHOLD || (queueLen ?? 0) >= SURGE_QUEUE_LEN_THRESHOLD;
  await admin.rpc("set_system_status", {
    p_event_id: eventId,
    p_lite_mode: isSurge,
    p_reason: isSurge ? `avg lane saturation ${(avgSaturation * 100).toFixed(0)}%, queue ${queueLen ?? 0}` : null,
    p_surge_score: avgSaturation,
  });

  if (ranked.length === 0) {
    const laneQueueLens = await Promise.all(
      lanes.map(async (l) => {
        const { count } = await admin
          .from("queue_entries")
          .select("id", { count: "exact", head: true })
          .eq("event_id", eventId)
          .eq("lane_index", l.lane_index)
          .eq("status", "waiting");
        return { lane_index: l.lane_index, count: count ?? 0 };
      }),
    );
    const shortest = laneQueueLens.sort((a, b) => a.count - b.count)[0];
    const { error: qErr } = await admin.from("queue_entries").insert({
      event_id: eventId,
      user_id: userId,
      lane_index: shortest.lane_index,
      status: "waiting",
    });
    if (qErr) return { status: 500, body: { status: "error", message: "join queue failed" } };
    const response = { status: "queued", lane_index: shortest.lane_index, position: shortest.count + 1 };
    await admin.from("idempotency_keys").insert({ key: idempotencyKey, request_hash: eventId, response });
    return { status: 200, body: response };
  }

  await admin.rpc("append_audit_log", {
    p_actor_id: userId,
    p_action: "lane_assignment",
    p_entity: "event",
    p_entity_id: eventId,
    p_metadata: { candidate_lane: ranked[0].lane_index, headroom: ranked[0].headroom, ranked_lanes: ranked.map((l) => l.lane_index) },
  });

  let registration = null;
  let chosenLane = -1;
  for (const lane of ranked) {
    const { data, error } = await admin.rpc("allocate_seat", {
      p_event_id: eventId,
      p_lane_index: lane.lane_index,
      p_user_id: userId,
      p_idempotency_key: idempotencyKey,
    });
    if (!error && data) {
      registration = data;
      chosenLane = lane.lane_index;
      break;
    }
    // 23505 = unique_violation on registrations_one_active_per_user — this
    // user already has a live registration for this event. Trying another
    // lane won't help; stop immediately instead of burning every lane.
    if (error?.code === "23505") {
      const response = { status: "already_registered", message: "you already have an active registration for this event" };
      await admin.from("idempotency_keys").insert({ key: idempotencyKey, request_hash: eventId, response });
      return { status: 200, body: response };
    }
    // any other error is expected when a concurrent request just filled this lane; try the next one.
  }

  if (!registration) {
    return { status: 409, body: { status: "error", message: "all lanes filled during allocation, please retry" } };
  }

  const exp = Math.floor(Date.now() / 1000) + PASSPORT_TTL_SECONDS;
  const seatPassport = await issueSeatPassport(
    { eventId, userId, registrationId: registration.id, laneIndex: chosenLane, exp, nonce: crypto.randomUUID() },
    SEAT_PASSPORT_SECRET,
  );
  await admin
    .from("registrations")
    .update({ seat_passport_token: seatPassport, seat_passport_expires_at: new Date(exp * 1000).toISOString() })
    .eq("id", registration.id);

  const { data: job } = await admin
    .from("notification_jobs")
    .insert({
      registration_id: registration.id,
      job_type: "confirmation_email",
      status: "queued",
      payload: { event_id: eventId, user_id: userId, lane_index: chosenLane },
    })
    .select()
    .single();
  if (job) {
    await publishBestEffort("notification-jobs", { job_id: job.id, registration_id: registration.id });
  }

  const response = { status: "confirmed", registration, seat_passport: seatPassport, lane_index: chosenLane, surge: isSurge };
  await admin.from("idempotency_keys").insert({ key: idempotencyKey, request_hash: eventId, response });
  return { status: 200, body: response };
}
