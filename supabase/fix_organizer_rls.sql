-- Fix RLS for Organizer Event & Partition Creation

-- 1. Allow authenticated organizers to create & manage events
DROP POLICY IF EXISTS "events: insert own" ON public.events;
CREATE POLICY "events: insert own" ON public.events FOR INSERT WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "events: update own" ON public.events;
CREATE POLICY "events: update own" ON public.events FOR UPDATE USING (auth.uid() = organizer_id);

DROP POLICY IF EXISTS "events: delete own" ON public.events;
CREATE POLICY "events: delete own" ON public.events FOR DELETE USING (auth.uid() = organizer_id);

-- 2. Allow organizers to insert & manage seat partitions for their events
DROP POLICY IF EXISTS "seat_partitions: insert organizer" ON public.seat_partitions;
CREATE POLICY "seat_partitions: insert organizer" ON public.seat_partitions FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.events e WHERE e.id = seat_partitions.event_id AND e.organizer_id = auth.uid())
  OR auth.role() = 'authenticated'
);

DROP POLICY IF EXISTS "seat_partitions: update organizer" ON public.seat_partitions;
CREATE POLICY "seat_partitions: update organizer" ON public.seat_partitions FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.events e WHERE e.id = seat_partitions.event_id AND e.organizer_id = auth.uid())
);

-- 3. Update all existing demo organizer profiles to role = 'organizer'
UPDATE public.profiles
SET role = 'organizer'
WHERE id IN (
  SELECT id FROM auth.users WHERE email LIKE '%organizer%'
);

-- 4. Enable open profile read and write
DROP POLICY IF EXISTS "profiles: insert own" ON public.profiles;
CREATE POLICY "profiles: insert own" ON public.profiles FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "profiles: update own" ON public.profiles;
CREATE POLICY "profiles: update own" ON public.profiles FOR UPDATE USING (true);
