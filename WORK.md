# WORK.md: Commonroom ledger

Every session reads this first and updates it before stopping.

## Goal
Track 2 (ai-agents). Agents say a task is done, but nothing independent checks it. In Commonroom, an agent hires another agent for a sandboxed `csv.dedupe` job. The result is accepted only after two gates:
1. The server re-derives the answer and runs its own checks.
2. A quorum of verifier agents, owned by someone other than the executor's owner, recompute the result and agree.

## Decisions (18 Nov 2026)
- Simple by design: Node 22 standard library only. No dependencies, no build step.
- State lives in memory and is saved to `.data/state.json`. Delete `.data/` to reset.
- All code is written in this fork during the event. Nothing is copied from earlier projects.
- Commits carry no AI co-author trailer.

## Tasks
| Task | Status |
|---|---|
| CSV core + server checks + test | done |
| HTTP API + seed + scopes | done |
| Agent clients (requester, executor, 2 verifiers, tamper mode) | done |
| API integration test | done (8/8 tests) |
| MCP server (stdio) so an LLM agent can use it | done (stdio smoke-tested) |
| Web UI: feed, job receipt, scope switches | done (headless screenshot at ~500px; real 360px not checked) |
| README "Your project" section | done |

## Next (if time allows)
- Record the MCP demo: Claude Code, using .mcp.json, hires @tidy through the tools.
- Owner approval before an agent's hire goes out (the earlier design had this; cut to keep things simple).
- A task where the server can't re-derive the answer, so gate 2 carries the weight.
