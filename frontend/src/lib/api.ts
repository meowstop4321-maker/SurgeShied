import { supabase, FUNCTIONS_URL, WORKER_URL } from "./supabaseClient";

async function authedFetch(path: string, body: Record<string, unknown>, allowFallback = true) {
  try {
    const { data, error } = await supabase.functions.invoke(path, {
      body,
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
      },
    });

    if (error) {
      const context = (error as { context?: Response }).context;
      if (context && typeof context.json === "function") {
        try {
          return await context.json();
        } catch {
          // Response body wasn't JSON — treat as unreachable, fall through.
        }
      }
      if (allowFallback) return null;
      const response = (error as { context?: Response }).context;
      let message = error.message || "Request failed";
      let code = "";
      if (response) {
        const details = await response.json().catch(() => null) as { message?: string; code?: string } | null;
        message = details?.message || message;
        code = details?.code || "";
      }
      const registrationError = new Error(message) as Error & { code?: string; status?: number };
      registrationError.code = code;
      registrationError.status = response?.status;
      throw registrationError;
    }
    return data;
  } catch (err) {
    if (!allowFallback) throw err;
    return null;
  }
}

async function requireOrganizer() {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Organizer access required");

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (error || (profile?.role !== "organizer" && profile?.role !== "admin")) {
    throw new Error("Organizer access required");
  }
}

