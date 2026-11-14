# Bedley — the property manager that never sleeps

**Track: Agents You Can Audit** · MongoDB Agents in Context, Toronto

Bedley is an AI assistant for landlords and tenants. A tenant reports a problem; Bedley answers in seconds, works out how serious it is, gets quotes from contractors, books small jobs by itself, and calls the landlord for a real conversation before booking anything big. **Every action is checked against the landlord's rules in MongoDB before it runs, and recorded so it can be reconstructed afterwards.**

## What happens when a tenant reports an issue
1. **Instant reply** (Claude) on the same page: what's likely wrong and what to do right now.
2. **Triage**: category, priority, and whether it's a major repair or emergency.
3. **Quotes**: Bedley contacts 3–5 contractors and compares price, availability and rating.
4. **Policy gate** (MongoDB `policies`, versioned):
   - small job under the landlord's limit → booked automatically, landlord gets a summary
   - emergency / major repair → the landlord's phone rings (Twilio) and Bedley calls them **in the app** with an ElevenLabs voice. The landlord can ask questions and say "yes, book them".
   - moving money → always denied for agents
5. **Both sides are told** who is coming, when, and what it costs.
6. **Audit**: every tool call, policy decision, call transcript and human approval is in `audit_logs`.

The landlord can pause all AI activity (kill switch), stop a single run, resume a crashed run from its checkpoint, and cancel a booking.

> **Demo note:** with `DEMO_SIMULATE_CONTRACTORS=1` (default) the contractor market is simulated: fictional businesses return quotes after a few seconds, tagged `simulated: true` in the database and labelled "Demo contractor market" in the UI. No real business is phoned. Set it to `0` to use the landlord's saved contractors / Google Places with real Twilio calls. The agent workflow, policy gate, approvals, calls with the landlord and audit trail are real.

## How MongoDB Atlas is used
| Need | Feature |
|---|---|
| Rules enforced before every action | `policies` (append-only versions), evaluated in `src/lib/policy-core.ts` |
| Reconstructable trail | `audit_logs` with `$jsonSchema` validation: actor, authority, rule + version, result |
| Always-on agent | Change Streams wake the worker on new tickets (`src/lib/agent/worker.ts`) |
| Crash-safe runs | Run transcript checkpointed in `agent_runs`; tool calls idempotent by id |
| Atomic approvals/payments | Multi-document transactions |
| Sensitive data | Client-Side Field Level Encryption for SIN, date of birth, phone |
| Live UI | Change Streams → Server-Sent Events |
| Reporting | Aggregation pipelines; "Ask Bedley" answers from live data |
| Expiry | TTL indexes (voice clips, quarantined messages) |

## Run locally
```bash
npm install
cp .env.example .env      # fill in MONGODB_URI, AUTH_SECRET, ENCRYPTION_MASTER_KEY (+ optional keys)
npm run seed -- --reset
npm run demo              # http://localhost:3000
```
Logins (password `demo1234`): `landlord@bedley.demo`, `tenant@bedley.demo`, `tenant2@bedley.demo`.

## Deploy the site on Vercel, run the AI on a laptop
Vercel is serverless, so the always-on agent runs separately:
1. Import the GitHub repo in Vercel and paste your `.env` values into Environment Variables. Deploy.
2. Set `APP_BASE_URL` to the Vercel URL (in Vercel and in your local `.env`).
3. Atlas → Network Access → allow `0.0.0.0/0`.
4. On a laptop: `npm run agent` and leave it running. It watches the same database and does all the AI work.

## Tests
```bash
npm test          # 20 tests: policy gate, redaction, full agent workflows against an in-memory database
```

## Stack
Next.js 15 · TypeScript · Tailwind · MongoDB Atlas · Claude (Anthropic API) · Twilio · ElevenLabs · Stripe (test mode)
