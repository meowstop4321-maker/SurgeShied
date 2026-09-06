# 🧪 SurgeShield Test Specifications & Validation Suite

This document specifies the test cases covering the **Attendee Experience**, **Seat Passport Allotment**, **Parallel Waiting Queue**, **Dynamic ETA**, and **Ghost Seat Auto-Promotion**.

---

## ⚡ Automated Test Runner

To execute the entire end-to-end automated test suite against your live database:

```bash
npm test
```
*(Or `node scripts/test-e2e.js`)*

---

## 📋 Test Matrix & Specifications

### 🎯 Test Suite 1: Attendee Authentication & Discovery

| Test ID | Test Name | Target / Endpoint | Expected Outcome | Status |
|---|---|---|---|:---:|
| **TC-1.1** | Attendee Authentication | `POST /auth/v1/token` | Returns valid JWT session for `demo.attendee.surge@gmail.com`. | ✅ PASS |
| **TC-1.2** | Profile Role Validation | `SELECT * FROM profiles` | Authenticated user profile exists with `role = 'attendee'`. | ✅ PASS |
| **TC-1.3** | Live Event Discovery | `GET /rest/v1/events` | Retrieves upcoming events with total capacity and available seats. | ✅ PASS |

---

### 🎟️ Test Suite 2: Seat Reservation, Passport & Ticket Verification

| Test ID | Test Name | Target / Component | Expected Outcome | Status |
|---|---|---|---|:---:|
| **TC-2.1** | Atomic Seat Allocation | `RPC allocate_seat()` | Target lane row locked with `SELECT ... FOR UPDATE`; `seats_taken` incremented atomically without race conditions. | ✅ PASS |
| **TC-2.2** | Seat Passport Generation | HMAC-SHA256 Token | Issues cryptographically signed token with 2-minute booking window (`exp = now + 120s`) and unique nonce. | ✅ PASS |
| **TC-2.3** | QR Code Ticket Payload | `QRModal.tsx` | QR code generates instantly embedding the validated Seat Passport token. | ✅ PASS |
| **TC-2.4** | Calendar Integration | `calendar.ts` | Generates valid Google Calendar template URL and RFC 5545 compliant `.ICS` calendar file. | ✅ PASS |
| **TC-2.5** | Double-Booking Prevention | Unique Constraint `23505` | Re-attempting registration returns `status: "already_registered"` without burning additional seat inventory. | ✅ PASS |

---

### ⏳ Test Suite 3: Parallel Waiting Queue & Dynamic ETA

| Test ID | Test Name | Target / Component | Expected Outcome | Status |
|---|---|---|---|:---:|
| **TC-3.1** | Saturated Lane Routing | `registerForEvent()` | When all lanes are 100% full, attendee is placed into `queue_entries` with `status: 'waiting'`. | ✅ PASS |
| **TC-3.2** | Dynamic Position Accuracy | `RPC queue_position()` | Accurately calculates FIFO placement in the target lane (e.g. `#1 in line`). | ✅ PASS |
| **TC-3.3** | Dynamic ETA Calculation | `QueueScreen.tsx` | Calculates estimated wait time: $\text{Wait Time} = \text{Position} \times 120\text{s}$ ($\approx 2\text{ min}$). | ✅ PASS |
| **TC-3.4** | Strict Anti-Hopping Lock | Edge / DB Constraint | Attendee cannot switch or hop to another lane; returns locked status on retry. | ✅ PASS |

---

### 👻 Test Suite 4: Ghost Seat Recovery & Auto-Promotion

| Test ID | Test Name | Target / Component | Expected Outcome | Status |
|---|---|---|---|:---:|
| **TC-4.1** | Expired Reservation Sweep | `release_expired_seats()` | Sweeps reservations where `seat_passport_expires_at < now()`, marks status `expired`, and returns seat to partition. | ✅ PASS |
| **TC-4.2** | FIFO Auto-Promotion | `promote_from_queue()` | Promotes top-of-queue waiting entry into the vacated seat and triggers Supabase Realtime redirect to checkout. | ✅ PASS |

---

### 🔒 Test Suite 5: SHA-256 Tamper-Evident Ledger Integrity

| Test ID | Test Name | Target / Component | Expected Outcome | Status |
|---|---|---|---|:---:|
| **TC-5.1** | Block Hash Chaining | `append_audit_log()` | Chains each entry's hash: $\text{SHA256}(\text{prev\_hash} \parallel \text{ts} \parallel \text{action} \parallel \text{actor} \parallel \text{meta})$. | ✅ PASS |
| **TC-5.2** | Chain Verifier | `verify_audit_chain()` | Iterates through all historical blocks and verifies 100% cryptographic integrity. | ✅ PASS |

---

## 🖐️ Manual Step-by-Step Test Walkthrough

### Flow A: Happy Path Attendee Registration
1. Navigate to **`http://localhost:3000/auth`**.
2. Click **`Demo Attendee`** → Logs in and redirects to `/events`.
3. Click **`Global Tech Summit 2026 Keynote`**.
4. Click **`Instant Reserve Seat`**.
5. **Verify:**
   - Button shows `Allocating Seat…` then transitions to **`You're Registered`**.
   - Confirmation banner shows **Seat Confirmed (2 min window)**.
   - Click **`View Ticket QR`** → Verify QR code renders with ticket token.
   - Click **`Google Cal`** or **`.ICS`** → Verify event download triggers.

### Flow B: Small Capacity & Parallel Waiting Queue Demo
1. Sign in as **Demo Organizer** (`/auth`).
2. Go to **Organizer Portal** (`/organizer`).
3. Create a test event with **Total Capacity = 4 seats**.
4. Log in as **Demo Attendee** and register to fill the seats.
5. Have a 5th attendee register → **Verify:**
   - Automatically redirected to **`/queue/:id`**.
   - Screen displays: **`#1 in position`**, **`Est. Wait Time: ~2 min`**, and **`Strict Anti-Hopping Policy: Locked to Lane`**.
