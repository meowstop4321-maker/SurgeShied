-- Fix RLS Policies for Public Read & Auto-Profile Sync

-- 1. Allow public & authenticated users to browse events
DROP POLICY IF EXISTS "events: select all" ON public.events;
DROP POLICY IF EXISTS "events: select public" ON public.events;
CREATE POLICY "events: select public" ON public.events FOR SELECT USING (true);

-- 2. Allow public to read seat partition availability
DROP POLICY IF EXISTS "seat_partitions: select all" ON public.seat_partitions;
DROP POLICY IF EXISTS "seat_partitions: select public" ON public.seat_partitions;
CREATE POLICY "seat_partitions: select public" ON public.seat_partitions FOR SELECT USING (true);

-- 3. Profiles policies: Allow users to read and insert their own profile
DROP POLICY IF EXISTS "profiles: select own" ON public.profiles;
DROP POLICY IF EXISTS "profiles: select public" ON public.profiles;
CREATE POLICY "profiles: select public" ON public.profiles FOR SELECT USING (true);

DROP POLICY IF EXISTS "profiles: insert own" ON public.profiles;
CREATE POLICY "profiles: insert own" ON public.profiles FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "profiles: update own" ON public.profiles;
CREATE POLICY "profiles: update own" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- 4. Auto-Profile Creation Trigger (runs on signup)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', 'Attendee'),
    COALESCE(NEW.raw_user_meta_data->>'role', 'attendee')
  )
  ON CONFLICT (id) DO UPDATE
  SET full_name = EXCLUDED.full_name,
      role = EXCLUDED.role;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Sync any existing users into profiles table
INSERT INTO public.profiles (id, role, full_name)
SELECT id, COALESCE(raw_user_meta_data->>'role', 'attendee'), COALESCE(raw_user_meta_data->>'full_name', 'Attendee')
FROM auth.users
ON CONFLICT (id) DO NOTHING;
