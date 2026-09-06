# SurgeShield Agent Guide

## Project Shape

SurgeShield is a React/Vite SPA backed by Supabase Postgres, Edge Functions, and a Node.js Cloud Run worker.

- `frontend/`: React 18 + TypeScript + Vite + Tailwind UI. Pages live in `src/pages/`, reusable UI in `src/components/`, and Supabase/browser helpers in `src/lib/`.
- `supabase/migrations/`: ordered database schema, RPCs, RLS, queue, audit, worker, and anti-bot changes. Do not edit an already-applied migration to change production behavior; add the next migration.
- `supabase/functions/`: Deno Edge Functions. Shared registration behavior belongs in `functions/_shared/register.ts`; keep `surge-router` thin and preserve parity with `simulate`.
- `worker/`: Node.js service for notification delivery, retries, ghost-seat recovery, queue promotion, and health/heartbeat loops.
- `scripts/`: deployment, demo seeding, infrastructure setup, and live verification scripts. `scripts/.demo-state` and local environment files are generated/secrets and must stay untracked.

Read [PROJECT_STATE.md](PROJECT_STATE.md) for the current architecture and known deployment state. Use [README.md](README.md) for setup and the standard deployment sequence. AWS-specific mapping is in [docs/aws_deployment.md](docs/aws_deployment.md); presentation/demo behavior is in [docs/presentation.md](docs/presentation.md).

## Common Commands

Run from the repository root unless noted:

```bash
npm run dev                 # frontend dev server
npm run build               # frontend typecheck and production build
npm run preview             # preview the frontend build
npm run worker              # start the worker

cd frontend && npm run build
cd worker && npm run dev
bash -n scripts/*.sh
```

Use `./scripts/verify.sh` only after the required cloud services, environment variables, demo seed, and deployments exist. Live deployment scripts require human cloud credentials; do not fabricate credentials or commit generated `.env` files, service-account keys, or demo state.

## Change Guidance

- Preserve the separation between browser UI, authenticated Edge Functions, database/RPC invariants, and worker-side asynchronous processing.
- Registration correctness is controlled by shared `registerForEvent()` plus database locking/RPCs. Do not implement a second registration path in a page or entrypoint.
- Keep Seat Passport secrets identical between Supabase and the worker, and never expose service-role keys or worker secrets to the frontend.
- Treat `DEMO_MODE=true` and the simulation endpoint as demo-only; never enable them for a real production project without an explicit security review.
- Keep migrations backward-compatible with deployed functions where practical, and verify RLS/policies when changing data access.
- Match existing React, Tailwind, TypeScript, Deno, Node, and shell patterns. Keep edits focused and avoid unrelated formatting or dependency churn.
- Add or update focused tests/checks when behavior changes. At minimum, run the narrowest relevant build, typecheck, shell syntax check, or live verification available, then report anything that could not be run.

## Validation Checklist

For frontend changes, run `npm run build` from the root or `cd frontend && npm run build`. For worker changes, run `cd worker && npm start` or `npm run dev` only when runtime verification is needed. For shell changes, run `bash -n` on the touched scripts. For migration or Edge Function changes, use the Supabase CLI/project environment when available and inspect the affected RLS, RPC, and function contract together.

Do not commit, reset, or overwrite unrelated user changes. Before deployment, review the relevant script and environment requirements in [README.md](README.md).
