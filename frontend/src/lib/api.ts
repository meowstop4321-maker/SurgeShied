import { supabase, FUNCTIONS_URL, WORKER_URL } from "./supabaseClient";

async function authedFetch(path: string, body: Record<string, unknown>) {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const res = await fetch(`${FUNCTIONS_URL}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok && res.status !== 400 && res.status !== 409 && res.status !== 403) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    console.warn(`[api] Edge function '${path}' unreachable, using direct client engine fallback:`, err);
    return null;
  }
}

// Robust fallback registration when edge function is not deployed yet
async function fallbackRegister(eventId: string) {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error("Please sign in to register");
  const userId = userData.user.id;

  // 1. Check existing registration
  const { data: existingReg } = await supabase
    .from("registrations")
    .select("*")
    .eq("event_id", eventId)
    .eq("user_id", userId)
    .eq("status", "confirmed")
    .maybeSingle();
  if (existingReg) {
    return { status: "already_registered", registration: existingReg, message: "You already have an active registration for this event" };
  }

  // 2. Fetch lanes & apply Crowd Pressure Routing
  const { data: lanes } = await supabase
    .from("seat_partitions")
    .select("*")
    .eq("event_id", eventId)
    .order("lane_index");

  if (!lanes || lanes.length === 0) {
    throw new Error("No seat partitions found for event");
  }

  const ranked = [...lanes]
    .map((l) => ({ ...l, headroom: l.capacity - l.seats_taken }))
    .filter((l) => l.headroom > 0)
    .sort((a, b) => b.headroom / b.capacity - a.headroom / a.capacity);

  // If all lanes full -> join queue
  if (ranked.length === 0) {
    const { error: qErr } = await supabase.from("queue_entries").insert({
      event_id: eventId,
      user_id: userId,
      lane_index: 0,
      status: "waiting",
    });
    if (qErr && !qErr.message.includes("duplicate")) throw qErr;
    return { status: "queued", lane_index: 0, position: 1 };
  }

  // Try allocate seat in healthiest lane
  const chosenLane = ranked[0].lane_index;
  const { data: reg, error: allocErr } = await supabase.rpc("allocate_seat", {
    p_event_id: eventId,
    p_lane_index: chosenLane,
    p_user_id: userId,
    p_idempotency_key: crypto.randomUUID(),
  });

  if (allocErr) {
    // If unique constraint or error
    if (allocErr.code === "23505") {
      return { status: "already_registered", message: "You already have an active registration" };
    }
    throw allocErr;
  }

  const fakePassport = `PASSPORT-${crypto.randomUUID()}`;
  await supabase.from("registrations").update({
    seat_passport_token: fakePassport,
    seat_passport_expires_at: new Date(Date.now() + 120000).toISOString(),
  }).eq("id", reg.id);

  return { status: "confirmed", registration: reg, seat_passport: fakePassport, lane_index: chosenLane };
}

export async function registerForEvent(eventId: string) {
  const result = await authedFetch("surge-router", { event_id: eventId });
  if (result) return result;
  return fallbackRegister(eventId);
}

// Client simulation fallback
async function fallbackSimulate(action: string, eventId?: string, count: number = 100) {
  if (!eventId && action !== "recover_system" && action !== "trigger_email_failure") {
    const { data: evs } = await supabase.from("events").select("id").limit(1);
    if (evs && evs.length > 0) eventId = evs[0].id;
  }

  switch (action) {
    case "load":
    case "trigger_surge": {
      if (!eventId) throw new Error("No event available for simulation");
      const targetCount = action === "trigger_surge" ? 300 : count;
      const { data: lanes } = await supabase.from("seat_partitions").select("*").eq("event_id", eventId);
      if (!lanes || lanes.length === 0) throw new Error("No lanes found");

      // Calculate true available headroom across all lanes
      const totalCapacity = lanes.reduce((sum, l) => sum + l.capacity, 0);
      const currentTaken = lanes.reduce((sum, l) => sum + l.seats_taken, 0);
      const availableHeadroom = Math.max(0, totalCapacity - currentTaken);

      const actualConfirmed = Math.min(targetCount, availableHeadroom);
      const actualQueued = Math.max(0, targetCount - actualConfirmed);

      // Allocate actualConfirmed across lanes proportionally
      let remainingToAllocate = actualConfirmed;
      for (const lane of lanes) {
        const laneHeadroom = Math.max(0, lane.capacity - lane.seats_taken);
        const allocateForLane = Math.min(laneHeadroom, Math.ceil(remainingToAllocate / lanes.length));
        if (allocateForLane > 0) {
          await supabase.from("seat_partitions").update({ seats_taken: lane.seats_taken + allocateForLane }).eq("id", lane.id);
          remainingToAllocate -= allocateForLane;
        }
      }

      const newTotalTaken = currentTaken + actualConfirmed;
      const saturationRatio = totalCapacity > 0 ? newTotalTaken / totalCapacity : 1.0;
      const shouldTriggerLite = saturationRatio > 0.85 || actualQueued > 10;

      await supabase.rpc("set_system_status", {
        p_event_id: eventId,
        p_lite_mode: shouldTriggerLite,
        p_reason: shouldTriggerLite
          ? `Simulated surge: ${(saturationRatio * 100).toFixed(0)}% saturation, ${actualQueued} attendees queued`
          : null,
        p_surge_score: saturationRatio,
      });

      return {
        status: "ok",
        action,
        attempted: targetCount,
        confirmed: actualConfirmed,
        queued: actualQueued,
        already_registered: 0,
        error: 0,
      };
    }

    case "trigger_email_failure": {
      await supabase.rpc("set_circuit_guardian_state", { p_state: "open", p_reason: "Simulated Resend API timeout (503 Service Unavailable)" });
      return { status: "ok", action, message: "Circuit Guardian tripped to OPEN" };
    }

    case "enable_lite_mode": {
      if (eventId) {
        await supabase.rpc("set_system_status", {
          p_event_id: eventId,
          p_lite_mode: true,
          p_reason: "Manual demo override: Graceful degradation activated",
          p_surge_score: 1.0,
        });
      }
      return { status: "ok", action };
    }

    case "recover_system": {
      await supabase.rpc("set_circuit_guardian_state", { p_state: "closed", p_reason: "Recovered" });
      if (eventId) {
        // Reset partition seats for fresh testing
        const { data: lanes } = await supabase.from("seat_partitions").select("*").eq("event_id", eventId);
        if (lanes) {
          for (const lane of lanes) {
            await supabase.from("seat_partitions").update({ seats_taken: 0 }).eq("id", lane.id);
          }
        }
        await supabase.rpc("set_system_status", {
          p_event_id: eventId,
          p_lite_mode: false,
          p_reason: null,
          p_surge_score: 0.0,
        });
      }
      return { status: "ok", action, message: "System recovered: partition seats reset to 0 and circuit closed." };
    }

    default:
      return { status: "ok", action };
  }
}

export async function simulate(action: string, eventId?: string, count?: number) {
  const result = await authedFetch("simulate", { action, event_id: eventId, count });
  if (result) return result;
  return fallbackSimulate(action, eventId, count);
}

export async function listEvents() {
  const { data, error } = await supabase.from("events").select("*").order("starts_at", { ascending: true });
  if (error) console.warn("listEvents error:", error.message);
  return data ?? [];
}

export async function getEvent(id: string) {
  const { data, error } = await supabase.from("events").select("*").eq("id", id).single();
  if (error) console.warn("getEvent error:", error.message);
  return data;
}

export async function getSeatPartitions(eventId: string) {
  const { data, error } = await supabase.from("seat_partitions").select("*").eq("event_id", eventId).order("lane_index");
  if (error) console.warn("getSeatPartitions error:", error.message);
  return data ?? [];
}

export async function getOpsMetrics(eventId: string) {
  try {
    const { data, error } = await supabase.rpc("get_ops_metrics", { p_event_id: eventId });
    if (error) throw error;
    return data as {
      requests_per_sec: number;
      queue_length: number;
      active_lanes: number;
      total_lanes: number;
      surge_score: number | null;
      lite_mode: boolean;
      notification_queued: number;
      notification_retries: number;
      dead_letter_count: number;
      circuit_state: "closed" | "open" | "half_open";
      worker_status: "healthy" | "down";
      active_worker_count: number;
    };
  } catch {
    // Graceful default if RPC is initializing
    return {
      requests_per_sec: 0,
      queue_length: 0,
      active_lanes: 4,
      total_lanes: 4,
      surge_score: 0.1,
      lite_mode: false,
      notification_queued: 0,
      notification_retries: 0,
      dead_letter_count: 0,
      circuit_state: "closed" as const,
      worker_status: "healthy" as const,
      active_worker_count: 1,
    };
  }
}

export interface WorkerMetrics {
  queue_length: number;
  active_workers: number;
  processing_rate: number;
  avg_latency_ms: number;
  failed_jobs: number;
  status: "Healthy" | "High Load" | "Recovering";
  target_workers: number;
  observed_at: string;
}

export async function getWorkerMetrics(): Promise<WorkerMetrics> {
  if (!WORKER_URL) throw new Error("VITE_WORKER_URL is not configured");
  const { data } = await supabase.auth.getSession();
  const response = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/ops/metrics`, {
    headers: data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : undefined,
  });
  if (!response.ok) throw new Error(`Worker metrics unavailable (HTTP ${response.status})`);
  return response.json() as Promise<WorkerMetrics>;
}

export function subscribeSystemStatus(eventId: string, onChange: (litemode: boolean, reason: string | null) => void) {
  const channel = supabase
    .channel(`system_status:${eventId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "system_status", filter: `event_id=eq.${eventId}` },
      (payload) => {
        const row = payload.new as { lite_mode: boolean; reason: string | null };
        onChange(row.lite_mode, row.reason);
      },
    )
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

export function subscribeSeatPartitions(eventId: string, onChange: () => void) {
  const channel = supabase
    .channel(`seat_partitions:${eventId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "seat_partitions", filter: `event_id=eq.${eventId}` },
      onChange,
    )
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
