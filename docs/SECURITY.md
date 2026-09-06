# Security

## Identity and Authorization

Supabase Auth provides the user session JWT. `surge-router` validates the bearer token before registration. Profiles carry `attendee` or `organizer` roles, and RLS lets authenticated users read events while restricting organizer writes to owned events. Attendees read their own registrations; organizers read registrations associated with their events.

The simulator also requires a valid JWT and `DEMO_MODE=true`. That flag is for demonstrations only. The current `verify-audit` endpoint is intentionally public for transparency and returns verification metadata rather than raw secrets.

## Data Protection Controls

- Input validation rejects missing methods, event IDs, actions, and required payloads at the function boundary.
- Registration writes go through server-side functions and RPCs; clients cannot bypass lane locking with raw inserts.
- PostgreSQL parameters and Supabase query builders avoid concatenating user input into SQL. Continue to review every new RPC for injection-safe dynamic SQL.
- React renders normal text values as data. Avoid `dangerouslySetInnerHTML` and sanitize any future rich content.
- Browser authentication uses Supabase's session flow. State-changing calls require the JWT; keep CORS and origin policy narrow when the deployment boundary is known.
- Idempotency keys, rate-limit records, cooldowns, and a unique active-registration index limit replay and double-click damage.
- Service-role keys, AWS credentials, Resend keys, Pub/Sub credentials, and `SEAT_PASSPORT_SECRET` must stay in deployment secrets, never Vite variables or committed files.

## CSRF, XSS, and Rate Limiting

The API is token-authenticated rather than cookie-authorized for registration, which reduces classic ambient-cookie CSRF exposure. CORS is still an important boundary and should be tightened for production. The anti-bot migration provides sliding-window user/IP-style records and cooldowns; the current shared registration path should be checked whenever rate limiting changes.

## Cryptographic Integrity

Seat Passports use HMAC-SHA256 and an expiry timestamp. Audit entries chain the previous hash, timestamp, action, actor, and metadata. The `verify-audit` function recomputes the chain. This is tamper evidence, not encryption, blockchain consensus, or proof that an operator's original input was truthful.

## Security Review Items Before Production

Run dependency and container scans, rotate all demo secrets, restrict IAM and App Runner egress, use a managed secret store, configure CloudFront security headers, add WAF/rate controls at the public edge, and test RLS policies with both attendee and organizer identities.
