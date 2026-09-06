# Interview Preparation

## What problem does SurgeShield solve?

It protects finite event inventory during burst traffic. The key invariant is database-enforced allocation under a lane row lock, not a best-effort application counter.

## Why lanes instead of one seat counter?

Independent `seat_partitions` rows let unrelated requests contend on different lock targets. Crowd Pressure Routing uses headroom and queue length to select a healthier lane. It reduces contention; it does not remove the need for a transaction.

## What happens if the last seat has two buyers?

The first transaction locks and increments the lane. The second waits, observes the full lane, tries another ranked lane, queues if all lanes are full, or receives a duplicate response if the user already has an active registration. The capacity check is inside the RPC.

## Why is email not part of registration?

Email is a third-party dependency with different latency and failure characteristics. A durable notification job lets the reservation return promptly and gives the worker retry, circuit-breaker, and dead-letter behavior.

## Is the audit chain a blockchain?

No. It is a database-backed SHA-256 hash chain with an ordered append lock. It provides tamper evidence and verification, not consensus or immutability against a privileged database administrator.

## What does Lite Mode protect?

It reduces non-critical telemetry and UI work when saturation or queue pressure crosses thresholds. It does not weaken seat allocation, authentication, or audit behavior.

## Why Supabase and AWS together?

Supabase is the current product backend because it bundles Postgres, Auth, RLS, Realtime, and Edge Functions. AWS scripts provide a credible hosting path for the SPA and worker without pretending the database migration is complete. A production decision would choose ownership, networking, backup, and compliance boundaries explicitly.

## What is incomplete?

The AWS SQS consumer is scaffolded but not wired into the worker startup, and CloudWatch alarms/dashboards are documented but not provisioned by scripts. These are intentionally called out rather than hidden.

## How would you evolve to multi-region?

Keep a single write authority per event or region-partition inventory, use CloudFront and edge caching for static/read traffic, replicate read data, define regional failover semantics, and address data residency. Multi-writer seat allocation requires a conflict protocol or inventory partitioning strategy; it is not a DNS-only change.

## How is AI used?

The Log Explainer is deterministic application code that maps metrics and audit events to human-readable explanations. It is not a generative model making allocation decisions. Seat allocation remains controlled by explicit code, SQL constraints, locks, and audit records.