// Robust fallback registration when edge function is not deployed at all.
// Only reached when authedFetch() above could not get ANY response from
// surge-router — never as a silent substitute for a real error response.
async function fallbackRegister(eventId: string) {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error("Please sign in to register");
  const userId = userData.user.id;

  const { data: event } = await supabase
    .from("events")
    .select("registration_open")
    .eq("id", eventId)
    .maybeSingle();
  if (event && event.registration_open === false) {
    return { status: "closed", message: "registration is closed" };
  }

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

  // 1b. Already waiting in this event's queue? Don't hand out a second,
  // possibly different, lane — mirrors register.ts's Strict No-Switching
  // Policy so the two paths can't disagree about which lane someone is in.
  const { data: existingQueueEntry } = await supabase
    .from("queue_entries")
    .select("lane_index")
    .eq("event_id", eventId)
    .eq("user_id", userId)
    .eq("status", "waiting")
    .maybeSingle();
  if (existingQueueEntry) {
    return { status: "queued", lane_index: existingQueueEntry.lane_index, locked_lane: true };
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

  // If all lanes full -> join queue behind whichever lane currently has the
  // shortest wait, same tie-break register.ts uses server-side.
  if (ranked.length === 0) {
    const { data: waitingRows } = await supabase
      .from("queue_entries")
      .select("lane_index")
      .eq("event_id", eventId)
      .eq("status", "waiting");
    const countByLane = new Map<number, number>();
    (waitingRows ?? []).forEach((r) => countByLane.set(r.lane_index, (countByLane.get(r.lane_index) ?? 0) + 1));
    const shortest = [...lanes]
      .map((l) => ({ lane_index: l.lane_index, count: countByLane.get(l.lane_index) ?? 0 }))
      .sort((a, b) => a.count - b.count)[0];

    const { error: qErr } = await supabase.from("queue_entries").insert({
      event_id: eventId,
      user_id: userId,
      lane_index: shortest.lane_index,
      status: "waiting",
    });
    if (qErr && !qErr.message.includes("duplicate")) throw qErr;
    return { status: "queued", lane_index: shortest.lane_index, position: shortest.count + 1 };
  }

  // Try allocate seat in healthiest lane via locked RPC
  const chosenLane = ranked[0].lane_index;
  const { data: reg, error: allocErr } = await supabase.rpc("allocate_seat", {
    p_event_id: eventId,
    p_lane_index: chosenLane,
    p_user_id: userId,
    p_idempotency_key: crypto.randomUUID(),
    p_confirmed: true,
  });

  if (allocErr) {
    if (allocErr.code === "23505" || allocErr.message?.includes("already_registered")) {
      return { status: "already_registered", message: "You already have an active registration" };
    }
    if (allocErr.message?.includes("lane_full")) {
      const { error: qErr } = await supabase.from("queue_entries").insert({
        event_id: eventId,
        user_id: userId,
        lane_index: chosenLane,
        status: "waiting",
      });
      if (qErr && !qErr.message.includes("duplicate")) throw qErr;
      return { status: "queued", lane_index: chosenLane, position: 1 };
    }
    throw allocErr;
  }

  return {
    status: "confirmed",
    registration: reg,
    seat_passport: reg.seat_passport_token || `PASSPORT-${reg.id.slice(0, 8)}`,
    lane_index: chosenLane,
  };
}

export async function registerForEvent(eventId: string, turnstileToken?: string) {
  const result = await authedFetch("surge-router", {
    event_id: eventId,
    turnstile_token: turnstileToken || "",
  }, false);
  if (!result) throw new Error("Network failure while contacting Surge Router.");
  return result;
}

// Client simulation fallback
async function fallbackSimulate(action: string, eventId?: string, count: number = 100, durationSeconds: number = 60) {
  if (!eventId && action !== "recover_system" && action !== "trigger_email_failure") {
    const { data: evs } = await supabase.from("events").select("id").limit(1);
    if (evs && evs.length > 0) eventId = evs[0].id;
  }

  switch (action) {
    case "load_rate": {
      if (!eventId) throw new Error("No event available for simulation");
      const totalWaves = Math.max(1, Math.round((durationSeconds * 1000) / 2000));
      const perWave = Math.max(1, Math.ceil(count / totalWaves));
      let sent = 0;

      // Fetch starting capacity to track running total
      const { data: initialParts } = await supabase
        .from("seat_partitions")
        .select("lane_index, capacity, seats_taken")
        .eq("event_id", eventId)
        .order("lane_index");
      let runningTotal = (initialParts ?? []).reduce((acc, p) => acc + (p.seats_taken || 0), 0);

      const runWave = async () => {
        const thisWave = Math.min(perWave, count - sent);
        if (thisWave <= 0) return;

        // 1. Allocate real seats in database (simulate_surge_load handles partition updates and audit logs)
        const { data: res } = await supabase.rpc("simulate_surge_load", { p_event_id: eventId, p_count: thisWave });
        sent += thisWave;

        // 2. Populate telemetry request_metrics with real outcome split
        const confirmedRatio = thisWave > 0 ? ((res as any)?.confirmed ?? thisWave) / thisWave : 1;
        for (let i = 0; i < thisWave; i++) {
          const fakeUser = crypto.randomUUID();
          const latency = Math.floor(Math.random() * 35) + 12;
          const outcome = i < Math.round(thisWave * confirmedRatio) ? "confirmed" : "queued";

          supabase.rpc("log_request_metric", {
            p_event_id: eventId,
            p_user_id: fakeUser,
            p_outcome: outcome,
            p_status_code: outcome === "confirmed" ? 200 : 202,
            p_latency_ms: latency,
          });
        }

        if (sent < count) {
          setTimeout(runWave, 2000);
        }
      };

      runWave();
      return {
        status: "ok",
        action,
        started: true,
        target_count: count,
        duration_seconds: durationSeconds,
        message: `Ramping ${count} registrations (${Math.round(count / (durationSeconds / 60))} req/min) across partition lanes — watch seats and metrics climb in real-time.`,
      };
    }

    case "load":
    case "trigger_surge": {
      if (!eventId) throw new Error("No event available for simulation");
      const targetCount = action === "trigger_surge" ? 300 : count;
      const { data: res, error } = await supabase.rpc("simulate_surge_load", {
        p_event_id: eventId,
        p_count: targetCount,
      });
      if (error) throw error;

      // Populate telemetry request_metrics with real outcome split
      const batchSize = Math.min(targetCount, 250);
      const confirmedRatio = targetCount > 0 ? ((res as any)?.confirmed ?? targetCount) / targetCount : 1;
      for (let i = 0; i < batchSize; i++) {
        const fakeUser = crypto.randomUUID();
        const latency = Math.floor(Math.random() * 45) + 12;
        const outcome = i < Math.round(batchSize * confirmedRatio) ? "confirmed" : "queued";
        supabase.rpc("log_request_metric", {
          p_event_id: eventId,
          p_user_id: fakeUser,
          p_outcome: outcome,
          p_status_code: outcome === "confirmed" ? 200 : 202,
          p_latency_ms: latency,
        });
      }

      return {
        status: "ok",
        action,
        attempted: (res as any)?.attempted ?? targetCount,
        confirmed: (res as any)?.confirmed ?? targetCount,
        queued: (res as any)?.queued ?? 0,
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
        await supabase.rpc("reset_event_partitions", { p_event_id: eventId });
      }
      return { status: "ok", action, message: "System recovered: partition seats reset to 0 and circuit closed." };
    }

    default:
      return { status: "ok", action };
  }
}

export async function simulate(action: string, eventId?: string, count?: number, durationSeconds?: number) {
  await requireOrganizer();
  const result = await authedFetch("simulate", { action, event_id: eventId, count, duration_seconds: durationSeconds });
  if (result) return result;
  return fallbackSimulate(action, eventId, count, durationSeconds);
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

export type OpsMetrics = {
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
  // Live Operations Dashboard fields (migrations/0011_observability.sql).
  active_users: number;
  successful_registrations: number;
  failed_registrations: number;
  queue_processing_rate_per_min: number;
  pending_jobs: number;
  retry_count: number;
  avg_response_time_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  seats_remaining: number;
  cpu_percent: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  active_instances: number | null;
  min_instances: number | null;
  max_instances: number | null;
  autoscaling_status: "scaling_up" | "scaling_down" | "stable";
  autoscaling_note: string;
};

const OPS_METRICS_FALLBACK: OpsMetrics = {
  requests_per_sec: 0,
  queue_length: 0,
  active_lanes: 4,
  total_lanes: 4,
  surge_score: 0.1,
  lite_mode: false,
  notification_queued: 0,
  notification_retries: 0,
  dead_letter_count: 0,
  circuit_state: "closed",
  worker_status: "healthy",
  active_worker_count: 1,
  active_users: 0,
  successful_registrations: 0,
  failed_registrations: 0,
  queue_processing_rate_per_min: 0,
  pending_jobs: 0,
  retry_count: 0,
  avg_response_time_ms: 0,
  p95_latency_ms: 0,
  p99_latency_ms: 0,
  seats_remaining: 0,
  cpu_percent: null,
  memory_used_mb: null,
  memory_total_mb: null,
  active_instances: null,
  min_instances: null,
  max_instances: null,
  autoscaling_status: "stable",
  autoscaling_note: "Waiting for first worker heartbeat…",
};

export async function getOpsMetrics(eventId: string, organizerOnly = false): Promise<OpsMetrics> {
  if (organizerOnly) await requireOrganizer();
  try {
    const { data, error } = await supabase.rpc("get_ops_metrics", { p_event_id: eventId });
    if (error) throw error;
    return { ...OPS_METRICS_FALLBACK, ...(data as Partial<OpsMetrics>) };
  } catch {
    // Graceful default if RPC is initializing (e.g. migration not applied yet).
    return OPS_METRICS_FALLBACK;
  }
}

export type ActiveAlert = {
  severity: "critical" | "warning";
  code: string;
  message: string;
};

export async function getActiveAlerts(eventId: string): Promise<ActiveAlert[]> {
  await requireOrganizer();
  try {
    const { data, error } = await supabase.rpc("get_active_alerts", { p_event_id: eventId });
    if (error) throw error;
    return (data as ActiveAlert[]) ?? [];
  } catch (err) {
    console.warn("getActiveAlerts error:", err);
    return [];
  }
}

export type DeadLetterJob = {
  id: string;
  job_type: string;
  payload: Record<string, unknown>;
  priority: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export async function getDeadLetterJobs(limit = 50): Promise<DeadLetterJob[]> {
  await requireOrganizer();
  try {
    const { data, error } = await supabase.rpc("get_dead_letter_jobs", { p_limit: limit });
    if (error) throw error;
    return (data as DeadLetterJob[]) ?? [];
  } catch (err) {
    console.warn("getDeadLetterJobs error:", err);
    return [];
  }
}

export async function reprocessDeadLetterJob(jobId: string) {
  await requireOrganizer();
  const { data, error } = await supabase.rpc("reprocess_dead_letter_job", { p_job_id: jobId });
  if (error) throw error;
  return data;
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
  await requireOrganizer();
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
