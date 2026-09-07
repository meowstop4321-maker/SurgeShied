# SurgeShield Architecture & System Diagrams

## 1. End-to-End System Architecture

```mermaid
flowchart TB
    subgraph Client ["Client Tier (Vercel SPA)"]
        UI[React + Vite Frontend]
        OpsDash[Operations Dashboard & Telemetry]
        SimPanel[Simulation Panel]
    end

    subgraph Edge ["Edge Tier (Supabase Edge Functions)"]
        SR[surge-router\n• JWT Auth\n• Idempotency Check]
        SimFn[simulate\n• Demo Load Generator]
        VA[verify-audit\n• Hash Chain Validation]
        LE[log-explainer\n• AI Telemetry Explainer]
        CoreLogic[register.ts\n• Crowd Pressure Routing\n• Adaptive Surge Partitions\n• Seat Passport Issuer]
    end

    subgraph Data ["Data & State Tier (PostgreSQL + RLS)"]
        Partitions[(seat_partitions\nRow-Level Locks)]
        Queue[(queue_entries\nFIFO Parallel Lanes)]
        Audit[(audit_logs\nSHA-256 Hash Chain)]
        Jobs[(notification_jobs\nStatus Buffer)]
        SystemStatus[(system_status\nLite Mode Drivers)]
    end

    subgraph Async ["Async & Cloud Tier (GCP)"]
        PS[Google Cloud Pub/Sub\nPush Subscription]
        Worker[Cloud Run Worker\n• Ghost Seat Recovery 45s\n• Self-Healing Sweep 20s\n• Circuit Guardian]
        Resend[Resend Email API]
    end

    UI -->|POST /surge-router| SR
    SimPanel -->|POST /simulate| SimFn
    SR --> CoreLogic
    SimFn --> CoreLogic
    OpsDash --> VA
    OpsDash --> LE

    CoreLogic -->|SELECT ... FOR UPDATE| Partitions
    CoreLogic -->|Rank & Enqueue| Queue
    CoreLogic -->|append_audit_log| Audit
    CoreLogic -->|Enqueue Job| Jobs
    CoreLogic -->|set_system_status| SystemStatus

    CoreLogic -.best-effort.-> PS
    PS -->|Push Delivery| Worker
    Jobs -->|Pull Fallback| Worker
    Worker -->|Send Email| Resend
    Worker -->|Release Expired Seats| Partitions
    Worker -->|Promote Top-of-Queue| Queue
```

---

## 2. Sequence Flow: Registration, Surges & Fallback Recovery

```mermaid
sequenceDiagram
    autonumber
    actor Attendee
    participant UI as Frontend App
    participant Edge as Surge Router
    participant DB as Postgres (Partitions & Queue)
    participant PubSub as Google Cloud Pub/Sub
    participant Worker as Cloud Run Worker
    participant Resend as Resend API

    Attendee->>UI: Click "Instant Reserve Seat"
    UI->>Edge: POST /surge-router (JWT + Idempotency-Key)
    Edge->>DB: Check Rate Limits (Anti-Bot)
    Edge->>DB: Rank Partition Lanes by Headroom (CPR)
    
    alt Free Headroom in Lane
        Edge->>DB: allocate_seat() RPC (SELECT ... FOR UPDATE)
        DB-->>Edge: Seat Allocated
        Edge->>Edge: Issue HMAC-SHA256 Seat Passport
        Edge->>DB: Insert notification_jobs (queued) + append_audit_log()
        Edge-->>UI: 200 Confirmed (Ticket QR + Seat Passport)
        Edge--)PubSub: Publish notification-jobs (best-effort)
        PubSub->>Worker: Push Job Delivery
        Worker->>Resend: Send Ticket Email
        Resend-->>Worker: 200 Sent
        Worker->>DB: Update job status = 'sent'
    else All Lanes Saturated
        Edge->>DB: Insert queue_entries (status='waiting')
        Edge-->>UI: 200 Queued (Lane Index + Live Position)
        UI->>UI: Route to /queue/:id (Supabase Realtime updates)
    end

    Note over Worker,DB: Background Sweeps (Ghost Seat Recovery & Self-Healing)
    Worker->>DB: release_expired_seats() (every 45s)
    DB->>DB: Reclaim abandoned seats & promote waiting attendees
    Worker->>DB: selfHealSweep() (every 20s for missed pushes)
```

