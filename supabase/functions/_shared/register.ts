// supabase/functions/_shared/register.ts
// Dynamic Crowd Pressure Routing, Parallel Waiting Queue with Strict No-Switching Policy,
// Dynamic (Elastic) Surge Partitions, and 2-minute booking window allotment (max 6-minute extension).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { issueSeatPassport } from "./seatPassport.ts";
import { publishBestEffort } from "./pubsub.ts";

const SEAT_PASSPORT_SECRET = Deno.env.get("SEAT_PASSPORT_SECRET") ?? "39e833befa03f28115244035b10f79ad41c8a17a263a378fc76a225ffdf3adec";
const INITIAL_BOOKING_TTL_SECONDS = 2 * 60; // 2 minutes to complete booking
const MAX_BOOKING_TTL_SECONDS = 6 * 60;     // 6 minutes maximum allowed extension
const SURGE_QUEUE_LEN_THRESHOLD = 20;
const SURGE_LANE_SATURATION_THRESHOLD = 0.25;
const ESTIMATED_SECONDS_PER_BOOKING = 120;  // 2 minutes average booking throughput

export type RegisterResult = { status: number; body: Record<string, unknown> };

// Runs a promise after the response has already been sent when the Supabase
// Edge Runtime supports it, instead of making the caller wait on it. Used
// for lane rebalancing, which should react to a surge but must never add
// its own latency to the registration request that noticed the surge.
function background(promise: Promise<unknown>) {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  const guarded = promise.catch((err) => {
    console.error("[background] task failed:", err instanceof Error ? err.message : err);
  });
  if (runtime?.waitUntil) {
    runtime.waitUntil(guarded);
  }
  // If EdgeRuntime.waitUntil isn't available (e.g. local `supabase functions
  // serve`), the promise still runs — it's just not guaranteed to finish
  // before the isolate is recycled. Either way we never await it here.
}

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

  const { data: queueLens } = await admin.rpc("get_queue_lengths", { p_event_id: eventId });
  const countByLane = new Map<number, number>(
    (queueLens ?? []).map((r: { lane_index: number; waiting_count: number }) => [r.lane_index, r.waiting_count]),
  );

  // Dynamic Least-Loaded Multi-Lane Routing:
  // Load = (waiting in queue + seats_taken). Tie-break among least-loaded lanes via user hash.
  const rankedCandidates = [...lanes]
    .map((l) => {
      const waiting = countByLane.get(l.lane_index) ?? 0;
      const headroom = Math.max(0, l.capacity - l.seats_taken);
      const currentLoad = l.seats_taken + waiting;
      return { ...l, waiting, headroom, currentLoad };
    })
    .filter((l) => l.headroom > 0)
    .sort((a, b) => {
      if (a.currentLoad !== b.currentLoad) return a.currentLoad - b.currentLoad;
      return (b.headroom / b.capacity) - (a.headroom / a.capacity);
    });

  let ranked = rankedCandidates;
  if (rankedCandidates.length > 1) {
    const minLoad = rankedCandidates[0].currentLoad;
    const tied = rankedCandidates.filter((l) => l.currentLoad === minLoad);
    const userHash = userId.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const selectedTied = tied[userHash % tied.length];
    ranked = [selectedTied, ...rankedCandidates.filter((l) => l.lane_index !== selectedTied.lane_index)];
  }

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

  // Dynamic (Elastic) Surge Partitions: while a surge is active, nudge the
  // lane count toward what current demand justifies.
  if (isSurge) {
    background(admin.rpc("rebalance_lanes", { p_event_id: eventId }));
  }

  // Helper to place user in the optimal waiting queue lane
  const enqueueUser = async () => {
    const laneQueueLens = lanes.map((l) => {
      const qCount = countByLane.get(l.lane_index) ?? 0;
      return {
        lane_index: l.lane_index,
        count: qCount,
        estimated_wait_seconds: (qCount + 1) * ESTIMATED_SECONDS_PER_BOOKING,
      };
    });

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

    background(admin.rpc("append_audit_log", {
      p_actor_id: userId,
      p_action: "queue_join",
      p_entity: "event",
      p_entity_id: eventId,
      p_metadata: { lane_index: optimalLane.lane_index, position: optimalLane.count + 1, reason: ranked.length === 0 ? "all lanes full" : "lane filled under race" },
    }));

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

  const chosenIngress = ranked[0];
  await admin.rpc("append_audit_log", {
    p_actor_id: userId,
    p_action: "lane_assignment",
    p_entity: "event",
    p_entity_id: eventId,
    p_metadata: {
      candidate_lane: chosenIngress.lane_index,
      headroom: chosenIngress.headroom,
      waiting: chosenIngress.waiting,
      current_load: chosenIngress.currentLoad,
      ranked_lanes: ranked.map((l) => l.lane_index),
    },
  });

  let registration = null;
  let chosenLane = -1;
  // Attempts that fail for a reason OTHER than the lane genuinely being
  // full (a DB timeout, a dropped connection, a permissions error) used to
  // be silently treated the same as "lane full" and the caller was queued
  // regardless. That masks real outages as ordinary capacity pressure — a
  // queue position is a promise the queue can never keep if the underlying
  // problem is the database itself, not the seat count. Track them
  // separately so a total, non-capacity failure can be reported as what it
  // actually is.
  const nonCapacityErrors: string[] = [];
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
    const isLaneFull = error?.code === "P0001" || (error?.message ?? "").toLowerCase().includes("lane_full");
    if (error && !isLaneFull) {
      nonCapacityErrors.push(error.message ?? String(error));
    }
  }

  if (!registration) {
    // Every ranked lane failed, and none of those failures was "lane
    // full" — the database/RPC layer itself is unhealthy right now.
    // Queueing the user behind a problem that queueing cannot fix would
    // just convert an outage into a silently-growing, never-draining
    // queue. Surface it as a retryable error instead.
    if (nonCapacityErrors.length > 0 && nonCapacityErrors.length === ranked.length) {
      background(admin.rpc("append_audit_log", {
        p_actor_id: userId,
        p_action: "registration_failed",
        p_entity: "event",
        p_entity_id: eventId,
        p_metadata: { reason: "all ranked lanes failed for non-capacity reasons", detail: nonCapacityErrors[0] },
      }));
      return {
        status: 503,
        body: {
          status: "error",
          message: "registration is temporarily unavailable — please retry",
          detail: nonCapacityErrors[0],
        },
      };
    }
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
    const { error: queueError } = await admin.rpc("enqueue_job", {
      p_job_type: "confirmation_email",
      p_payload: { event_id: eventId, user_id: userId, lane_index: chosenLane, registration_id: registration.id },
      p_priority: 8,
      p_max_attempts: 4,
    });
    if (queueError) console.warn("job_queue enqueue failed; notification fallback remains available:", queueError.message);
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
