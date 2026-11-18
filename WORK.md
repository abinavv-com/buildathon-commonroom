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
| Backend: auth, social, agents, wallet, jobs, receipts, guards and scenarios | team | Implemented; isolated API tests pass |
| HTTP + stdio MCP and five checked services | team | Implemented; all five services pass API/MCP and frontend contract checks |
| Owner-supplied HTML frontend connected to live API | coordinator | Integrated: real sessions, five-service hiring, job evidence, receipts, social and owner controls |
| Hosting | coordinator | Production release READY at https://commonroom-ochre.vercel.app |

## 18 Nov, 17:20: serverless backend
- Hosting: Vercel (static `public/` plus the `api/index.mjs` function) with Upstash Redis (`commonroom-kv`, Vercel Marketplace). The laptop backend and the Cloudflare tunnel are retired.
- State: one versioned document with a compare-and-set commit, retried with backoff (`lib/store.mjs`). Demo agents step on each request (`tickDemo`).
- Production env vars: KV_* (from the integration), SIGNING_KEY_PEM, PUBLIC_URL, TRUST_PROXY=1. Local `.env.local` is gitignored.
- Verified on Vercel with the laptop off: hire → verified → paid; the receipt verifies offline against the live public key; MCP works; the attack scenario logs 2 blocks.
- Known limits: rate limits are per instance; the state document must stay under Upstash's request size (old job data is pruned after 150 jobs).


## 18 Nov: rebuild continuation and frontend release
- Reproduced and fixed reconciliation accepting altered customer details. Gate 1 now also compares the complete deterministic source-derived output.
- Fixed handling of distinct bank rows that share dates/descriptions; matching counts actual rows including amount and disallows consuming a bank row beyond its available count.
- Completed MCP discovery, hire inputs, local task calculation and blind auditing for `books.reconcile` and `catalog.clean`. Full MCP flows for both services reach signed receipts in the test suite.
- Updated REST/MCP agent documentation for all five supported services, test money, blind verification and honest service limitations.
- The owner requested integration of `Commonroom (2).html`, followed by GitHub push and production deployment to the existing Vercel project. The supplied visual design, responsive styles, hero composition and illustrations now wrap API-backed screens. Removed browser-local simulated account/job execution flows.
- Browser inspection encountered a minimized intended browser window; automatic approval review rejected opening an unrelated WhatsApp window. No unrelated browser content was accessed. Rendered browser appearance remains unverified at this point.
- Release readiness: Vercel CLI 59.7.0 is installed and its existing login succeeds. In PowerShell, use `vercel.cmd` because `vercel` resolves to a `.ps1` blocked by the current execution policy. No policy change is needed.
- Validation: 35/35 tests passed on the integrated frontend and backend, including all five frontend hire contracts, HTTP asset MIME/CSP/deep routes, API trust/money rules, full MCP workflows and reconciliation regressions. JavaScript syntax and git diff whitespace checks passed.
- Runtime/template QA passed using actual app scripts and the API: home, discovery, auth, dashboard, work, owned agents, wallet, developer/settings/activity screens and dedupe/catalog/bookkeeping hire forms. This is not browser layout verification.
- Pushed commits: `7461dd1` reconciliation acceptance fixes, `3191e75` MCP service integration, `8a1d79b` supplied frontend and live API integration. No co-author trailers.
- Production deployment READY: `dpl_8WS2QkQ9AVXbNEE3dDr2LYb6PJiQ`, aliased to https://commonroom-ochre.vercel.app. Live JS/CSS assets match the checkout (normalizing BOM/line endings), deep routes, capabilities and health return 200.
- Live test-money job completed with two verifier attestations, settlement and a valid signed receipt (`rcpt_c1dd3ace3933`).
- Automatic browser opening was attempted after deployment. The browser access host is unavailable and the intended native browser remains minimized; no rendered browser check was obtained.
