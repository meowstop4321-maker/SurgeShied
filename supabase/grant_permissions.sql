-- Grant full permissions on public schema to Supabase roles & reload schema cache

GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO postgres, anon, authenticated, service_role;

-- Ensure RLS is permissive for frontend app flows
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "events_all" ON public.events;
CREATE POLICY "events_all" ON public.events FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.seat_partitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "partitions_all" ON public.seat_partitions;
CREATE POLICY "partitions_all" ON public.seat_partitions FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "profiles_all" ON public.profiles;
CREATE POLICY "profiles_all" ON public.profiles FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.registrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "registrations_all" ON public.registrations;
CREATE POLICY "registrations_all" ON public.registrations FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.queue_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "queue_all" ON public.queue_entries;
CREATE POLICY "queue_all" ON public.queue_entries FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.system_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "system_status_all" ON public.system_status;
CREATE POLICY "system_status_all" ON public.system_status FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_logs_all" ON public.audit_logs;
CREATE POLICY "audit_logs_all" ON public.audit_logs FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.notification_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notification_jobs_all" ON public.notification_jobs;
CREATE POLICY "notification_jobs_all" ON public.notification_jobs FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.job_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_queue_all" ON public.job_queue;
DROP POLICY IF EXISTS "job_queue_service_role" ON public.job_queue;
DROP POLICY IF EXISTS "job_queue_auth_select" ON public.job_queue;
CREATE POLICY "job_queue_service_role" ON public.job_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "job_queue_auth_select" ON public.job_queue FOR SELECT TO authenticated USING (true);

-- Reload PostgREST schema cache immediately
NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
