#!/usr/bin/env bash
# Usage: GCP_PROJECT_ID=... GCP_REGION=us-central1 ./scripts/setup-gcp.sh
# Run once per GCP project. Idempotent — safe to re-run.
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID — the project you created/selected in the GCP console}"
: "${GCP_REGION:=us-central1}"

echo "==> gcloud auth check"
gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q . || {
  echo "Not logged in. Run: gcloud auth login"; exit 1;
}

echo "==> Setting active project to ${GCP_PROJECT_ID}"
gcloud config set project "${GCP_PROJECT_ID}"
gcloud config set run/region "${GCP_REGION}"

echo "==> Enabling required APIs (safe to re-run)"
gcloud services enable \
  run.googleapis.com \
  pubsub.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com

create_sa () {
  local name="$1" display="$2"
  if gcloud iam service-accounts describe "${name}@${GCP_PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1; then
    echo "  service account ${name} already exists"
  else
    gcloud iam service-accounts create "${name}" --display-name "${display}"
  fi
}

echo "==> Creating service accounts"
create_sa "surgeshield-worker" "SurgeShield Cloud Run worker runtime identity"
create_sa "surgeshield-pubsub-invoker" "Identity Pub/Sub uses to push to the worker (grants run.invoker after deploy)"
create_sa "surgeshield-edge-publisher" "Key given to Supabase edge functions to publish to Pub/Sub"

echo "==> Granting surgeshield-edge-publisher permission to publish"
gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
  --member="serviceAccount:surgeshield-edge-publisher@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher" --condition=None >/dev/null

KEY_PATH="./scripts/.edge-publisher-key.json"
if [ ! -f "$KEY_PATH" ]; then
  echo "==> Generating a key for surgeshield-edge-publisher (goes into Supabase edge function secrets as GCP_SERVICE_ACCOUNT_JSON)"
  gcloud iam service-accounts keys create "$KEY_PATH" \
    --iam-account="surgeshield-edge-publisher@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
  echo "    Saved to $KEY_PATH — NOT committed (see .gitignore). Upload its contents with:"
  echo "    supabase secrets set GCP_SERVICE_ACCOUNT_JSON=\"\$(cat $KEY_PATH)\" GCP_PROJECT_ID=${GCP_PROJECT_ID} GCP_PUBSUB_TOPIC=notification-jobs"
else
  echo "==> $KEY_PATH already exists, not regenerating"
fi

cat >> ./scripts/.demo-state 2>/dev/null <<EOF || true
GCP_PROJECT_ID=${GCP_PROJECT_ID}
GCP_REGION=${GCP_REGION}
EOF

echo ""
echo "GCP setup done. Next: ./scripts/deploy-worker.sh, then ./scripts/setup-pubsub.sh"
