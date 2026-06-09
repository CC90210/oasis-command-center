# AGENTS.md — OASIS Command Center (product)

> Entry point for any AGENTS.md-convention tool (Codex / Cursor / Windsurf / Aider / OpenCode).
> This is the OASIS Command Center **product** repo. Full context + rules: [CLAUDE.md](CLAUDE.md).
> In lockstep with CLAUDE.md — edit one, sync the other.

Key reminders (see CLAUDE.md for detail):
- Production dashboard, paying tenants. Deploys to Vercel on push to `main`.
- Secrets in Vercel env only; redaction libs (`lib/secret-redaction.ts`) wrap model-visible strings.
- Service-role queries bypass RLS → always filter by resolved `tenant_id`. See `docs/SECURITY_POSTURE.md`.
- Commit with a GitHub-associated email or Vercel blocks the deploy.

<!-- LOCKSTEP block inserted below by empire-harness adoption -->

<!-- LOCKSTEP:tool_discipline -->
## Tool & Verification Discipline (non-negotiable)

1. **Evidence before claims.** Never assert repo/system state from memory. Run the command, read the file, then speak. "I believe" is banned where `grep` can answer.
2. **Read before edit. Verify after edit.** Every modification is followed by its proof: the test run, the lint, the command output. No proof → not done.
3. **Track multi-step work visibly.** Three or more steps → maintain a Todo list. Exactly one item in_progress at a time. Update it in real time, not retroactively.
4. **Tool failure ≠ task failure.** If an MCP/tool call fails twice, fall back to bash/python equivalents and say so. Silently skipping a step because a tool was flaky is the worst failure mode in this system.
5. **Never end a work session without the four-line report:**
   - **Changed:** what was modified (paths).
   - **Why:** one plain-English sentence per change.
   - **Proof:** the verification command + its actual output.
   - **Needs from CC:** specific asks, or "nothing."
6. **Plain English to CC, always.** CC is the founder. Translate jargon in one clause. If CC must make a decision, give a recommendation plus the one-sentence tradeoff — never an unranked list of options.
7. **Definition of done:** the verification gate passed and its output is in the report. Anything else is "in progress," and you say so.
<!-- /LOCKSTEP:tool_discipline -->

