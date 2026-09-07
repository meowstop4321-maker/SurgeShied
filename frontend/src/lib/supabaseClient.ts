import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "SurgeShield: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be configured in the repository .env or frontend/.env file.",
  );
}

console.info("SurgeShield: connected to Supabase project", supabaseUrl);

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export const FUNCTIONS_URL =
  import.meta.env.VITE_SUPABASE_FUNCTIONS_URL || (supabaseUrl ? `${supabaseUrl}/functions/v1` : "");

export const WORKER_URL = import.meta.env.VITE_WORKER_URL || "";
