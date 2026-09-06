#!/usr/bin/env bash
# Usage: ./scripts/deploy-vercel.sh
# Requires `npx vercel login` to have been run interactively at least once
# (Vercel's CLI auth can't be scripted non-interactively).
set -euo pipefail
cd "$(dirname "$0")/../frontend"

[ -f .env ] || { echo "frontend/.env missing — copy frontend/.env.example and fill it in"; exit 1; }
set -a; source .env; set +a
: "${VITE_SUPABASE_URL:?frontend/.env is missing VITE_SUPABASE_URL}"
: "${VITE_SUPABASE_ANON_KEY:?frontend/.env is missing VITE_SUPABASE_ANON_KEY}"
: "${VITE_SUPABASE_FUNCTIONS_URL:?frontend/.env is missing VITE_SUPABASE_FUNCTIONS_URL}"

echo "==> Linking Vercel project (first run will prompt to create one)"
npx vercel link --yes >/dev/null

set_env () {
  local key="$1" val="$2"
  printf '%s' "$val" | npx vercel env add "$key" production --force >/dev/null 2>&1 \
    || echo "  ${key} already set (or failed — check manually with 'npx vercel env ls')"
}

echo "==> Pushing env vars to Vercel"
set_env VITE_SUPABASE_URL "$VITE_SUPABASE_URL"
set_env VITE_SUPABASE_ANON_KEY "$VITE_SUPABASE_ANON_KEY"
set_env VITE_SUPABASE_FUNCTIONS_URL "$VITE_SUPABASE_FUNCTIONS_URL"

echo "==> Deploying to production"
DEPLOY_OUTPUT=$(npx vercel --prod --yes)
FRONTEND_URL=$(echo "$DEPLOY_OUTPUT" | tail -1)
echo "==> Deployed: ${FRONTEND_URL}"

cd ..
grep -v '^FRONTEND_URL=' scripts/.demo-state 2>/dev/null > scripts/.demo-state.tmp || true
mv scripts/.demo-state.tmp scripts/.demo-state 2>/dev/null || true
echo "FRONTEND_URL=${FRONTEND_URL}" >> scripts/.demo-state
echo "Saved FRONTEND_URL to scripts/.demo-state. Next: ./scripts/verify.sh"
