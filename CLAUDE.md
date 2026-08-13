# CLAUDE CODE — OASIS Command Center (product)

<!-- Fleet harness adopted from CC90210/empire-harness — see harness.lock. Do not hand-edit the LOCKSTEP block; edit the canonical in empire-harness + re-adopt. -->

> This is a **product repo**, not an agent repo. You are an engineer working on the
> OASIS Command Center — the multi-tenant dashboard CC's agents (Bravo/Atlas/Maven)
> and clients use. Treat it as production software with paying users.

<!-- LOCKSTEP:tool_discipline -->
## Tool & Verification Discipline (non-negotiable)

1. **Evidence before claims.** Never assert repo/system state from memory. Run the command, read the file, then speak. "I believe" is banned where `grep` can answer.
2. **Read before edit. Verify after edit.** Every modification is followed by its proof: the test run, the lint, the command output. No proof → not done.
3. **Track multi-step work visibly.** Three or more steps → maintain a Todo list. Exactly one item in_progress at a time. Update it in real time, not retroactively.
4. **Tool failure ≠ task failure.** If an MCP/tool call fails twice, fall back to bash/python equivalents and say so. Silently skipping a step because a tool was flaky is the worst failure mode in this system.
5. **Never end a work session without the completion report:**
   - **Changed:** what was modified (paths).
   - **Why:** one plain-English sentence per change.
   - **Proof:** the verification command + its actual output.
   - Do **not** add a routine "Needs from CC" line and do not treat CC as an approval, merge, deployment, credential, or implementation dependency. The systems are internally operated; use the configured authority and finish the work.
   - Add **Handover needed:** only when a verified missing credential, inaccessible external system, or unavailable business context truly blocks completion. State the exact artifact needed (for example, a credential or handover document), after checking the available credentials and access first.
6. **Plain English to the user, always.** Translate jargon in one clause. If the user must make a genuine product decision, give a recommendation plus the one-sentence tradeoff — never an unranked list of options.
7. **Definition of done:** the verification gate passed and its output is in the report. Anything else is "in progress," and you say so.
<!-- /LOCKSTEP:tool_discipline -->

## What this is
- **OASIS Command Center** — Next.js 15 / React 19 / TypeScript / Tailwind / Supabase SSR / Anthropic.
- Deploys to **Vercel** (`agent-dashboard`, alias `agent-dashboard-cc90210.vercel.app`) — **auto-deploys on push to `main`.**
- Extracted from Business-Empire-Agent (CEO-Agent) on 2026-05-18; now its own repo.

## Where secrets + data live (read before touching anything)
- **Secrets:** Vercel env only (`BRAVO_SUPABASE_*`, `BRAVO_FIELD_ENCRYPTION_KEY`, provider keys). **Never** in source, never committed. The only `sk_live_` in the tree is a FAKE fixture in `tests/streaming-redactor.test.ts`.
- **Redaction is load-bearing:** `lib/secret-redaction.ts` + `lib/field-encryption.ts` wrap model-visible strings + encrypt provider keys at rest (AES-256-GCM). Any new path that shows stored data to a model MUST go through redaction. There is a test for this — keep it green.
- **Database:** the **shared empire Supabase** (`BRAVO_SUPABASE_URL`). RLS policies live in the CEO-Agent `database/` migrations, not here. API routes use the **service role** (`getServiceSupabase()`) which BYPASSES RLS — so every tenant-scoped query MUST manually filter by the resolved `tenant_id`. See `docs/SECURITY_POSTURE.md`.

## Commit identity (Vercel gotcha)
Agent-authored commits MUST use a GitHub-associated email or Vercel silently **blocks** the deploy:
`git config user.email "214530671+CC90210@users.noreply.github.com"`.

## Commands
- Tests: `npm test` (28 tests incl. the redaction test). Lint/build per package.json.
- Never commit `.env*`. Secrets go in Vercel.

<!-- LOCKSTEP block inserted below by empire-harness adoption -->

## Rules
- **Ten-check acceptance is the definition of done.** Before reporting an outward-facing build complete, apply `docs/BUILD_ACCEPTANCE_STANDARD.md`: use permanent synthetic fixtures, run ten explicit checks including a safe production-shaped canary when applicable, verify the provider receipt/state transition, and report only after all ten pass. Unit tests and compilation alone are not completion.
- **Surgical changes**; **evidence before claims** (run it, read it, then speak); **plain English to CC**.
- New tenant-scoped query → add the `.eq('tenant_id', …)` filter in the same change. Reviewer must enforce.
- Lockstep sibling: [AGENTS.md](AGENTS.md).
