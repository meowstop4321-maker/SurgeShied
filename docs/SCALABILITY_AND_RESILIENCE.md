# Scalability and Resilience

## Traffic Spikes

Crowd Pressure Routing reads lane headroom and sends each request toward the healthiest available lane. Each lane is a separate `seat_partitions` row, so unrelated lanes can progress concurrently. This reduces contention; it does not make the database infinitely scalable.

## Correctness Under Concurrency

`allocate_seat()` locks the selected lane row with `SELECT ... FOR UPDATE`, checks capacity while holding the lock, increments the counter, and inserts the registration. The active-registration unique index is a second defense against duplicate active reservations. A request that loses a last-seat race cannot increment a full lane.

## Buffering and Retries

Seat allocation returns before email delivery. `notification_jobs` is the durable buffer. Pub/Sub is a best-effort wake-up hint in the primary path; the worker's 20-second self-healing sweep processes due queued jobs if the push is absent. Failed sends use exponential backoff, up to five attempts, then `dead_letter`.

## Ghost Seat Recovery

Pending reservations with expired passports are released by `release_expired_seats()`. The same database path attempts queue promotion, and `finishPromotions()` supplies a passport and notification job for promoted registrations created directly by the RPC.

## Circuit Guardian and Lite Mode

Three consecutive downstream email failures open the Circuit Guardian for a 30-second cooldown. Jobs remain durable while the circuit is open. Lite Mode is driven by lane saturation or queue pressure and protects the core reservation path by reducing non-critical telemetry and visual work. These controls degrade secondary behavior rather than relaxing inventory invariants.

## Scaling Limits and Future Work

The audit chain uses a global advisory lock for ordered appends, and Circuit Guardian failure counters are per worker instance with database state synchronization. These are intentional MVP trade-offs. A larger deployment would shard audit streams by tenant/event, centralize breaker state, add connection pooling, and test database replica/failover behavior before claiming multi-region writes.

## Global and Multi-Region Direction

The first global step is read and asset distribution: publish the Vite bundle through CloudFront, use edge caching for immutable assets, and keep authenticated or inventory-sensitive calls uncached. Regional App Runner workers can process asynchronous work close to users while Supabase remains the controlled write authority.

Beyond the MVP, define an event's write region, replicate read-oriented event and metrics data, and use regional failover only when the reservation authority can preserve idempotency and lane counters. Database replication must include a clear promotion and conflict policy; active-active writes to the same inventory are not obtained by adding DNS records. Data residency may require event or tenant placement rules, regional encryption keys, and deletion/retention policies. These choices are prerequisites for scaling beyond one authoritative transaction region.
