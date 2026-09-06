#!/usr/bin/env bash
# Usage: ./scripts/verify.sh
# Run after seed-demo.sh + deploy-worker.sh + setup-pubsub.sh + deploy-vercel.sh.
# Prints PASS/FAIL per check and exits 1 if anything failed.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
[ -f scripts/.demo-state ] && source scripts/.demo-state

PASS=0
FAIL=0
check () {
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "true" ]; then
    echo "[PASS] ${name}${detail:+ — $detail}"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] ${name}${detail:+ — $detail}"
    FAIL=$((FAIL + 1))
  fi
}

: "${SUPABASE_URL:?Missing — export it or run seed-demo.sh with it set}"
: "${SUPABASE_ANON_KEY:?Missing — Supabase dashboard → Settings → API → anon public key}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Missing}"

# 1. Frontend reachable
if [ -n "${FRONTEND_URL:-}" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "$FRONTEND_URL")
  check "Frontend reachable" "$([ "$code" = "200" ] && echo true || echo false)" "$FRONTEND_URL -> HTTP $code"
else
  check "Frontend reachable" "false" "FRONTEND_URL not set — run deploy-vercel.sh"
fi

# 2. Supabase connection
auth_health=$(curl -s -o /dev/null -w '%{http_code}' "${SUPABASE_URL}/auth/v1/health")
check "Supabase connection" "$([ "$auth_health" = "200" ] && echo true || echo false)" "auth/v1/health -> HTTP $auth_health"

# 3. Auth working — sign in as the demo organizer
: "${DEMO_ORGANIZER_EMAIL:?Missing — run seed-demo.sh first}"
: "${DEMO_ORGANIZER_PASSWORD:?Missing}"
ORG_TOKEN_RESP=$(curl -s "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${SUPABASE_ANON_KEY}" -H "Content-Type: application/json" \
  -d "{\"email\":\"${DEMO_ORGANIZER_EMAIL}\",\"password\":\"${DEMO_ORGANIZER_PASSWORD}\"}")
ORG_TOKEN=$(echo "$ORG_TOKEN_RESP" | jq -r '.access_token // empty')
check "Auth working (organizer sign-in)" "$([ -n "$ORG_TOKEN" ] && echo true || echo false)"

# Sign in as a fresh attendee (last one seeded — guaranteed outside the pre-fill pool)
: "${DEMO_ATTENDEE_COUNT:?Missing — run seed-demo.sh first}"
ATTENDEE_EMAIL="demo-attendee-${DEMO_ATTENDEE_COUNT}@surgeshield.test"
ATT_TOKEN_RESP=$(curl -s "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${SUPABASE_ANON_KEY}" -H "Content-Type: application/json" \
  -d "{\"email\":\"${ATTENDEE_EMAIL}\",\"password\":\"demo-pass-${DEMO_ATTENDEE_COUNT}-fixed\"}")
ATT_TOKEN=$(echo "$ATT_TOKEN_RESP" | jq -r '.access_token // empty')

# 4. Registration flow — attendee registers against the open, roomy LAUNCH event
: "${DEMO_EVENT_LAUNCH_ID:?Missing}"
FUNCTIONS_URL="${SUPABASE_URL}/functions/v1"
REG_RESP=$(curl -s -X POST "${FUNCTIONS_URL}/surge-router" \
  -H "Authorization: Bearer ${ATT_TOKEN}" -H "Content-Type: application/json" \
  -H "Idempotency-Key: verify-$(date +%s)" \
  -d "{\"event_id\":\"${DEMO_EVENT_LAUNCH_ID}\"}")
REG_STATUS=$(echo "$REG_RESP" | jq -r '.status // "error"')
check "Registration flow" "$([[ "$REG_STATUS" =~ ^(confirmed|queued|already_registered)$ ]] && echo true || echo false)" "status=${REG_STATUS}"

# 5. Queue flow — same attendee against the pre-filled MEETUP event should queue (or already have)
: "${DEMO_EVENT_MEETUP_ID:?Missing}"
QUEUE_RESP=$(curl -s -X POST "${FUNCTIONS_URL}/surge-router" \
  -H "Authorization: Bearer ${ATT_TOKEN}" -H "Content-Type: application/json" \
  -H "Idempotency-Key: verify-queue-$(date +%s)" \
  -d "{\"event_id\":\"${DEMO_EVENT_MEETUP_ID}\"}")
QUEUE_STATUS=$(echo "$QUEUE_RESP" | jq -r '.status // "error"')
check "Queue flow" "$([[ "$QUEUE_STATUS" =~ ^(queued|confirmed|already_registered)$ ]] && echo true || echo false)" "status=${QUEUE_STATUS} (expected queued — MEETUP is seeded full)"

# 6. Cloud Run worker reachable
if [ -n "${WORKER_URL:-}" ]; then
  WORKER_HEALTH=$(curl -s "${WORKER_URL}/health" | jq -r '.status // "error"')
  check "Cloud Run worker reachable" "$([ "$WORKER_HEALTH" = "ok" ] && echo true || echo false)" "${WORKER_URL}/health -> ${WORKER_HEALTH}"
else
  check "Cloud Run worker reachable" "false" "WORKER_URL not set — run deploy-worker.sh"
fi

# 7. Pub/Sub topic + subscription
if command -v gcloud >/dev/null && [ -n "${GCP_PROJECT_ID:-}" ]; then
  gcloud pubsub topics describe notification-jobs --project "${GCP_PROJECT_ID}" >/dev/null 2>&1
  TOPIC_OK=$([ $? -eq 0 ] && echo true || echo false)
  check "Pub/Sub topic exists" "$TOPIC_OK"
  gcloud pubsub subscriptions describe notification-jobs-push --project "${GCP_PROJECT_ID}" >/dev/null 2>&1
  SUB_OK=$([ $? -eq 0 ] && echo true || echo false)
  check "Pub/Sub subscription exists" "$SUB_OK"
else
  check "Pub/Sub topic exists" "false" "gcloud or GCP_PROJECT_ID missing"
  check "Pub/Sub subscription exists" "false" "gcloud or GCP_PROJECT_ID missing"
fi

# 8. Notification pipeline — if step 4 confirmed a seat, a notification_jobs row should exist for it
if [ "$REG_STATUS" = "confirmed" ]; then
  REG_ID=$(echo "$REG_RESP" | jq -r '.registration.id // empty')
  JOB_COUNT=$(curl -s "${SUPABASE_URL}/rest/v1/notification_jobs?registration_id=eq.${REG_ID}&select=id" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" | jq 'length')
  check "Notification pipeline" "$([ "${JOB_COUNT:-0}" -gt 0 ] && echo true || echo false)" "${JOB_COUNT:-0} job(s) for registration ${REG_ID}"
else
  check "Notification pipeline" "false" "skipped — registration in step 4 did not confirm (status=${REG_STATUS})"
fi

# 9. Lite Mode status endpoint (get_ops_metrics) — presence of the field, not its value
METRICS=$(curl -s -X POST "${SUPABASE_URL}/rest/v1/rpc/get_ops_metrics" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" -d "{\"p_event_id\":\"${DEMO_EVENT_LAUNCH_ID}\"}")
HAS_LITE=$(echo "$METRICS" | jq 'has("lite_mode")')
check "Lite Mode status endpoint" "$([ "$HAS_LITE" = "true" ] && echo true || echo false)" "get_ops_metrics -> $(echo "$METRICS" | jq -c '{lite_mode, circuit_state, worker_status}' 2>/dev/null)"

echo ""
echo "==> ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
