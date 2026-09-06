# Surge Handling Review & Dynamic (Elastic) Surge Partitions

This document covers two things: an audit of how SurgeShield currently behaves during a
sudden registration surge (what gets queued, what completes, what fails, and why), and the
Dynamic Queueing feature added alongside it — lanes that grow while a surge is active and
shrink back down once it passes.

A note on method: this was a static code review, not a live load test. The device shell
needed to run commands against your machine (and therefore against your real Supabase
project) never came up this session, so no live traffic was generated and nothing in your
database was touched to produce this report. Every claim below is traced to a specific file
and line, and the "How to get real numbers" section at the end gives you two ways to verify
everything against your actual deployment — one takes one click, the other is a new
automated test suite included with this change.

## 1. How a surge is currently detected and handled

Every registration request goes through `registerForEvent()` in
`supabase/functions/_shared/register.ts`, called identically by both `surge-router` (real
users) and `simulate` (the demo load generator) — the same code path either way. For each
request it: reads all of the event's `seat_partitions` rows ("lanes"), ranks the lanes that
still have room by headroom ratio (Crowd Pressure Routing), and tries `allocate_seat()` —
a Postgres function that locks the chosen lane row, checks capacity while holding the lock,
and only then increments the seat counter and inserts the registration. If every lane is
full, the request is placed into that lane's FIFO waiting queue, choosing whichever lane
currently has the shortest queue.

A request is classified as `confirmed` the instant `allocate_seat()` succeeds, `queued` if
every lane was full, `already_registered` if it collides with the unique-active-registration
index, and an application error (`error`) for anything else. The `simulate` edge function
and the Simulation Panel in the Operations dashboard tally exactly these four outcomes, so
"how many requests get queued / completed / failed" is a number you can read directly off
that panel for any load you run — see §5.

The zero-overbooking guarantee itself is solid: `allocate_seat()`'s `SELECT ... FOR UPDATE`
means two concurrent requests racing for the last seat in a lane cannot both win, and the
existing `test-critical-edge-cases.js` suite already asserts this under real concurrent
bursts (a 12-way race for 5 seats, a double-click with a shared idempotency key, etc.). That
part of the system is correctly built and didn't need fixing.

## 2. What was actually causing (or masking) failures

### 2.1 Lane count was never dynamic, despite the name

The biggest gap relative to what you asked for: "Adaptive Surge Partitions" only ever meant
adaptive *routing* across a **fixed** number of lanes. `events.lane_count` and the
`seat_partitions` rows are created once, at event creation
(`create_event_with_partitions()` in `0009_lockdown_rls.sql`, and `seed-demo.sh`'s
`create_event()` for demo data), and nothing in the codebase ever changed a lane count
afterward. A 400-seat event with 4 lanes has exactly 4 lanes whether 10 people or 10,000
show up. This is §4 below — the main piece of new work in this change.

### 2.2 A non-capacity error was silently treated as "lane full"

In the ranked-lane loop, any `allocate_seat()` error that wasn't a unique-violation (`23505`,
already registered) was treated the same as "this lane is full, try the next one" — including
a dropped connection, a timeout, or a permissions error. If every ranked lane failed for one
of *those* reasons rather than genuinely being full, the code fell through to
`enqueueUser()` and told the caller they were "queued," which under a real outage is a
promise the queue can never keep. **Fixed**: `register.ts` now tracks which failures were
genuinely capacity-related (`P0001` / `lane_full`) versus everything else, and only returns
`queued` when at least one lane failure was a real capacity error; if every ranked lane
failed for a *non*-capacity reason, it now returns a `503` with the underlying error message
instead of a silent, undeliverable queue position.

### 2.3 An N+1 query pattern that gets worse exactly when it matters most

`enqueueUser()` (the path taken once every lane is full — i.e., exactly during a surge)
issued one `count` query per lane, in parallel, on every single request that needed to
queue, just to find the shortest queue. With 4 lanes that's 4 extra round trips per queuing
request; with the elastic scaling in §4 growing the lane count during a surge, this pattern
would have scaled *against* you — more lanes under load means more parallel count queries
per request, right when Postgres connections are already under the most pressure.
**Fixed**: replaced with one `get_queue_lengths()` RPC call that returns all lanes' queue
depths in a single round trip (new function, `0010_dynamic_lane_scaling.sql`).

### 2.4 The anti-bot rate limiter exists in the database and is never called

