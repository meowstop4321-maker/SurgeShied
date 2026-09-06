# Monitoring and Operations

## Existing Signals

The Operations Dashboard polls `get_ops_metrics` and surfaces requests per second, queue length, active/total lanes, surge score, Lite Mode, queued notifications, retries, dead letters, Circuit Guardian state, and worker health/count. The worker exposes `/health` and writes heartbeats every 20 seconds. `log-explainer` turns metrics and recent audit events into plain-English explanations.

[Editable monitoring pipeline diagram](diagrams/monitoring_pipeline.mmd)

## Suggested SLIs and Hackathon SLOs

These are proposed measurement targets, not claims of an executed production SLO:

| SLI | Measurement | Demo target |
|---|---|---|
| Registration success | confirmed or queued responses / valid attempts | >= 99% excluding invalid/closed requests |
| No overbooking | allocated seats beyond lane capacity | 0 |
| Registration latency | p95 request time through response | establish baseline locally; report measured value |
| Queue correctness | stable lane and monotonic FIFO position | 100% sampled correctness |
| Notification recovery | queued jobs eventually sent or dead-lettered with reason | 100% terminal outcome |
| Worker availability | recent heartbeat and `/health` response | >= 99% during demo |
| Audit integrity | successful chain verification | 100% |

## Alerts

For AWS deployments, create CloudWatch alarms for App Runner 5xx/latency and instance health, SQS visible messages/age and DLQ depth, CloudFront 4xx/5xx, and worker log patterns. For Supabase, monitor database CPU/connections, Edge Function errors/latency, pending registrations, and audit verification failures. The repository scripts do not create these alarms automatically.

## Runbook Order

1. Check the frontend and worker health endpoints.
2. Check `circuit_state`, worker heartbeat age, notification backlog, retries, and dead letters.
3. Verify whether Lite Mode is active and whether the event is saturated.
4. Validate the audit chain before changing data.
5. Inspect `last_error` and downstream email provider status.
6. Preserve queued jobs; avoid manual seat counter edits unless following a reviewed database recovery procedure.
