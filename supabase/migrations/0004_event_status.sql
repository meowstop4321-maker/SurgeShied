alter table events add column registration_open boolean not null default true;

-- Global-ish system status, keyed by event, that the frontend subscribes to
-- via Supabase Realtime to render the Lite Mode banner instantly.
create table system_status (
  event_id uuid primary key references events(id) on delete cascade,
  lite_mode boolean not null default false,
  reason text,
  surge_score numeric,
  updated_at timestamptz not null default now()
);
alter table system_status enable row level security;
create policy "system_status: select all" on system_status for select using (auth.role() = 'authenticated');

create or replace function set_system_status(p_event_id uuid, p_lite_mode boolean, p_reason text, p_surge_score numeric)
returns void language sql as $$
  insert into system_status (event_id, lite_mode, reason, surge_score, updated_at)
  values (p_event_id, p_lite_mode, p_reason, p_surge_score, now())
  on conflict (event_id) do update
    set lite_mode = excluded.lite_mode,
        reason = excluded.reason,
        surge_score = excluded.surge_score,
        updated_at = now();
$$;