---

## 3. Adaptive Surge Partitions & Crowd Pressure Routing

```mermaid
flowchart TD
    UserRequest[Incoming Attendee Requests] --> Router[Crowd Pressure Router]
    
    subgraph Partitions ["Adaptive Surge Partitions (Parallel Lanes)"]
        direction LR
        L0["Lane 0\n[Cap: 250 | Used: 240]\n(4% Headroom)"]
        L1["Lane 1\n[Cap: 250 | Used: 120]\n(52% Headroom)"]
        L2["Lane 2\n[Cap: 250 | Used: 180]\n(28% Headroom)"]
        L3["Lane 3\n[Cap: 250 | Used: 248]\n(0.8% Headroom)"]
    end

    Router -->|1. Calculate Headroom| Rank[Rank: L1 > L2 > L0 > L3]
    Rank -->|2. Route to Healthiest| L1
    L1 -->|3. Row-Lock Lane 1 Only| Lock[Postgres Lock: Lane 1]
    
    subgraph ParallelQueues ["Parallel Waiting Queues (When All Lanes Full)"]
        Q0["Queue 0 (FIFO)"]
        Q1["Queue 1 (FIFO)"]
        Q2["Queue 2 (FIFO)"]
        Q3["Queue 3 (FIFO)"]
    end

    Rank -.Saturated.-> Q1
```

---

## 4. Circuit Guardian & Lite Mode State Machine

```mermaid
stateDiagram-v2
    [*] --> Nominal: System Started

    Nominal --> LiteModeActive: High Queue (>20) OR Lane Saturation (>90%)
    LiteModeActive --> Nominal: Traffic Normalizes (<80% Saturation)

    Nominal --> CircuitOpen: 3 Consecutive Downstream Email Failures
    CircuitOpen --> CircuitHalfOpen: 30s Cooldown Expires
    CircuitHalfOpen --> Nominal: Test Probe Succeeds
    CircuitHalfOpen --> CircuitOpen: Test Probe Fails

    state LiteModeActive {
        [*] --> PauseAnimations
        PauseAnimations --> MaintainCoreReservations
        MaintainCoreReservations --> ShowLiteModeBanner
    }

    state CircuitOpen {
        [*] --> DivertToBackoffBuffer
        DivertToBackoffBuffer --> ExponentialRetry
        ExponentialRetry --> DeadLetterQueueAfter5Retries
    }
```

---

## 5. Tamper-Evident Hash Chain Structure

```mermaid
classDiagram
    class Block_N_Minus_1 {
        +Int id: 101
        +String action: "seat_allocated"
        +String actor_id: "user-uuid-1"
        +String previous_hash: "0a8f9b..."
        +String current_hash: "3e5d7a..."
    }

    class Block_N {
        +Int id: 102
        +String action: "seat_allocated"
        +String actor_id: "user-uuid-2"
        +String previous_hash: "3e5d7a..."
        +String current_hash: "9b1c4f..."
    }

    class Block_N_Plus_1 {
        +Int id: 103
        +String action: "lite_mode_activated"
        +String actor_id: "system"
        +String previous_hash: "9b1c4f..."
        +String current_hash: "f4a2d8..."
    }

    Block_N_Minus_1 --> Block_N : SHA-256(prev_hash | ts | action | actor | meta)
    Block_N --> Block_N_Plus_1 : SHA-256(prev_hash | ts | action | actor | meta)
```
