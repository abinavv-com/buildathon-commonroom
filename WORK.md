# WORK.md: Commonroom ledger

Every session reads this first and updates it before stopping.

## Goal
Track 2 (ai-agents). A Moltbook-style social network for agents, plus checked and paid work: agents hire agents from asks, escrow holds the money, the server re-checks the work (gate 1), a roster of independent verifiers attests (gate 2), then payout and an Ed25519-signed receipt. Reputation comes from receipts, not upvotes.

## Decisions (18 Nov 2026)
- Reverse-engineered Moltbook from its public skill.md and press coverage. We keep the shape: self-registration, a human claim, rooms/posts/votes, rate limits.
- We fix Moltbook's flaws:
  - The check-in is a data-only `GET /v1/home`, not a heartbeat file the agent follows.
  - Reputation comes from receipts, not upvotes.
  - A guard blocks any write that carries a secret.
  - Posts that read like instructions to agents are flagged.
- Payments: test-mode double-entry ledger with escrow, a 10% platform fee and verifier fees. Stripe Connect is the planned upgrade.
- Hosting: a Cloudflare quick tunnel from this laptop (the user's choice), plus a Dockerfile. Vercel was rejected because the app is one stateful process with disk state, timers and SSE.
- Applied from the external review: per-job verifier roster with distinct owners; blind dedupe verifiers; inconsistent-verdict rejection; parties-only inputs and outputs; Origin check and server-side session expiry; deadlines and a sweeper; policy versions in receipts; bounded MCP bodies with no batches.
- No AI co-author trailer on commits. No code copied from earlier projects.

## Status
| Task | Owner | Status |
|---|---|---|
| Backend: auth, social, agents, wallet, jobs, receipts, guard, SSE, scenarios | coordinator | done; 9/9 tests; all 3 scenarios verified via the API |
| Frontend (all pages, receipt printer, 21st.dev-adapted elements) | frontend subagent | in progress |
| MCP (HTTP + stdio), skill.md, llms.txt, agents/run.mjs, verify-receipt.mjs | agent-platform subagent | in progress |
| Hosting via Cloudflare tunnel | coordinator | after the frontend lands |

## 18 Nov, 17:20: serverless backend
- Hosting: Vercel (static `public/` plus the `api/index.mjs` function) with Upstash Redis (`commonroom-kv`, Vercel Marketplace). The laptop backend and the Cloudflare tunnel are retired.
- State: one versioned document with a compare-and-set commit, retried with backoff (`lib/store.mjs`). Demo agents step on each request (`tickDemo`).
- Production env vars: KV_* (from the integration), SIGNING_KEY_PEM, PUBLIC_URL, TRUST_PROXY=1. Local `.env.local` is gitignored.
- Verified on Vercel with the laptop off: hire → verified → paid; the receipt verifies offline against the live public key; MCP works; the attack scenario logs 2 blocks.
- Known limits: rate limits are per instance; the state document must stay under Upstash's request size (old job data is pruned after 150 jobs).
