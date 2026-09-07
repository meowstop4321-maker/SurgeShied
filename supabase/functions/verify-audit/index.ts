// supabase/functions/verify-audit/index.ts
// Verifies the tamper-evident hash chain of audit_logs table via verify_audit_chain() RPC.
// verify_jwt = false in config.toml so public attendees/auditors can verify transparency.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, accept",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data, error } = await admin.rpc("verify_audit_chain");

    if (error) {
      return json({ status: "error", message: error.message }, 500);
    }

    return json({
      status: "ok",
      chain_valid: data?.chain_valid ?? false,
      total_entries: data?.total_entries ?? 0,
      broken_at_id: data?.broken_at_id ?? null,
      latest_hash: data?.latest_hash ?? null,
      verified_at: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ status: "error", message }, 500);
  }
});
