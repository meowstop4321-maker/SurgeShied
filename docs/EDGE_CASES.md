# Edge Cases and Recovery

| Scenario | Current behavior | Operator or product expectation |
|---|---|---|
| Double click | Client debounce plus idempotency key lookup and unique active-registration index | Return the original response or `already_registered`; never allocate twice. |
| Refresh during booking | The registration and Seat Passport are stored server-side; the client can reload its authenticated state | Re-fetch the user's registration and treat an expired passport as a released reservation. |
| Seat expiry | `release_expired_seats()` marks pending rows expired, decrements the lane, audits the release, and attempts promotion | The worker sweep must remain healthy; alert on stale pending rows. |
| Worker crash | Notification jobs remain queued; the next worker self-heal sweep can process due jobs | Keep the worker stateless and use heartbeat age to detect absence. |
| Queue overload | Requests are assigned to the shortest lane queue and lane switching is prohibited | Show a stable position and estimated wait; apply rate limits before database pressure grows. |
| Notification failure | Circuit Guardian opens after three failures; jobs retry with backoff and dead-letter after five attempts | Seat state remains independent from email state; inspect `last_error` and DLQ counts. |
| Database slowdown | Requests may timeout or return errors; transaction locks still protect committed state | Use retries with idempotency, connection limits, and alerts rather than bypassing the database invariant. |
| Pub/Sub/push outage | The edge publish is best effort and the worker scans queued jobs every 20 seconds | Treat push as a latency optimization, not the source of truth. |
| Malformed push | Worker acknowledges an empty payload with HTTP 204; processing errors return 500 for retry | Monitor malformed payloads and preserve a stable job contract. |
| Closed event | Registration returns a `closed` conflict before allocation | Keep UI state consistent with the server response. |
| Cross-lane contention | Allocation tries ranked lanes; a full lane can be skipped, and a unique violation returns already registered | Do not add app-level read-then-write counters. |

The two-minute booking window and twenty-second worker sweep are implementation timings, not guarantees for every deployment. Measure them in the target environment.
