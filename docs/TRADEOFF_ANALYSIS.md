# Trade-off Analysis

| Decision | Chosen approach | Alternative | Why this is reasonable for the MVP |
|---|---|---|---|
| Transactional store | PostgreSQL/Supabase | DynamoDB | Row locks, SQL constraints, RLS, and RPCs directly express no-overbooking invariants. DynamoDB could scale writes but would require a different conditional-counter and access model. |
| Managed backend | Supabase | Amazon RDS | Supabase combines Postgres, Auth, RLS, Realtime, and Edge Functions with low setup cost. RDS gives deeper AWS control but would require building more identity and API plumbing. |
| Worker hosting | App Runner in AWS path | ECS/Fargate | App Runner matches a single container and is low-operations for a hackathon. ECS offers finer networking, sidecars, and scaling controls for a larger platform. |
| Async delivery | Notification job table plus Pub/Sub primary path; SQS adapter in AWS path | Kafka | SQS/Kafka decouple work, but Kafka's partitioning and operations are excessive for this workload. The durable table is the source of recovery truth. |
| API style | REST-like Edge Function endpoints | GraphQL | Registration has a small command surface and benefits from explicit authorization and payloads. GraphQL would help aggregation but adds schema and resolver complexity. |
| Service shape | Thin Edge Functions plus one worker | Many microservices | The boundaries isolate synchronous allocation from async delivery without distributing the transaction across services. More services would add deployment and tracing overhead. |
| Frontend build | Vite + React | Next.js | The SPA has no server-rendered requirement and Vite keeps the demo fast and simple. Next.js becomes attractive for SEO, server rendering, or route-level backend work. |

None of these choices is a universal recommendation. The correct next step is load testing against the actual event, lane count, database limits, and recovery objectives.
