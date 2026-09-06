# 🛡️ SurgeShield — High-Concurrency Event Resilience Engine

> **Zero-Overbooking, Adaptive Surge Partitions & Graceful Degradation for High-Demand Ticket Drops**

[![React](https://img.shields.io/badge/Frontend-React%20%2B%20Vite%20%2B%20Tailwind-teal)](https://vitejs.dev/)
[![Supabase](https://img.shields.io/badge/Backend-Supabase%20%2B%20Postgres%20%2B%20RLS-emerald)](https://supabase.com/)
[![Google Cloud](https://img.shields.io/badge/Cloud-Cloud%20Run%20%2B%20Pub%2FSub-blue)](https://cloud.google.com/)
[![Audit Chain](https://img.shields.io/badge/Integrity-SHA--256%20Hash%20Chained-amber)](https://en.wikipedia.org/wiki/Cryptographic_hash_function)

---

## 🚀 Key Innovations

1. **Adaptive Surge Partitions (ASP):** Splits seat capacity into parallel transactional lanes (`hash(user_id) % N`), eliminating PostgreSQL row-lock contention under heavy concurrency.
2. **Crowd Pressure Routing (CPR):** Dynamically calculates lane headroom and active queue lengths to route incoming attendees to the healthiest partition.
3. **Cryptographic Seat Passports:** Issues HMAC-SHA256 signed temporary reservation tokens with 10-minute TTLs and nonces for checkout exclusivity.
4. **Parallel Waiting Queue:** Partition-aware FIFO queues with real-time position updates and sub-second auto-promotions via Supabase Realtime.
5. **Ghost Seat Recovery:** Automated Cloud Run background worker sweeps abandoned reservations every 45s, returning seats to available inventory and promoting waiting attendees.
6. **Self-Healing Notification Pipeline:** Dual-delivery mechanism combining Google Cloud Pub/Sub push with a 20s worker sweep fallback to guarantee zero lost confirmation emails.
7. **Circuit Guardian & Lite Mode:** Automatically trips on downstream API failures (e.g. Resend rate limits), throttles heavy UI telemetry, and diverts jobs to an exponential backoff Dead-Letter Queue (DLQ).
8. **AI Log Explainer:** Converts complex telemetry metrics and audit events into plain-English incident summaries in real time.
9. **Tamper-Evident Hash Chain:** Chains each audit record's hash to the previous entry (`SHA256(prev_hash | ts | action | actor | meta)`), providing cryptographic proof of fair seat allocations.

---

## 🏗️ System Architecture

```
User Request → Surge Router (Edge Function)
                     ├─ Anti-Bot & Cooldown Guard
                     ├─ Crowd Pressure Routing (Lane Ranking)
                     ├─ allocate_seat() RPC (Row-Level Locks on Target Lane)
                     ├─ HMAC Seat Passport Issue
                     ├─ Tamper-Evident Audit Chain Log
                     └─ Pub/Sub Push Hint ──┐
                                            ▼
                           Cloud Run Worker (Node.js)
                           ├─ Resend Email Dispatch (Circuit Guardian)
                           ├─ Ghost Seat Sweeper (45s Loop)
                           └─ Self-Healing Missed Push Sweep (20s Loop)
```

---

## 📁 Repository Structure

```text
surgeshield/
├── frontend/                     # React + Vite + TS + Tailwind SPA
│   ├── src/
│   │   ├── components/           # TrustCard, SimulationPanel, LogExplainer, QRModal, LiteModeBanner
│   │   ├── pages/                # Landing, Events, EventDetail, QueueScreen, OpsDashboard, OrganizerDashboard, SimulationPage
│   │   ├── lib/                  # api.ts, supabaseClient.ts, auth.tsx, calendar.ts
│   │   └── App.tsx, main.tsx
├── worker/                       # Node.js Cloud Run Worker
│   ├── index.js, package.json, Dockerfile, .env.example
├── supabase/
│   ├── config.toml
│   ├── migrations/               # 0001_init.sql ... 0007_antibot.sql
│   └── functions/
│       ├── _shared/              # register.ts, seatPassport.ts, pubsub.ts
│       ├── surge-router/         # Core registration edge function
│       ├── verify-audit/         # Hash-chain verifier
│       ├── log-explainer/        # AI telemetry narrative engine
│       └── simulate/             # Chaos & load testing endpoint
├── diagrams/                     # architecture.md (5 Mermaid diagrams)
├── docs/                         # presentation.md (Pitch, Demo Script & Judge Q&A)
└── scripts/                      # Automated GCP, Supabase, Vercel & Verification CLI tools
```

---

## ⚡ Quick Start (Local Setup)

### 1. Prerequisites
- Node.js >= 18
- Docker (optional, for local worker)
- Supabase CLI

### 2. Frontend Setup
```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

### 3. Worker Setup
```bash
cd worker
npm install
npm start
# Worker runs on port 8080
```

---

## ☁️ Deployment Guide

SurgeShield includes fully automated deployment scripts in `scripts/`:

```bash
# 1. Setup Google Cloud (Pub/Sub + Service Accounts)
export GCP_PROJECT_ID="your-gcp-project" GCP_REGION="us-central1"
./scripts/setup-gcp.sh

# 2. Deploy Supabase Migrations & Edge Functions
export SUPABASE_PROJECT_REF="your-supabase-ref"
./scripts/deploy-supabase.sh

# 3. Deploy Background Worker to Cloud Run
./scripts/deploy-worker.sh

# 4. Connect Pub/Sub Push Subscription to Cloud Run
./scripts/setup-pubsub.sh

# 5. Seed High-Concurrency Demo Events & Attendees
./scripts/seed-demo.sh

# 6. Deploy Frontend to Vercel
./scripts/deploy-vercel.sh

# 7. Run 9-Point Verification Suite
./scripts/verify.sh
```

---

## 🧪 Simulation & Chaos Testing

SurgeShield includes an interactive stress simulator accessible at `/simulate` and inside `/ops`:

- **100 / 1,000 Concurrent Users:** Exercises Crowd Pressure Routing across partition lanes.
- **Simulate Surge:** Triggers saturation and Parallel Waiting Queue activations.
- **Email Failure Simulation:** Trips Circuit Guardian into `OPEN` state to verify exponential backoff & dead-lettering.
- **Force Lite Mode:** Tests graceful UI degradation and non-critical query throttling.
- **System Recovery:** Resets circuit breaker and restores full telemetry.

---

## 🔒 Security & Cryptographic Audit Proof

Every state change (registration attempt, lane assignment, seat allocation, seat release, and circuit trip) is appended to `audit_logs` using:
$$\text{Hash}_N = \text{SHA256}(\text{Hash}_{N-1} \parallel \text{Timestamp} \parallel \text{Action} \parallel \text{ActorID} \parallel \text{Metadata})$$

The chain can be verified at any time on the Operations Dashboard via the **Trust Card** or directly through the `/verify-audit` edge endpoint.
