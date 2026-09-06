#!/usr/bin/env bash
# Usage: ./scripts/setup-pubsub.sh
# Run after ./scripts/deploy-worker.sh (needs WORKER_URL).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f scripts/.demo-state ] && source scripts/.demo-state
: "${GCP_PROJECT_ID:?Run ./scripts/setup-gcp.sh first}"
: "${GCP_REGION:=us-central1}"
: "${WORKER_URL:?Run ./scripts/deploy-worker.sh first}"
: "${PUBSUB_PUSH_TOKEN:?Missing — should have been written by deploy-worker.sh}"

TOPIC="notification-jobs"
SUB="notification-jobs-push"
INVOKER_SA="surgeshield-pubsub-invoker@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

echo "==> Creating topic ${TOPIC} (ok if it already exists)"
gcloud pubsub topics create "${TOPIC}" --project "${GCP_PROJECT_ID}" 2>/dev/null || echo "  already exists"

echo "==> Granting ${INVOKER_SA} permission to invoke the worker"
gcloud run services add-iam-policy-binding surgeshield-worker \
  --project "${GCP_PROJECT_ID}" --region "${GCP_REGION}" \
  --member="serviceAccount:${INVOKER_SA}" --role="roles/run.invoker" --quiet

echo "==> Creating push subscription ${SUB} -> ${WORKER_URL}/pubsub/notification-jobs"
PUSH_ENDPOINT="${WORKER_URL}/pubsub/notification-jobs?token=${PUBSUB_PUSH_TOKEN}"
if gcloud pubsub subscriptions describe "${SUB}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  gcloud pubsub subscriptions update "${SUB}" --project "${GCP_PROJECT_ID}" \
    --push-endpoint="${PUSH_ENDPOINT}" \
    --push-auth-service-account="${INVOKER_SA}"
else
  gcloud pubsub subscriptions create "${SUB}" --project "${GCP_PROJECT_ID}" \
    --topic="${TOPIC}" \
    --push-endpoint="${PUSH_ENDPOINT}" \
    --push-auth-service-account="${INVOKER_SA}" \
    --ack-deadline=30 \
    --min-retry-delay=10s --max-retry-delay=60s
fi

echo ""
echo "Pub/Sub wired. Remember to set on the edge functions (Supabase dashboard or CLI):"
echo "  GCP_PROJECT_ID=${GCP_PROJECT_ID}"
echo "  GCP_PUBSUB_TOPIC=${TOPIC}"
echo "  GCP_SERVICE_ACCOUNT_JSON=\$(cat scripts/.edge-publisher-key.json)"
