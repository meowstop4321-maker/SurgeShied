import { supabase, FUNCTIONS_URL } from "./supabaseClient";

async function authedFetch(path: string, body: Record<string, unknown>) {
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
  return res.json();
}

export function registerForEvent(eventId: string) {
  return authedFetch("surge-router", { event_id: eventId });
}

export function simulate(action: string, eventId?: string, count?: number) {
  return authedFetch("simulate", { action, event_id: eventId, count });
}

export async function listEvents() {
  const { data } = await supabase.from("events").select("*").order("starts_at", { ascending: true });
  return data ?? [];
}

export async function getEvent(id: string) {
  const { data } = await supabase.from("events").select("*").eq("id", id).single();
  return data;
}

export async function getSeatPartitions(eventId: string) {
  const { data } = await supabase.from("seat_partitions").select("*").eq("event_id", eventId).order("lane_index");
  return data ?? [];
}

export async function getOpsMetrics(eventId: string) {
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
