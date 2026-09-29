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

## UI — route through the Oasis UI library BEFORE building (Adon 2026-09-28)

This section exists in this repo, not only in JARVIS, because that was the bug.
The rule was originally written into `JARVIS/CLAUDE.md` while the UI work happens
here, and this repo loads its own instructions. A rule that does not load where the
work happens does not exist.

Before writing or changing any visual surface here:

1. **`Skill(oasis-ui-library)`** — the router. Its `ROUTING.md` is a decision table:
   per build type (dashboard, data table, chart, form, motion, 3D, redesign, audit,
   anything touching auth or PII) it names which skills to invoke in what order, what
   to read, and which gate to run.
2. **60 installed UI skills** cover primitives, tables and grids, charts, motion,
   typography and colour, and production open-source products worth studying. Reach
   for one before searching the web: they carry verified licences and current APIs.
   TanStack Table's stable release is **v9**, and v8 written from memory does not
   compile. `react-window` v2 deleted `FixedSizeList`.
3. **`Skill(hallmark)`** for a new page, a redesign, or a design audit.
4. **Obey the design constitution** (`JARVIS/oasis-ui-library/doctrine/DESIGN_CONSTITUTION.md`),
   26 numbered rules with real numbers. Highest impact here:
   - `font-variant-numeric: tabular-nums` on every price, balance and table numeral
   - semantic tokens only; dark mode is a token swap, never a parallel component tree
   - the indigo/violet band is **banned** as a primary accent, the most diagnostic
     generated-UI tell (it was Tailwind's old default button colour)
   - WCAG 2.2 AA is the floor: 4.5:1 text, 3:1 large text and UI
   - a border separates, a shadow elevates; every shadow carries a y-offset
   - numeric columns right-align, with a right-aligned header
   - default row height 32-36px; sidebar 220-280px expanded
5. **Check licensing before adding any dependency or copying any component**
   (`doctrine/STACK_AND_LICENSING.md`). Several popular kits forbid building a
   reusable internal library from them. Some repos are AGPL, and some carry no
   licence at all, which grants no rights rather than meaning free.

**The gate runs in CI** (`.github/workflows/ui-gate.yml`) and fails on NEW AI-tell
patterns. Run it locally before pushing:

```
python .github/ui/ui_slop_lint.py --root . --baseline .github/ui/ui-slop-baseline.json
```

Baselines shrink, never grow. If you remove violations, regenerate with
`--update-baseline` and say so in the commit message.

**Functionality always outranks the constitution.** A beautiful screen that computes
the wrong number is a failure.
