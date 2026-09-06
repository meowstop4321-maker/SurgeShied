# Sequence Diagrams

These diagrams describe the current request, database, worker, and operator boundaries. They are editable Mermaid source files in [docs/diagrams](diagrams/).

| Flow | Diagram | Explanation |
|---|---|---|
| Successful registration | [registration_sequence.mmd](diagrams/registration_sequence.mmd) | JWT request enters the thin router, CPR chooses a lane, Postgres allocates, and the worker handles notification asynchronously. |
| Last-seat race | [last_seat_sequence.mmd](diagrams/last_seat_sequence.mmd) | The lane row lock serializes competitors; one succeeds and the other queues or retries without overbooking. |
| Duplicate request | [duplicate_request_sequence.mmd](diagrams/duplicate_request_sequence.mmd) | Idempotency response reuse and the active-registration unique index prevent duplicate outcomes. |
| Ghost recovery | [ghost_recovery_sequence.mmd](diagrams/ghost_recovery_sequence.mmd) | The worker invokes expiry release; the database returns capacity and attempts promotion. |
| Notification retry | [notification_retry_sequence.mmd](diagrams/notification_retry_sequence.mmd) | Failed email attempts use exponential backoff and eventually dead-letter. |
| Lite Mode | [lite_mode_sequence.mmd](diagrams/lite_mode_sequence.mmd) | Saturation or queue pressure updates system status and the UI reduces non-critical work. |
| Organizer flow | [organizer_flow_sequence.mmd](diagrams/organizer_flow_sequence.mmd) | An organizer creates and observes events under RLS ownership rules. |
| Auth and RBAC | [auth_sequence.mmd](diagrams/auth_sequence.mmd) | Supabase Auth creates a profile and the role controls data access. |
| Worker recovery | [worker_recovery_sequence.mmd](diagrams/worker_recovery_sequence.mmd) | Heartbeats and the self-heal sweep make missed push delivery observable and recoverable. |

The exact booking window in the current code starts at two minutes, with a six-minute maximum extension constant. The worker's expiry sweep runs every 20 seconds in `worker/index.js`; documentation deliberately avoids presenting those timers as external SLOs.
