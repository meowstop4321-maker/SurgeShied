#!/usr/bin/env bash
# Usage: ./scripts/deploy-worker.sh
# Reads worker/.env (copy from worker/.env.example first) plus
# GCP_PROJECT_ID/GCP_REGION from scripts/.demo-state (written by setup-gcp.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f scripts/.demo-state ] && source scripts/.demo-state
: "${GCP_PROJECT_ID:?Run ./scripts/setup-gcp.sh first, or export GCP_PROJECT_ID}"
: "${GCP_REGION:=us-central1}"

[ -f worker/.env ] || { echo "worker/.env missing — copy worker/.env.example and fill it in"; exit 1; }
set -a; source worker/.env; set +a
: "${SUPABASE_URL:?worker/.env is missing SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?worker/.env is missing SUPABASE_SERVICE_ROLE_KEY}"
: "${SEAT_PASSPORT_SECRET:?worker/.env is missing SEAT_PASSPORT_SECRET — must match the edge functions secret}"

ENV_FILE=$(mktemp)
trap 'rm -f "$ENV_FILE"' EXIT
cat > "$ENV_FILE" <<EOF
SUPABASE_URL: "${SUPABASE_URL}"
SUPABASE_SERVICE_ROLE_KEY: "${SUPABASE_SERVICE_ROLE_KEY}"
SEAT_PASSPORT_SECRET: "${SEAT_PASSPORT_SECRET}"
RESEND_API_KEY: "${RESEND_API_KEY:-}"
RESEND_FROM: "${RESEND_FROM:-SurgeShield <onboarding@resend.dev>}"
PUBSUB_PUSH_TOKEN: "${PUBSUB_PUSH_TOKEN:?worker/.env is missing PUBSUB_PUSH_TOKEN — invent any random string, setup-pubsub.sh needs the same value}"
EOF

echo "==> Deploying worker to Cloud Run (region ${GCP_REGION})"
gcloud run deploy surgeshield-worker \
  --source ./worker \
  --project "${GCP_PROJECT_ID}" \
  --region "${GCP_REGION}" \
  --service-account "surgeshield-worker@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --env-vars-file "$ENV_FILE" \
  --min-instances=1 --max-instances=3 \
  --allow-unauthenticated \
  --quiet

WORKER_URL=$(gcloud run services describe surgeshield-worker --region "${GCP_REGION}" --project "${GCP_PROJECT_ID}" --format='value(status.url)')
echo "==> Worker deployed: ${WORKER_URL}"

grep -v '^WORKER_URL=' scripts/.demo-state 2>/dev/null > scripts/.demo-state.tmp || true
mv scripts/.demo-state.tmp scripts/.demo-state 2>/dev/null || true
echo "WORKER_URL=${WORKER_URL}" >> scripts/.demo-state
echo "PUBSUB_PUSH_TOKEN=${PUBSUB_PUSH_TOKEN}" >> scripts/.demo-state

echo "Saved WORKER_URL to scripts/.demo-state. Next: ./scripts/setup-pubsub.sh"
