# System Architecture

## Architecture Summary

SurgeShield is a React/Vite client backed by Supabase Auth, PostgreSQL, and Edge Functions. A Node.js worker performs asynchronous email delivery and recovery loops. The repository also contains an AWS deployment path for the frontend and worker: S3/CloudFront hosts the SPA, ECR stores the worker image, App Runner runs the container, and SQS is the planned notification adapter. The primary documented runtime remains Supabase plus the worker; AWS scripts do not replace the registration database.

[Editable layered architecture diagram](diagrams/layered_architecture.mmd)

## Components and Rationale

| Component | What it does | Why it exists |
|---|---|---|
| React/Vite client | Auth, event pages, queue screen, operations and organizer views | Keeps the interactive experience separate from transaction authority |
| Supabase Auth | Issues and validates JWT sessions | Provides a standard identity boundary for browser and Edge Functions |
| Profiles/RBAC | Stores `attendee` and `organizer` roles | Makes ownership and organizer operations explicit in RLS policies |
| `surge-router` | Validates JWT, parses input, selects idempotency key, delegates | Keeps the edge entrypoint thin and prevents business-logic drift |
| `register.ts` | CPR, lane selection, queueing, passport and job creation | Centralizes the only registration behavior used by real and demo traffic |
| Registration lanes | `seat_partitions` rows with independent capacity counters | Spreads lock contention across lanes rather than one event counter |
| PostgreSQL RPCs | `allocate_seat`, queue promotion, expiry release, metrics | Makes correctness and row locking execute inside the database transaction boundary |
| Seat Passport | HMAC-SHA256 signed, short-lived reservation claim | Gives a pending reservation an integrity-protected expiry window |
| Queue | Partition-aware FIFO `queue_entries` | Provides a bounded, explainable outcome when inventory is exhausted |
| Notification jobs | Durable queued/sent/retry/dead-letter state | Prevents email latency from blocking seat allocation |
| Node worker | Sends email, sweeps jobs, releases ghost seats, promotes queue entries, heartbeats | Isolates long-running and retryable work from the request path |
| Operations functions/UI | `get_ops_metrics`, `verify-audit`, `log-explainer`, dashboards | Makes health, trust, and degradation visible to operators |
| Audit chain | SHA-256 links across important state transitions | Provides tamper evidence and an explainable allocation history |

## Trust Boundaries

The browser uses the anon key and user JWT. Direct client writes to registration, queue, notification, idempotency, and audit data are blocked by RLS; the authenticated Edge Function uses the service role only on the server side. Worker credentials and Seat Passport secrets remain outside the browser.

## AWS Deployment Boundary

The AWS path is a hosting and worker deployment option, not a new business-logic tier. `setup-aws.sh` creates SQS and ECR state, `deploy-aws-worker.sh` builds and publishes the existing worker to App Runner, and `deploy-aws-frontend.sh` builds and uploads the SPA to S3 with optional CloudFront invalidation. CloudWatch is the operational destination for App Runner, SQS, and CloudFront metrics; the scripts do not currently provision dashboards or alarms.

See [AWS_DEPLOYMENT.md](AWS_DEPLOYMENT.md) and the editable views in [docs/diagrams](diagrams/).