`0007_antibot.sql` defines `check_rate_limit()` — a sliding-window limiter with a cooldown,
clearly built for exactly this purpose — but grepping the whole codebase (edge functions,
worker, frontend) turns up zero callers. `TASK_STATUS.md` marks "Anti-Bot Queue" as done, but
nothing was ever wired to it. Without it, a single user's client double-clicking, or a buggy
retry loop, can hammer the registration endpoint with unbounded concurrency — which is
exactly the kind of amplification that turns a real surge into database-connection
exhaustion rather than a clean, capacity-bounded queue. **Fixed**: `surge-router/index.ts`
now calls `check_rate_limit()` keyed per authenticated user (8 requests / 30s, 20s cooldown)
before doing anything else, returning `429 rate_limited` instead of forwarding the request.

### 2.5 The frontend has a second, weaker copy of the registration logic — and silently prefers it on any error

`frontend/src/lib/api.ts` has a `fallbackRegister()` that re-implements CPR client-side for
when the edge function can't be reached. Two problems: first, `authedFetch()` treated *any*
non-2xx response from `surge-router` — including a deliberate `409 closed` or the new `429
rate_limited` — as "unreachable" and silently switched to this fallback instead of
surfacing the real response. Second, the fallback never checked `events.registration_open`
at all, so a closed event could still accept a registration through it. Per
`PROJECT_STATE.md`, this project has not yet been run against a real deployed account, so if
edge functions end up not deployed for a demo, *all* real traffic would go through this
weaker path with none of the protections above. **Fixed**: `authedFetch()` now distinguishes
a genuine network failure from a real HTTP response and returns the latter as-is; the
fallback now checks `registration_open` and reuses the same "already queued, don't switch
lanes" and shortest-queue placement logic as the server path.

### 2.6 Left as-is, flagged for a product decision (not changed)

