#!/usr/bin/env bash
# Usage: SUPABASE_PROJECT_REF=xxxx ./scripts/deploy-supabase.sh
# Requires `supabase login` to have been run interactively once (can't be
# scripted). Safe to re-run — link/secrets set are idempotent, db push only
# applies migrations not already recorded as applied.
#
# Run once before deploy-worker.sh (so the edge functions exist and worker
# testing has something to call), then run again after setup-gcp.sh +
# setup-pubsub.sh to add the GCP secrets that make Pub/Sub publishing work.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${SUPABASE_PROJECT_REF:?Set SUPABASE_PROJECT_REF — the ref in your Supabase dashboard URL (app.supabase.com/project/REF)}"
[ -f supabase/.env.secrets ] || { echo "supabase/.env.secrets missing — copy supabase/.env.secrets.example and fill it in"; exit 1; }
set -a; source supabase/.env.secrets; set +a
: "${SEAT_PASSPORT_SECRET:?supabase/.env.secrets is missing SEAT_PASSPORT_SECRET — must match worker/.env}"
: "${DEMO_MODE:?supabase/.env.secrets is missing DEMO_MODE}"

echo "==> Linking project ${SUPABASE_PROJECT_REF}"
npx supabase link --project-ref "${SUPABASE_PROJECT_REF}"

echo "==> Pushing migrations (0001-0006)"
npx supabase db push

echo "==> Setting core secrets"
npx supabase secrets set SEAT_PASSPORT_SECRET="${SEAT_PASSPORT_SECRET}" DEMO_MODE="${DEMO_MODE}"

[ -f scripts/.demo-state ] && source scripts/.demo-state
if [ -n "${GCP_PROJECT_ID:-}" ] && [ -f scripts/.edge-publisher-key.json ]; then
  echo "==> GCP setup detected — also wiring Pub/Sub secrets"
  npx supabase secrets set \
    GCP_PROJECT_ID="${GCP_PROJECT_ID}" \
    GCP_PUBSUB_TOPIC="notification-jobs" \
    GCP_SERVICE_ACCOUNT_JSON="$(cat scripts/.edge-publisher-key.json)"
else
  echo "==> Skipping Pub/Sub secrets — run ./scripts/setup-gcp.sh and ./scripts/setup-pubsub.sh, then re-run this script"
fi

echo "==> Deploying edge functions (verify_jwt settings come from supabase/config.toml)"
npx supabase functions deploy surge-router
npx supabase functions deploy simulate
npx supabase functions deploy verify-audit
npx supabase functions deploy log-explainer

echo ""
echo "Supabase side deployed. Functions live at:"
echo "  \$(supabase status -o env | grep API_URL)/functions/v1/{surge-router,simulate,verify-audit,log-explainer}"
