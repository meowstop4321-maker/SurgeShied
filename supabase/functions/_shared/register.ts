// supabase/functions/_shared/register.ts
// Dynamic Crowd Pressure Routing, Parallel Waiting Queue with Strict No-Switching Policy,
// and 2-minute booking window allotment (max 6-minute extension).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { issueSeatPassport } from "./seatPassport.ts";
import { publishBestEffort } from "./pubsub.ts";

const SEAT_PASSPORT_SECRET = Deno.env.get("SEAT_PASSPORT_SECRET") ?? "39e833befa03f28115244035b10f79ad41c8a17a263a378fc76a225ffdf3adec";
const INITIAL_BOOKING_TTL_SECONDS = 2 * 60; // 2 minutes to complete booking
const MAX_BOOKING_TTL_SECONDS = 6 * 60;     // 6 minutes maximum allowed extension
const SURGE_QUEUE_LEN_THRESHOLD = 20;
const SURGE_LANE_SATURATION_THRESHOLD = 0.9;
const ESTIMATED_SECONDS_PER_BOOKING = 120;  // 2 minutes average booking throughput

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

  // Check if user is ALREADY waiting in a queue lane (Strict No-Switching Policy)
  const { data: existingQueueEntry } = await admin
    .from("queue_entries")
    .select("id, lane_index, created_at, status")
    .eq("event_id", eventId)
    .eq("user_id", userId)
    .eq("status", "waiting")
    .maybeSingle();

  if (existingQueueEntry) {
    const { data: pos } = await admin.rpc("queue_position", {
      p_event_id: eventId,
      p_lane_index: existingQueueEntry.lane_index,
      p_user_id: userId,
    });
    const position = pos ?? 1;
    const response = {
      status: "queued",
      lane_index: existingQueueEntry.lane_index,
      position,
      estimated_wait_seconds: position * ESTIMATED_SECONDS_PER_BOOKING,
      locked_lane: true,
      message: "You are already assigned to Lane " + existingQueueEntry.lane_index + ". Lane switching is prohibited for fair queue allotment.",
    };
    return { status: 200, body: response };
  }

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

  // Helper to place user in the optimal waiting queue lane
  const enqueueUser = async () => {
    const laneQueueLens = await Promise.all(
      lanes.map(async (l) => {
        const { count } = await admin
          .from("queue_entries")
          .select("id", { count: "exact", head: true })
          .eq("event_id", eventId)
          .eq("lane_index", l.lane_index)
          .eq("status", "waiting");
        const qCount = count ?? 0;
        return {
          lane_index: l.lane_index,
          count: qCount,
          estimated_wait_seconds: (qCount + 1) * ESTIMATED_SECONDS_PER_BOOKING,
        };
      }),
    );

    const optimalLane = laneQueueLens.sort((a, b) => a.count - b.count)[0];
    const { error: qErr } = await admin.from("queue_entries").insert({
      event_id: eventId,
      user_id: userId,
      lane_index: optimalLane.lane_index,
      status: "waiting",
    });
    if (qErr && !qErr.message?.includes("duplicate")) {
      return { status: 500, body: { status: "error", message: "join queue failed" } };
    }

    const response = {
      status: "queued",
      lane_index: optimalLane.lane_index,
      position: optimalLane.count + 1,
      estimated_wait_seconds: optimalLane.estimated_wait_seconds,
      locked_lane: true,
      booking_window_seconds: INITIAL_BOOKING_TTL_SECONDS,
      max_window_seconds: MAX_BOOKING_TTL_SECONDS,
    };
    await admin.from("idempotency_keys").insert({ key: idempotencyKey, request_hash: eventId, response });
    return { status: 200, body: response };
  };

  // If all lanes are saturated -> Dynamic Queue Routing based on shortest estimated wait time
  if (ranked.length === 0) {
    return await enqueueUser();
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
      p_confirmed: true,
    });
    if (!error && data) {
      registration = data;
      chosenLane = lane.lane_index;
      break;
    }
    if (error?.code === "23505") {
      const response = { status: "already_registered", message: "you already have an active registration for this event" };
      await admin.from("idempotency_keys").insert({ key: idempotencyKey, request_hash: eventId, response });
      return { status: 200, body: response };
    }
  }

  if (!registration) {
    // All candidate lanes filled under race conditions -> automatically join queue without 409 error
    return await enqueueUser();
  }

  // Issue 2-minute booking window Seat Passport (Max 6 minutes window cap)
  const exp = Math.floor(Date.now() / 1000) + INITIAL_BOOKING_TTL_SECONDS;
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

  const response = {
    status: "confirmed",
    registration,
    seat_passport: seatPassport,
    lane_index: chosenLane,
    surge: isSurge,
    booking_expires_at: new Date(exp * 1000).toISOString(),
    booking_window_seconds: INITIAL_BOOKING_TTL_SECONDS,
    max_window_seconds: MAX_BOOKING_TTL_SECONDS,
  };
  await admin.from("idempotency_keys").insert({ key: idempotencyKey, request_hash: eventId, response });
  return { status: 200, body: response };
}