`0009_lockdown_rls.sql`'s `allocate_seat()` sets new registrations straight to `status =
'confirmed'` by default (`p_confirmed = true`, which is what `register.ts` and the client
fallback both pass). But `register.ts` still issues a Seat Passport with a 2-minute
expiry and updates `seat_passport_expires_at` as if the reservation were temporary. Ghost
Seat Recovery (`release_expired_seats()`) only ever sweeps rows where `status = 'pending'`
— so for the normal path, that 2-minute window is cosmetic: the seat is never reclaimed by
the sweep no matter how long it sits unconfirmed downstream (e.g. before payment, if that's
ever added). This looks like the intended fix for a different, earlier bug (the migration's
own comment says it stops Ghost Seat Recovery from wrongly expiring already-confirmed
tickets), but the side effect is that "2-minute booking window" is currently aspirational
copy, not enforced behavior. I didn't change this because it's a product call: either (a)
`register.ts` should call `allocate_seat` with `p_confirmed:false` so registrations stay
`pending` until a real confirmation step exists and Ghost Seat Recovery can reclaim
abandoned ones, or (b) if instant confirmation is actually the intended behavior, the 2-minute
passport/TTL language in the README and UI should be removed rather than left describing a
window that doesn't gate anything. Worth a deliberate decision either way.

## 3. Where requests actually queue and fail, concretely

Given the code above, here is the honest breakdown of the three questions you asked:

**How many requests get queued**: every request that arrives after all lanes report
`seats_taken >= capacity` at read time. `get_ops_metrics()`'s `queue_length` field, and the
`Waiting Queue` tile on the Operations Dashboard (already built, live via Supabase Realtime),
show this number continuously for a real or simulated run.

**Which requests complete**: any request whose ranked-lane loop finds a lane with headroom
at the moment its `allocate_seat()` call acquires that lane's row lock. Under concurrency,
this is closer to first-committed-wins than first-arrived-wins for the very last seats in a
lane, but never more than `capacity` per lane, ever — enforced by the row lock plus the
`seats_within_capacity` check constraint, not by application logic.

**Which requests fail, and why**: before this change, a "failure" (as opposed to a queue
placement) could come from an event not existing (404), registration being closed (409,
correctly returned), or a genuinely broken registration attempt now correctly identifiable
as such (§2.2's fix) rather than silently absorbed as "queued." After this change, a fourth,
intentional failure mode is added: `429 rate_limited`, for a single user retrying faster than
the anti-bot cooldown allows (§2.4) — this is a fix, not a regression: those requests were
previously accepted and processed at full cost with no limit at all.

## 4. Dynamic (Elastic) Surge Partitions — what was added

New migration `supabase/migrations/0010_dynamic_lane_scaling.sql` adds the ability to change
an event's *lane count* at runtime, in both directions, without ever changing its total seat
capacity or touching a single existing registration.

**Growing (`split_lane`)**: CPR always routes new arrivals to whichever lane currently has
the highest headroom *ratio* — so during a burst, the lane with the most spare seats is also
the one attracting the most concurrent lock attempts, not the fullest one. `split_lane()`
takes that lane, moves half of its *unallocated* headroom into a brand-new sibling lane, and
leaves every existing seat and every existing queue entry exactly where it was. This halves
the concurrent pressure on that one row going forward.

**Shrinking (`merge_lanes`)**: folds two lanes back into one — capacity and seats-taken both
sum, and any attendees still waiting in the removed lane's queue are reassigned to the
surviving lane with their original arrival order (`created_at`) untouched, so nobody loses
their place. It always merges the two *least*-loaded lanes, so busy lanes and anyone actually
queued on them are left undisturbed.

**Deciding when (`suggest_lane_count`, `rebalance_lanes`)**: `suggest_lane_count()` computes
a target lane count from current average lane saturation and queue depth — the same
proportional shape `worker/workerManager.js`'s `calculateTargetWorkers()` already uses for
scaling notification workers, applied here to registration lanes instead. `rebalance_lanes()`
is the single entry point: it moves the event at most one split or merge per call (cheap
enough to call from the hot registration path), and is guarded by a per-event Postgres
advisory lock so that when a whole burst of concurrent requests all notice the same surge at
once, exactly one of them performs the rebalance and the rest return immediately — no
stampede of concurrent splits fighting over the same lane row.

**Growing is request-triggered, shrinking is sweep-triggered**: `register.ts` fires
`rebalance_lanes()` in the background (never awaited — never adding latency to the response)
whenever it detects a surge, which is what grows the lane count. But there's no code that
runs when *nobody* is registering, which is exactly when you'd want to shrink back down. So
`worker/index.js` now also runs a `laneRebalanceSweep()` every 30 seconds across all
open-registration events, asking each one to consolidate if it can. A 45-second cooldown
inside `rebalance_lanes()` (tracked via `events.last_lane_scale_at`) stops a momentary lull
from immediately undoing a split that the next burst would just need again.

**Bounds**: each event gets `min_lane_count` (defaults to whatever the organizer originally
configured — auto-scaling only ever adds lanes above that baseline and returns to it, it
never fragments a planned event below what was set up) and `max_lane_count` (defaults to 16,
raisable per event). `suggest_lane_count()` always clamps to these.

**Why this can't overbook**: every function above only ever moves *unallocated* headroom
between lane rows, inside a single locked transaction, and the total
`sum(seat_partitions.capacity)` for an event is mathematically unchanged by a split or a
merge — the same invariant `allocate_seat()`'s row lock already protects, just enforced one
level up. `scripts/test-dynamic-lane-scaling.js` (new, included) asserts this directly: total
capacity before and after concurrent rebalancing, a 10-way concurrent rebalance burst that
should produce exactly one actual split (not ten), and a burst of concurrent `allocate_seat`
calls immediately after a split that must never exceed the split lane's own capacity.

You'll also see this live with **zero frontend changes** — `PartitionBoard.tsx` already
re-fetches `seat_partitions` on every Realtime change (`event: "*"`, which includes
row inserts and deletes, not just updates) and renders however many lanes currently exist. It
already carries a "Dynamic Queuing" label that, until now, wasn't backed by anything; it
now is. New `lane_split` / `lane_merge` audit entries also show up in the existing Live
Audit Log table for free (their `lane_index` metadata key matches what that table already
knows how to render).

## 5. How to get real numbers against your own deployment

Two ways, both already exist or were added by this change — neither requires me to have
shell access to your machine:

1. **Simulation Panel** (`/simulate` or embedded in `/ops`): click "1,000 Users" or "Simulate
   Surge" against a real or `supabase start`-local Supabase project. The panel reports
   `attempted / confirmed / queued / already_registered / error` directly from a real run of
   `registerForEvent()` — not a model of it.
2. **Automated test suites** (run with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and for
   the edge-case suite also `SUPABASE_ANON_KEY`, set as environment variables):
   - `node scripts/test-critical-edge-cases.js` — existing suite; still relevant, unchanged.
   - `node scripts/test-dynamic-lane-scaling.js` — new, added by this change. Asserts
     capacity conservation across splits/merges, that a concurrent rebalance burst produces
     exactly one split rather than a stampede, and that post-split allocation still never
     exceeds a lane's capacity.

If you'd like, tell me and I can also try running these once your machine reconnects — I
wasn't able to reach a shell on it this session (see the note at the top).
