# SurgeShield load/concurrency/chaos test harness

Real tests against a real local Postgres (no Docker, no live Supabase project needed) — see `docs/PRODUCTION_READINESS_REPORT.md` for the results this harness produced and why it exists (short version: this sandbox had no Docker and no network to the live project, so this is the honest substitute).

## Setup

```bash
cd loadtest
npm install
node start-pg.js &     # starts a local Postgres on 127.0.0.1:54329, first run does `initdb`
node run-migrations.js # applies bootstrap.sql (a minimal auth schema stub) + all of ../supabase/migrations/*.sql
```

If `start-pg.js` fails with a permission error creating `pgdata`, it's almost always because an OS `postgres` user exists and owns the Postgres process, but doesn't have write access to this directory — `mkdir pgdata && chown postgres:postgres pgdata` (Linux/macOS) before starting fixes it. On Windows this generally isn't an issue.

## Running the tests

```bash
node test-concurrency.js   # 1-seat / 100-simultaneous-clicks race, 5 runs
node test-duplicates.js    # double-click, retry-same-key, refresh-mid-registration, repeated calls
node test-load.js          # 10 -> 1000+ concurrent users, writes load-results.json
node test-chaos.js         # 5 failure-injection scenarios
node test-security.js      # rate limiting, invalid input, closed events, zero-capacity lanes
```

Each script creates its own fresh event/users and prints a real PASS/FAIL per check — nothing is mocked, every assertion reads back the actual `seat_partitions`/`registrations`/`job_queue`/`audit_logs` rows after the real SQL functions ran.

`harness.js` is a deliberate line-for-line port of `supabase/functions/_shared/register.ts`'s orchestration, calling the same RPCs in the same order — if you change `register.ts`'s logic, mirror the change here too or the tests will drift from what's actually deployed.
