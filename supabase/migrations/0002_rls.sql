-- Row Level Security. Default posture: deny all, then open narrow reads.
-- Writes to registrations/seat_partitions/notification_jobs/idempotency_keys/
-- audit_logs/queue_entries go ONLY through the service-role Edge Function
-- (Surge Router), never directly from the client. This is what makes the
-- allocate_seat() row-lock guarantee actually hold — a client can't bypass
-- it with a raw insert.

alter table profiles enable row level security;
alter table events enable row level security;
alter table seat_partitions enable row level security;
alter table registrations enable row level security;
alter table idempotency_keys enable row level security;
alter table notification_jobs enable row level security;
alter table audit_logs enable row level security;

create or replace function is_organizer(p_user_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from profiles where id = p_user_id and role = 'organizer');
$$;

-- profiles
create policy "profiles: select own" on profiles for select using (auth.uid() = id);
create policy "profiles: update own" on profiles for update using (auth.uid() = id);
create policy "profiles: insert own" on profiles for insert with check (auth.uid() = id);

-- events: anyone authenticated can read; only the owning organizer writes
create policy "events: select all" on events for select using (auth.role() = 'authenticated');
create policy "events: insert own" on events for insert with check (auth.uid() = organizer_id and is_organizer(auth.uid()));
create policy "events: update own" on events for update using (auth.uid() = organizer_id);
create policy "events: delete own" on events for delete using (auth.uid() = organizer_id);

-- seat_partitions: public read (live seat counter), no client writes at all
create policy "seat_partitions: select all" on seat_partitions for select using (auth.role() = 'authenticated');

-- registrations: users see their own; organizers see registrations for their events. No client insert/update.
create policy "registrations: select own" on registrations for select using (auth.uid() = user_id);
create policy "registrations: select organizer" on registrations for select using (
  exists (select 1 from events e where e.id = registrations.event_id and e.organizer_id = auth.uid())
);

-- idempotency_keys, notification_jobs, audit_logs: service role only (no policies = no client access)

-- audit_logs: organizers can read logs tied to their own events
create policy "audit_logs: select organizer" on audit_logs for select using (
  exists (
    select 1 from events e
    where e.id = audit_logs.entity_id and e.organizer_id = auth.uid() and audit_logs.entity = 'event'
  )
);
