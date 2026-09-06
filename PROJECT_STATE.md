# PROJECT_STATE — SurgeShield

## Preflight Deployment Audit — RESOLVED
All 4 critical blockers from the audit are fixed and re-verified with real
tooling (not just review):
1. **Frontend build** — added `src/vite-env.d.ts` (`/// <reference types="vite/client" />`)
   and fixed 3 useEffect cleanups that returned a Promise instead of void
   (`lib/api.ts`'s two subscribe helpers, `QueueScreen.tsx`). Verified:
   `npx tsc -b` exits 0, `npm run build` exits 0 and produces `dist/`.
2. **Vercel SPA routing** — added `frontend/vercel.json` with a catch-all
   rewrite to `index.html`.
3. **Supabase project init** — ran the real Supabase CLI (`npx supabase
   init`), not hand-written: generated `supabase/config.toml` without
   touching existing migrations/functions. Added `[functions.<name>]`
   blocks: `verify-audit` needs `verify_jwt = false` because
   `TrustCard.tsx` calls it with no Authorization header at all — this was
   a real bug the audit missed and the config-init step surfaced. Validated
   as syntactically correct TOML via Python's `tomllib`.
4. **Deployment scripts** — all 7 scripts (6 original + new
   `deploy-supabase.sh`, added to close the "migrations/functions never
   actually get deployed" gap from the audit) pass `bash -n` and
   `shellcheck -S warning` clean. Fixed 2 shellcheck findings (SC2164 —
   `cd` without a `|| exit` fallback in `seed-demo.sh`/`verify.sh`, both of
   which intentionally run without `set -e`).

New: `scripts/deploy-supabase.sh` (links project, pushes migrations, sets
secrets, deploys the 3 edge functions) and `supabase/.env.secrets.example`.
Updated deployment order — see below.

## Architecture

```
User → surge-router (edge fn, JWT-auth, THIN — see note below)
Simulation Panel → simulate (edge fn, service role, DEMO_MODE-gated) ──┐
                                                                        ▼
                              _shared/register.ts: registerForEvent()
         ├─ Crowd Pressure Routing: rank seat_partitions by headroom
         ├─ allocate_seat() RPC: SELECT...FOR UPDATE on the chosen lane row
         │     └─ full? try next-healthiest lane
         │     └─ unique violation (23505)? → "already_registered", stop
         │     └─ all full? → queue_entries (Parallel Waiting Queue)
         ├─ issue Seat Passport (HMAC, 2-min TTL, max 6 min extension)
         ├─ enqueue_job() → job_queue (status=pending, priority 1-10)
         ├─ publishBestEffort() → Pub/Sub (wake-up hint only)
         └─ set_system_status() → system_status table (drives Lite Mode banner)

Worker (Node, Cloud Run / AWS ECS) — Unified WorkerManager Engine:
  - Dynamic In-Process Autoscaling: scales 1 to 10 concurrent async workers based on job_queue depth & priority pressure.
  - Priority-Aware Atomic Claims: claim_job_batch() via SELECT ... FOR UPDATE SKIP LOCKED.
  - Periodic Sweeps & Recovery:
      - ghostSeatSweep() (20s) → release_expired_seats() → promotes waiting attendees & enqueues Priority 8 confirmation notifications
      - heartbeat() (20s) → upsert_worker_heartbeat()
  - Circuit Guardian Breaker: Opens after 3 consecutive Resend failures, auto-cooldown after 30s.
  - Multi-tier Autoscaling Model:
      1. Vertical / In-Process Autoscale: WorkerManager scales async worker threads dynamically inside the Node process.
      2. Horizontal Container Autoscale: Cloud Run / AWS ECS provisions container instances based on CPU / request concurrency triggers.

Pub/Sub push → POST /pubsub/notification-jobs?token=... → WorkerManager.enqueue() (Priority 8)

Operations Dashboard polls get_ops_metrics(event_id) every 3s + Trust Card +
Lite Mode banner + embedded Simulation Panel. Same panel also stands alone
at /simulate.
```

### surge-router is a thin orchestrator, by design (confirmed this turn)
Its entire body: verify JWT → parse event_id → generate/read Idempotency-Key
→ call `registerForEvent()` → return its result. All CPR/ASP/passport/
notification/audit logic lives in `_shared/register.ts`, which both
`surge-router` (real users) and `simulate` (demo load) call identically —
that's *why* it was extracted last turn, so neither entrypoint could drift
into owning business logic independently. Nothing changed here this turn;
confirming it stayed thin after the worker/simulate work landed.

### Tamper-Evident Audit Chain
Unchanged this turn. `append_audit_log()` chains
`SHA256(previous_hash|created_at|action|actor_id|metadata)` onto `audit_logs`.
Wired at: event creation, registration_attempt + lane_assignment, seat_allocated,
seat_released, lite_mode_activated/deactivated, circuit_guardian_open/close.
`verify-audit` edge fn + `TrustCard.tsx` expose it; seed-demo.sh now also
writes representative entries directly (see below) so the chain isn't empty
before anyone clicks anything.

## Fixed this turn
- Confirmed (not re-fixed, already correct from last turn): worker's
  `finishPromotions()` still issues Seat Passport + notification job for
  registrations `promote_from_queue()` creates directly.
- Found a syntax bug in `deploy-worker.sh` before shipping it: bash parses
  apostrophes specially even inside `${VAR:?message}` constructs (a real,
  documented bash quirk, not a typo) — an apostrophe in an error message
  broke the whole script with "unexpected EOF". Ran `bash -n` on all 6
  scripts after writing them; this was the only failure, now fixed and
  re-verified clean.

## Files that exist (new/changed this turn marked NEW)
```
scripts/
  setup-gcp.sh        NEW — enables APIs, creates 3 service accounts
                       (worker runtime, pubsub-invoker, edge-publisher +
                       downloads its key)
  deploy-worker.sh    NEW — gcloud run deploy from worker/Dockerfile,
                       env vars via generated YAML (not fragile CSV flags)
  setup-pubsub.sh     NEW — topic + push subscription w/ OIDC auth to the
                       worker, grants run.invoker
  deploy-vercel.sh    NEW — pushes VITE_ env vars, `vercel --prod`
  verify.sh           NEW — 9-point health check, reads scripts/.demo-state,
                       exits non-zero on any failure
  seed-demo.sh        REWRITTEN — 3 events (large/open, small/pre-filled-
                       into-queue, closed), direct-seeded registrations +
                       queue_entries (not via the live pipeline — that's
                       what Simulate is for), representative audit-chain
                       entries, writes scripts/.demo-state
supabase/functions/simulate/index.ts   PATCHED — now 403s unless
                       DEMO_MODE=true edge-function secret is set
frontend/src/pages/SimulationPage.tsx  NEW — dedicated /simulate route
                       (same SimulationPanel component, also still
                       embedded in Operations)
.gitignore              NEW — keeps scripts/.demo-state, the edge-publisher
                       key, and all .env files out of any future commit
```
Everything else (migrations 0001–0006, edge functions, worker core, the
other 6 frontend pages) is unchanged from prior turns — see the file tree
in earlier turn history if needed, not repeated here.

## Environment variables
| Var | Used by | Source |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | edge fns, worker, all scripts | Supabase dashboard → Settings → API |
| `SUPABASE_ANON_KEY` | verify.sh, frontend | same page |
| `SUPABASE_PROJECT_REF` | deploy-supabase.sh | Supabase dashboard URL: app.supabase.com/project/REF |
| `SEAT_PASSPORT_SECRET` | surge-router, register.ts, worker (must match) | `openssl rand -hex 32`, put in both `worker/.env` and `supabase/.env.secrets` |
| `DEMO_MODE` | simulate edge fn | `supabase/.env.secrets` — **never set true in a real production project** |
| `GCP_PROJECT_ID` / `GCP_REGION` | all gcloud scripts | your GCP project; setup-gcp.sh persists these to `scripts/.demo-state` |
| `GCP_SERVICE_ACCOUNT_JSON` / `GCP_PUBSUB_TOPIC` | pubsub.ts (edge) | generated by setup-gcp.sh at `scripts/.edge-publisher-key.json` |
| `PUBSUB_PUSH_TOKEN` | worker, Pub/Sub push config | invent any string in `worker/.env`; deploy-worker.sh + setup-pubsub.sh share it via `scripts/.demo-state` |
| `RESEND_API_KEY` / `RESEND_FROM` | worker | Resend dashboard |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` / `VITE_SUPABASE_FUNCTIONS_URL` | frontend | Supabase dashboard |
| `FRONTEND_URL` / `WORKER_URL` | verify.sh | written automatically by deploy-vercel.sh / deploy-worker.sh |

## Deployment order (now scripted end to end, gap from the audit closed)
```
supabase login                              # interactive, one-time
export SUPABASE_PROJECT_REF=...
# fill in supabase/.env.secrets from supabase/.env.secrets.example
./scripts/deploy-supabase.sh                # links, pushes migrations, sets secrets, deploys functions

export GCP_PROJECT_ID=... GCP_REGION=us-central1
./scripts/setup-gcp.sh
# fill in worker/.env and frontend/.env from their .env.example files
./scripts/deploy-worker.sh
./scripts/setup-pubsub.sh
./scripts/deploy-supabase.sh                # re-run: now also wires GCP_* secrets for Pub/Sub
./scripts/deploy-vercel.sh
export SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=...
./scripts/seed-demo.sh 250
./scripts/verify.sh
```
None of this has been run against a real account — see below.

## Not yet built / not yet run
- **Nothing above has executed against a real GCP/Supabase/Vercel account.**
  First real run will surface bugs — likely candidates: IAM propagation
  delay before `run.invoker` takes effect, Vercel CLI env-add prompts this
  script assumes are non-interactive, RLS gaps the frontend hits that
  local reasoning missed.
- Anti-Bot Queue (rate limiting / double-click / cooldown / CAPTCHA hook)
- Log Explainer
- Presentation assets (pitch, walkthrough, judge Q&A)
- README: Setup/Deployment/Tradeoffs/Public URLs/Demo Instructions still TBD
  (scripts now exist to fill these in accurately once run once)
- Diagrams beyond architecture: deployment, sequence, queue, partition, lite mode

## Known issues (carried over, still true)
- Advisory lock in `append_audit_log` serializes chain appends globally —
  kept as-is per explicit decision, documented as a scaling tradeoff.
- `get_ops_metrics()` is `security definer`, intentionally bypassing RLS for
  aggregate counts — any authenticated user can see ops metrics, not just
  organizers.
- Circuit Guardian state is per-instance in-memory + DB-synced; multiple
  Cloud Run instances would have independent failure counts until the
  shared DB state opens the circuit. Fine at `--min-instances=1`.
- `simulate`'s pool selection in `load` uses `order by id limit count`
  (arbitrary-but-stable), not true randomness — deliberate, so verify.sh's
  attendee-index trick (last-seeded attendee is guaranteed outside the
  pre-fill pool) stays reliable.
- readarray (bash 4+) is used in seed-demo.sh — won't run under macOS's
  stock bash 3.2. Use Cloud Shell, Linux, or `brew install bash` first.

## Resume instructions (local dev, no deploy)
```
supabase start
supabase db reset
supabase functions serve --env-file supabase/.env.local
cd worker && npm install && node src/index.js
cd frontend && npm install && npm run dev
```
