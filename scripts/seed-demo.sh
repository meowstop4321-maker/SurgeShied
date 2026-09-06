#!/usr/bin/env bash
# Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ./scripts/seed-demo.sh [attendee_count]
# Requires: curl, jq. Safe to re-run — re-running just adds/overwrites demo
# rows; it does not delete anything.
#
# Creates: N demo attendees, 1 demo organizer, 3 sample events (one large
# and open, one small and pre-filled into the queue, one closed), the
# registrations/queue_entries to back that up directly (not via the live
# pipeline — that's what the Simulation Panel is for), and a few
# representative audit-chain entries so the Trust Card has something to
# show before anyone clicks Simulate.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

: "${SUPABASE_URL:?Set SUPABASE_URL — Supabase dashboard → Settings → API}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Set SUPABASE_SERVICE_ROLE_KEY — same page, keep this secret}"
COUNT="${1:-250}"
H=(-H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" -H "Content-Type: application/json")

iso_in_days () { # portable GNU/BSD date
  date -u -d "+$1 day" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v"+$1"d +%Y-%m-%dT%H:%M:%SZ
}

echo "==> Creating ${COUNT} demo attendee users..."
for i in $(seq 1 "$COUNT"); do
  curl -s -o /dev/null "${H[@]}" -X POST "${SUPABASE_URL}/auth/v1/admin/users" \
    -d "{\"email\":\"demo-attendee-${i}@surgeshield.test\",\"password\":\"demo-pass-${i}-fixed\",\"email_confirm\":true}"
  if (( i % 50 == 0 )); then echo "  ...${i}/${COUNT}"; fi
done

echo "==> Creating demo organizer..."
ORG_RESP=$(curl -s "${H[@]}" -X POST "${SUPABASE_URL}/auth/v1/admin/users" \
  -d '{"email":"demo-organizer@surgeshield.test","password":"demo-organizer-pass","email_confirm":true}')
ORG_ID=$(echo "$ORG_RESP" | jq -r '.id // empty')
if [ -z "$ORG_ID" ]; then
  ORG_ID=$(curl -s "${H[@]}" "${SUPABASE_URL}/auth/v1/admin/users?email=demo-organizer@surgeshield.test" | jq -r '.users[0].id')
fi
curl -s -o /dev/null "${H[@]}" -X PATCH "${SUPABASE_URL}/rest/v1/profiles?id=eq.${ORG_ID}" -d '{"role":"organizer"}'
echo "  organizer id: $ORG_ID"

create_event () { # title capacity lanes days_out open -> prints event id
  local title="$1" capacity="$2" lanes="$3" days="$4" open="$5"
  local resp id perlane
  resp=$(curl -s "${H[@]}" -H "Prefer: return=representation" -X POST "${SUPABASE_URL}/rest/v1/events" \
    -d "{\"organizer_id\":\"${ORG_ID}\",\"title\":\"${title}\",\"description\":\"Seeded demo event\",\"capacity\":${capacity},\"lane_count\":${lanes},\"starts_at\":\"$(iso_in_days "$days")\",\"location\":\"Demo Hall\",\"registration_open\":${open}}")
  id=$(echo "$resp" | jq -r '.[0].id')
  perlane=$(( capacity / lanes ))
  for ((l=0; l<lanes; l++)); do
    curl -s -o /dev/null "${H[@]}" -X POST "${SUPABASE_URL}/rest/v1/seat_partitions" \
      -d "{\"event_id\":\"${id}\",\"lane_index\":${l},\"capacity\":${perlane},\"seats_taken\":0}"
  done
  echo "$id"
}

echo "==> Creating 3 sample events..."
LAUNCH_ID=$(create_event "SurgeShield Demo Launch" 400 4 7 true)
MEETUP_ID=$(create_event "Small Team Meetup" 20 2 1 true)
SUMMIT_ID=$(create_event "Enterprise Summit (registration not yet open)" 500 8 30 false)
echo "  LAUNCH_ID=${LAUNCH_ID}"
echo "  MEETUP_ID=${MEETUP_ID}"
echo "  SUMMIT_ID=${SUMMIT_ID}"

echo "==> Fetching attendee pool for pre-fill..."
POOL=$(curl -s "${H[@]}" "${SUPABASE_URL}/rest/v1/profiles?role=eq.attendee&select=id&limit=30" | jq -r '.[].id')
readarray -t POOL_ARR <<< "$POOL"
if [ "${#POOL_ARR[@]}" -lt 28 ]; then
  echo "  WARNING: fewer than 28 attendees in pool — pre-fill will be partial. Increase attendee_count and re-run."
fi

echo "==> Pre-filling Small Team Meetup (both lanes to capacity, 8 more into the queue)..."
FILLED=0
for uid in "${POOL_ARR[@]:0:20}"; do
  lane=$(( FILLED % 2 ))
  reg=$(curl -s "${H[@]}" -H "Prefer: return=representation" -X POST "${SUPABASE_URL}/rest/v1/registrations" \
    -d "{\"event_id\":\"${MEETUP_ID}\",\"user_id\":\"${uid}\",\"lane_index\":${lane},\"status\":\"confirmed\"}")
  reg_id=$(echo "$reg" | jq -r '.[0].id // empty')
  if [ -n "$reg_id" ]; then
    curl -s -o /dev/null "${H[@]}" -X POST "${SUPABASE_URL}/rest/v1/rpc/append_audit_log" \
      -d "{\"p_actor_id\":\"${uid}\",\"p_action\":\"seat_allocated\",\"p_entity\":\"registration\",\"p_entity_id\":\"${reg_id}\",\"p_metadata\":{\"event_id\":\"${MEETUP_ID}\",\"lane_index\":${lane},\"seeded\":true}}"
  fi
  FILLED=$((FILLED + 1))
done
for lane in 0 1; do
  curl -s -o /dev/null "${H[@]}" -X PATCH "${SUPABASE_URL}/rest/v1/seat_partitions?event_id=eq.${MEETUP_ID}&lane_index=eq.${lane}" \
    -d '{"seats_taken":10}'
done
for uid in "${POOL_ARR[@]:20:8}"; do
  lane=$(( RANDOM % 2 ))
  curl -s -o /dev/null "${H[@]}" -X POST "${SUPABASE_URL}/rest/v1/queue_entries" \
    -d "{\"event_id\":\"${MEETUP_ID}\",\"user_id\":\"${uid}\",\"lane_index\":${lane},\"status\":\"waiting\"}"
  sleep 0.05 # stagger created_at so queue_position() ordering is meaningful
done

echo "==> Verifying audit chain..."
CHAIN=$(curl -s "${H[@]}" -X POST "${SUPABASE_URL}/rest/v1/rpc/verify_audit_chain" -d '{}')
echo "  $CHAIN"

{
  echo "DEMO_ORGANIZER_EMAIL=demo-organizer@surgeshield.test"
  echo "DEMO_ORGANIZER_PASSWORD=demo-organizer-pass"
  echo "DEMO_ATTENDEE_COUNT=${COUNT}"
  echo "DEMO_EVENT_LAUNCH_ID=${LAUNCH_ID}"
  echo "DEMO_EVENT_MEETUP_ID=${MEETUP_ID}"
  echo "DEMO_EVENT_SUMMIT_ID=${SUMMIT_ID}"
  echo "DEMO_EVENT_ID=${LAUNCH_ID}" # default target for Simulation Panel / verify.sh
} >> scripts/.demo-state

echo ""
echo "Done. State written to scripts/.demo-state (sourced by deploy-vercel.sh / verify.sh)."
