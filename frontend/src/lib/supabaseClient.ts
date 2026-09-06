import { createClient } from "@supabase/supabase-js";

// Project defaults (ensures the app works out of the box even if a collaborator hasn't created a local .env yet)
const DEFAULT_SUPABASE_URL = "https://uyafreiwfuansdfacxye.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5YWZyZWl3ZnVhbnNkZmFjeHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2ODQ4MTMsImV4cCI6MjEwNDI2MDgxM30.k4qO0PpPYwy2Va3T6QKB4_tqK7uaNY5Wzx-GhWwnNJE";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export const FUNCTIONS_URL =
  import.meta.env.VITE_SUPABASE_FUNCTIONS_URL || `${supabaseUrl}/functions/v1`;
