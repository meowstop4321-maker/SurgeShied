# SurgeShield — Hackathon Presentation & Judge Cheat Sheet

---

## ⏱️ 2-Minute Pitch Script

> **Hook:** "Every year, high-demand ticket drops—from Taylor Swift concert tours to tech conference keynotes—crash under sudden surge traffic. Monolithic databases lock up, customers get double-charged, scalper bots flood queues, and systems fail simultaneously."

> **Solution:** "We built **SurgeShield**—a resilient event registration engine engineered for zero overbooking and high-throughput concurrency. Instead of forcing thousands of concurrent buyers into a single database row lock, SurgeShield introduces **Adaptive Surge Partitions (ASP)** and **Crowd Pressure Routing (CPR)**. We split seat inventory into parallel transactional lanes, hash-route attendees to the healthiest lane with sub-millisecond latency, and issue cryptographic **Seat Passports** that guarantee temporary reservation claims."

> **Resilience & Trust:** "When downstream services like email providers fail, our **Circuit Guardian** trips automatically to protect worker instances, while **Lite Mode** gracefully throttles heavy animations and live telemetry without ever dropping a seat reservation. Every ticket allocated is permanently recorded in a **SHA-256 Tamper-Evident Audit Chain**, giving organizers and fans cryptographic proof of fair seat distribution."

> **Outcome:** "SurgeShield turns catastrophic traffic spikes into smooth, predictable throughput with 100% data integrity and zero crashes."

---

## 🎬 5-Minute Live Demo Script

| Time | Action | What to Say / Show |
|---|---|---|
| **0:00 - 1:00** | **Live Event Browser & Attendee Registration** | Open the homepage. Navigate to a live event. Show the **Live Surge Partitions** widget displaying real-time lane headroom. Click **Instant Reserve Seat**. Show the immediate confirmation modal with QR ticket and Google Calendar/.ics export. |
| **1:00 - 2:00** | **Parallel Waiting Queue & Saturation** | Switch to a smaller event (e.g. 10 capacity). Register until full. Show the **Parallel Waiting Queue** UI. Point out lane-specific FIFO position, dynamic ETA, and Supabase Realtime auto-promotion. |
| **2:00 - 3:15** | **Operations Dashboard & Real-Time Telemetry** | Navigate to `/ops`. Walk through **Requests/sec**, **SurgeScore Gauge**, **Circuit Guardian State**, **Worker Health**, and the **AI Log Explainer** which translates metrics into natural English incident reports. |
| **3:15 - 4:15** | **Stress Simulator & Circuit Guardian Chaos Test** | Navigate to `/simulate` or trigger from Ops. Click **1,000 Users** — show CPR balancing traffic across lanes with 0 lock contention. Click **Email Failure** — watch Circuit Guardian trip to `OPEN`, notifications buffer into retry queues, and Lite Mode banner activate. |
| **4:15 - 5:00** | **Tamper-Evident Trust Card & Verification** | Highlight the **Trust Card** on `/ops`. Click **Re-verify**. Explain the SHA-256 hash chaining of every registration and state change. Conclude with summary. |

---

## 🧠 Judge Q&A Cheat Sheet

### 1. Why Supabase?
- **PostgreSQL Row-Level Locking (`SELECT ... FOR UPDATE`):** Gives true ACID-compliant atomic guarantees on partitioned counters, eliminating race conditions and overbooking.
- **Row-Level Security (RLS):** Ensures attendees can only see their own tickets, while organizers and admins are isolated securely.
- **Supabase Realtime & Edge Functions:** Provides low-latency Deno edge routing near the user with real-time queue position streaming.

### 2. Why Cloud Run for Background Workers?
- **Scale-to-Zero & Fast Cold Starts:** High-demand ticket drops happen in bursts. Cloud Run scales from 0 to dozens of instances in seconds during a surge and scales down to zero when idle.
- **Containerized Isolation:** Keeps long-running loops (Ghost Seat sweeps, exponential backoff retries, Pub/Sub push subscribers) isolated from customer-facing edge API latencies.

### 3. Why Google Cloud Pub/Sub?
- **Asynchronous Decoupling:** Registration confirmations must never block on third-party email providers (like Resend). Pub/Sub handles high-volume buffering.
- **Dead-Letter Topics & Exponential Backoff:** Automatically handles delivery retries and dead-lettering if downstream workers or external APIs experience outages.
- **Self-Healing Dual Pipeline:** Even if Pub/Sub push is delayed, SurgeShield's worker runs a secondary 20s sweep on `notification_jobs` to guarantee at-least-once delivery.

### 4. Why Adaptive Surge Partitions (ASP)?
- **Kafka-Inspired Transactional Lanes:** In standard databases, 10,000 users attempting to buy from `event_id` hammer a single row counter, causing database deadlocks and timeouts.
- **ASP divides capacity into $N$ independent lanes:** `hash(user_id) % N` or dynamic headroom routing distributes row locks across $N$ distinct rows, yielding near-linear write scaling.

### 5. Why Lite Mode?
- **Graceful Degradation:** During 10x traffic spikes, non-critical database queries (live telemetry, heavy animations, background analytics) consume up to 70% of database CPU.
- **Lite Mode turns off the noise** to allocate 100% of compute and memory to the core transactional allocation engine.

### 6. Why a Tamper-Evident Hash Chain?
- **Trust & Anti-Scalping Integrity:** In high-profile ticket sales, accusations of insider tampering or unfair queue jumping are frequent.
- **Lightweight Cryptographic Ledger:** Chaining `SHA256(prev_hash | created_at | action | actor_id | metadata)` creates a verifiable audit log that proves seat allocations were processed in exact chronological order without alteration.
