/**
 * Prompts Library — canonical prompts for the operator to fire at any agent.
 *
 * Two distinct audiences, per CC's spec:
 *   - operator  — personal to OASIS AI's setup. References specific clients,
 *                 partners, MRR target, NEPQ, content pillars. Don't ship to
 *                 clients.
 *   - client    — generic, runs on a client's machine when CC has SSH'd in
 *                 or is walking them through onboarding.
 *   - shared    — works either context.
 *
 * The override syntax (CC's spec): every "this is not a regular user
 * message" command starts with `[OVERRIDE]` followed by a context line.
 * Hard-coded prompts are foundational + cannot be deleted from the UI;
 * mutable prompts can be added/edited via the dashboard later.
 *
 * Each prompt routes to a specific agent + opens the chat composer
 * pre-filled. Click → /agents?agent=…&prompt=…
 */

export type PromptAgent = "bravo" | "atlas" | "maven" | "aura" | "hermes";
export type PromptCategory =
  | "client_setup"
  | "client_optimization"
  | "client_handoff"
  | "system_override"
  | "system_health"
  | "system_integration"
  | "ops_daily"
  | "ops_review"
  | "agent_tooling";

export type PromptAudience = "operator" | "client" | "shared";

export type PromptEntry = {
  id: string;
  category: PromptCategory;
  audience: PromptAudience;
  agent: PromptAgent;
  title: string;
  description: string;
  prompt: string;
  /** Hard-coded foundational prompts can't be deleted from the UI. */
  foundational?: boolean;
  tags?: string[];
};

export const PROMPT_CATEGORIES: Record<PromptCategory, { label: string; description: string }> = {
  client_setup: {
    label: "Client setup",
    description: "Drop these when you're SSH'd into a client machine, walking them through onboarding, or kicking off a new deployment.",
  },
  client_optimization: {
    label: "Client optimization",
    description: "Tune an existing client's deployment — voice, tools, daily flow.",
  },
  client_handoff: {
    label: "Client handoff",
    description: "Day 1 prompts the client can run themselves once you walk away.",
  },
  system_override: {
    label: "System overrides",
    description: "Force the agent into a specific mode. All start with [OVERRIDE] so the agent knows this isn't a normal message.",
  },
  system_health: {
    label: "System health",
    description: "Diagnose, repair, refactor your stack.",
  },
  system_integration: {
    label: "System integration",
    description: "Drop a GitHub repo, research doc, open-source tool, or competitor pattern. The agent runs the canonical V6.8 cross-reference audit, plans the import, ships it across the relevant siblings.",
  },
  ops_daily: {
    label: "Daily ops",
    description: "Brief, prioritize, deliver for clients, nurture warm relationships, and create.",
  },
  ops_review: {
    label: "Review + retro",
    description: "End-of-day, end-of-week, end-of-quarter reflections.",
  },
  agent_tooling: {
    label: "Agent tooling",
    description: "Meta-prompts that drop an agent into a specialized role — prompt engineering, translation layers, persona overlays. Useful regardless of which agent you're targeting.",
  },
};

export const PROMPTS_LIBRARY: PromptEntry[] = [
  // ── AGENT TOOLING — VIBE-TO-EXECUTION TRANSLATOR (V9.1, 2026-08-03) ──
  // Upgraded from the 2026-05-22 original, which asked the agent to
  // "synthesize" and "be specific" without saying what a complete answer
  // contains. That produced confident, plausible prompts that guessed
  // column names and script paths — the downstream agent then built on the
  // guess. V8.0 added: the four-layer dissection (intent+vocabulary / data
  // contracts / interaction design / harness routing), a fixed output
  // schema, the 7-row Anti-Slop Matrix as output constraints, and the
  // iron rule that separates the two halves of the job — extrapolate
  // ambition, never extrapolate facts.
  //
  // V9.0 added the Opus 5 execution contract (zero stubs, scope boundary,
  // controlled delegation) and the 7 mandatory production defenses — the
  // guarantees the BUILT system must carry, distinct from the Anti-Slop
  // Matrix which governs how the agent works.
  //
  // V9.1 adds the CLARIFICATION LOOP. V8.0 had exactly two outcomes for a
  // fact it could not verify: invent a default (slop), or bury it in OPEN
  // QUESTIONS where the executor finds it AFTER building the wrong thing.
  // V9.1 adds the third and usually correct one — ask CC every question
  // that passes the leverage test (capped at 4) once, before emitting, each
  // with its default attached so a one-word reply unblocks the build. Unattended runs never block: they
  // label the assumption instead. Cost of asking: one message. Cost of not:
  // a rebuild. Kept in lockstep with Business-Empire-Agent
  // skills/vibe-to-execution/SKILL.md — the ONLY other copy. The dashboard's
  // content/playbooks/11-vibe-translator.md explainer was deleted 2026-08-04:
  // a third copy of the same protocol is a third thing to forget to update,
  // and this prompt body already carries the full contract.
  // Meta-mode prompt: drops the receiving agent into "prompt-engineer
  // for other agents" role. Operator brain-dumps land as polished
  // execution-ready system messages for Claude Code / Codex / Bravo /
  // any downstream agent. Foundational because it's a canonical
  // workflow primitive — every operator should be able to fire this
  // from any chat surface to convert vibe coding into structured work.
  //
  // Lives in agent_tooling (not system_override) because the
  // system_override category has a strict [OVERRIDE]-prefix convention
  // for its prompt bodies, and this entry intentionally preserves the
  // operator's original prompt text starting with `# MISSION`. The
  // dedicated agent_tooling category was introduced specifically for
  // meta-prompts that drop agents into specialized roles.
  {
    id: "vibe-to-execution-translator",
    category: "agent_tooling",
    audience: "shared",
    agent: "bravo",
    title: "Prompt translator",
    description:
      "Drops the agent into 'translation layer' mode. Feed it raw brain dumps, audio transcripts, screenshots, or disorganized thoughts about UI bugs / features / architecture, and it returns a single copy-pasteable Markdown system message engineered for a downstream execution agent (Claude Code, Codex, Bravo). V9.1: it now asks you every high-leverage question (up to 4) BEFORE writing the prompt whenever a missing fact would otherwise become a guess — each with the default attached, so a one-word reply unblocks the build. Plus the four-layer dissection, the fixed 7-heading output schema, the Anti-Slop Matrix, and the 7 production defenses — so the receiving agent ships the whole system instead of a stub, and never guesses a column name.",
    foundational: true,
    tags: [
      "prompt-engineering",
      "override",
      "meta",
      "translator",
      "vibe-coding",
      "anti-slop",
      "clarification",
    ],
    prompt: `You are a Master Systems Engineer and Context Architect. You are the translation layer between CC's unstructured "vibe coding" brain dumps and precision-engineered, execution-ready system messages for advanced agents (Claude Code, Codex, Bravo).

## THE IRON RULE

**Extrapolate ambition. Never extrapolate facts.**

Widen scope to the complete working system CC obviously wants — the cron, the guard, the alert, the test, the failure path. But every CONCRETE detail (table, column, script path, env key, API signature) must be marked as either VERIFIED (with the command that verified it) or OPEN QUESTION. A confident guess is the single most expensive thing you can emit, because the executor will build on it.

**Corollary:** a fact you cannot read from the source and cannot infer safely is not a default — it is a QUESTION. Ask it (below) or label it as an unconfirmed assumption. Never let it enter the prompt disguised as a decision.

## WORKFLOW

1. **Listen.** Brain dumps, transcripts, screenshots, half-formed thoughts.
2. **Dissect into four layers** (below). Anything you cannot fill goes on the open-questions list, never in as a quiet default.
3. **Run the CLARIFICATION LOOP.** If anything on that list is high-leverage, STOP and ask CC about every qualifying gap (capped at 4) in one message. Fold the answers in as verified facts.
4. **Emit ONE copy-pasteable Markdown system message** in the schema below.
5. **Sign off in one line.** Do not explain your prompt back to CC.

## THE FOUR LAYERS

**1. Intent & vocabulary** — Restate the ask in one sentence CC would confirm. Canonicalize domain terms (Pulse, OASIS Outbound, Interaction, tenant, drip sequence). Separate the STATED ask from the IMPLIED system, and name the implied parts explicitly so CC can veto them rather than discover them later. Voice transcripts are lossy — echo every literal (number, domain, env key) back for confirmation. Screenshots are evidence — open the image before describing it; a screenshot of a UI is the spec, including its spacing and type scale.

**2. Data & backend contracts** — Tables and columns (exact names, read from source). Migration needed? RLS/tenant scoping — reads scoped AND writes stamped. Background work: cron row, daemon, or neither. Idempotency: what is the dedup key and where does it persist?

**3. Frontend & interaction** — Component hierarchy, where state lives. The empty, loading AND error states — all three or it is not shipped. Real palette and type scale. Which repo owns it.

**4. Harness & tool routing** — Exact CLI scripts, MCP tools, subagents. Probe every service before assuming a gap. Model calls via the subscription CLI, never an API key. Outbound sends via the send gateway, no exceptions.

**Then list every gap the four layers could not close**, each written as: the gap · the default you would take · what a wrong default costs. That third field is what the next step sorts on. If the list comes out empty, say why — a suspiciously clean list usually means a guess already slipped in as a fact.

## THE CLARIFICATION LOOP (do this BEFORE you write the system message)

Read your gap list and decide, per item: **ask CC now**, or **decide it yourself and say so**. You never ask permission to build. You ask for the facts that decide WHAT to build.

**Ask only when a wrong default cannot be undone with one edit.** Four classes qualify:
- **Missing external context** — only CC can create the account, key, domain or approval, and the design branches on which exists.
- **Unstated business logic** — a number or rule that is a CHOICE, not a fact: pricing, cadence, thresholds, who gets notified, what counts as done.
- **Ambiguous user/tenant boundary** — whose data this touches, which tenant owns the row, what a logged-out or wrong-tenant visitor sees.
- **Undefined edge case** — the failure/duplicate/empty path changes the schema or the contract, not just a message string.

**Never spend a question on:** anything a grep or a file read answers (asking CC for a column name is a guess with a politeness wrapper); anything the canonical glossary defines; anything a credential probe answers; permission to proceed ("shall I start?", "does this look good?" — Fix-First killed those); or cosmetic preference you should own. If CC would answer "you pick", you should have picked.

**Form.** Numbered, max 2 lines each, WITH THE DEFAULT ATTACHED so a one-word reply unblocks the build. CC should be able to answer \`1b, 2 default, 3 yes\` and be done:

\`\`\`
Two things I can't read from the repo, then I build:

1. Cold-lead cutoff — 14 days or 30?  [default: 14, matches the existing drip gap]
2. This view — CC-only across all tenants, or scoped per tenant like /leads?
   [default: per-tenant, consistent with every other view]
\`\`\`

**Budget — deterministic, not a range.** Ask EVERY gap that qualifies above, capped at 4, in ONE round. Zero qualifying gaps: ask nothing, emit. Exactly one: ask one — never pad to a minimum with a question the ban list forbids. More than four: ask the four highest-cost and carry the rest as stated defaults in OPEN QUESTIONS. A second round is allowed ONLY if an answer opens a genuinely new fork; after that you stop asking, and everything still open becomes a stated assumption or a named blocker.

**Unattended runs never wait — and never half-mutate.** Interactive is the DEFAULT: if an operator turn exists in the conversation, CC can answer. Treat a run as unattended only on positive evidence (a cron/scheduler invoked you, you were dispatched as a subagent, the harness passed a headless flag); when genuinely unsure, ask. When nobody can answer: take the default, mark it \`[ASSUMED: <default> — unconfirmed]\` rather than as a decision, copy every one into OPEN QUESTIONS, then ORDER THE WORK so assumption-dependent steps sit behind the reversible ones. Do all the reversible work; at the first IRREVERSIBLE step resting on an \`[ASSUMED]\` value (money, a send, a migration, a production push), STOP AND EXIT, reporting it as a named blocker with the assumption that needs confirming. Never sit waiting on an answer that cannot arrive; never mutate halfway and hang. "Never block" means never WAIT — not proceed regardless. A cron that half-migrated on a guess is the failure this prevents.

**Folding answers in.** CC's reply is ground truth for DECISIONS — tag it \`[VERIFIED: CC Clarification]\`, give it the same standing as a command's output, and write it into the section that consumes it (CONTRACTS / BUILD), because the executor is a fresh context that never saw the conversation. A clarification that survives only in OPEN QUESTIONS has been thrown away.

**But CC's reply is NOT evidence about repo state.** "That column is already there" is a belief, not a grep. Verify system facts against the source and tag those with the command you ran. If the live check contradicts CC's recollection, say so in one sentence and use the live result.

## OUTPUT SCHEMA (use these exact headings)

\`\`\`
OBJECTIVE      one sentence — the outcome, not the activity
CONTEXT        repo + branch, canonical vocabulary, what already exists (file:line)
CONTRACTS      schema / API / env keys — each marked VERIFIED (with the command) or OPEN
BUILD          ordered mutations, each naming the file it touches
GUARDRAILS     what must never happen (money, credentials, main, force-push, prod)
VERIFICATION   the exact command per step, and what its output must show
OPEN QUESTIONS what a default silently decided and you did NOT put to CC, each with the
               default taken — plus every [ASSUMED: … — unconfirmed] item on an
               unattended run. Anything CC already answered does NOT belong here;
               it is a resolved fact in CONTRACTS. Empty is valid; omitting it is not.
\`\`\`

## THE 7 PRODUCTION DEFENSES — paste these into every prompt you emit

These are what the BUILT system must guarantee (distinct from the constraints below, which govern how the agent works). A defense that does not apply is marked \`N/A — <reason>\`. NEVER delete a row — silence reads as "handled", and that is how a UI-only auth check ships.

1. **Probe credentials first.** Run the capability probe before claiming any gap. AVAILABLE = authorized, run the tool. Never instruct anyone to read an env file — the guard blocks it and logs the attempt.
2. **No UI-only security.** Authorization re-checked server-side on EVERY endpoint; session/JWT verified in the route handler. On paths querying as the USER (anon/authed key), RLS enabled AND forced. On paths querying as the SERVICE ROLE, RLS is bypassed by design and is NOT your gate — defense 3 is the boundary there. A hidden button is not a blocked route.
3. **Tenant data isolation.** Every multi-tenant query filters an explicit tenant_id/user_id and every insert stamps the same value. On a SERVICE-ROLE path that filter is the ENTIRE isolation boundary — RLS will not save you — so resolve the tenant server-side from the session or bridge token, never from the request body. A \`.from(...)\` with no adjacent tenant filter on such a path is a cross-tenant leak, not a style issue. Prove it as anon AND as a wrong-tenant user.
4. **Closed-loop error tracking.** No bare \`except: pass\` / empty \`catch {}\`, no broad catch returning a success shape. Log the full traceback and publish an agent_events row so it surfaces instead of dying silently.
5. **Verified restore point before schema change.** Snapshot, verify it is fresh and complete, then dry-run the migration. The snapshot is a LOGICAL baseline — byte-level restore is PITR, so confirm the window covers it before anything destructive. Verification fails = no restore point: escalate, do not apply.
6. **Server-side payment math.** Amounts computed server-side from the DB or a Stripe price object, never from client input. Webhooks verify the signature BEFORE trusting the body and dedup on event.id scoped by tenant. Money always needs operator confirmation.
7. **Zero unrequested visual rewrites.** Touch only the components named. Capture the pages and compare side by side against the previous state or CC's reference before shipping.

## THE OPUS 5 EXECUTION CONTRACT — restate this in every prompt you emit

- **Zero stubs.** Complete the feature suite end-to-end in one run. No TODO, no "the next agent can finish this", no handler returning a success shape it did not compute. If something genuinely cannot finish (a credential only CC can create, a vendor account, a human approval), finish everything that does not depend on it and NAME the blocker. Partial delivery is fine; SILENT partial delivery is the defect.
- **Scope boundary.** Deliver what was asked at the scope intended. Routine technical judgment is the executor's to make. If the request looks mistaken, say so in ONE sentence and continue as asked.
- **Controlled delegation.** Subagents only for large, genuinely independent, parallelizable tracks — never for a trivial edit, a two-grep lookup, or to re-verify its own work. Self-verification is a command you run, not an agent you hire.
- **Focused narration.** One sentence before the first tool call. The final report LEADS with the outcome, then the proof beneath it.

## ANTI-SLOP CONSTRAINTS — write these INTO every prompt you emit

1. **Probe, never assume access.** "Run \`capability_probe check <service>\` before claiming a credential gap." Never instruct anyone to read an env file — the guard blocks it.
2. **No silent error swallowing.** "Fail loud; log the full traceback." A caught-and-hidden exception is the most expensive defect in this system.
3. **No mock data.** "Live hydration or hard fail with a diagnostic naming the missing input." A plausible fake number gets trusted and acted on.
4. **No generic UI.** Deliberate palette, real type hierarchy, restrained motion. Never gradient-hero + centered text + 3-icon grid.
5. **Surgical scope.** "Touch only what the task requires." No drive-by refactoring.
6. **Empirical proof.** "Put the ACTUAL command output in the report." Passing tests are not proof for daemon-run code — exercise the path the daemon takes.
7. **Read the source.** "Verify every path, column and signature before generating consuming code."

## FIX-FIRST

Instruct the executor to enter Fix-First Execution Mode: no permission-seeking, no architectural proposal, no brainstorm — execute, then report. But Fix-First is about SKIPPING CEREMONY, not skipping verification: steps 5 (data integrity) and 7 (CI + machine review) of the 8-step loop are never optional, and a skipped step must be stated out loud, because silence reads as done.

## CALIBRATION

If the input is a greeting, a quick factual question, or a one-file fix, say so and hand it straight back. A translation protocol that fires on "wsp" is its own kind of slop.

The clarification loop scales with the protocol, not independently: a task too small for this protocol is too small for a clarifying question. Asking is a tool for load-bearing forks, and it stops being cheap the moment it becomes a habit — an agent that asks about everything has just moved its own work onto CC's desk.

Acknowledge by saying: "Vibe-to-Execution Translator V9.1 online. Drop your brain dump."`,
  },
  // ── SYSTEM INTEGRATION (V6.8.3, 2026-05-16) ───────────────────
  // Canonical surface for "I found a thing, integrate it" moments.
  // Mirrors the disciplined pattern from the mattpocock/skills audit
  // (commits 5aeb5fb → bec2fcc → 5335556). The full prompt body lives
  // in prompts/INTEGRATE_NEW_TOOL.md; this entry is the dashboard click.
  {
    id: "integrate-new-tool",
    category: "system_integration",
    audience: "operator",
    agent: "bravo",
    title: "Integrate external resource",
    description:
      "Paste a GitHub URL, an open-source repo, a research doc, a transcript, a competitor pattern, or any external resource. Bravo (or the right sibling) runs the canonical 6-phase audit: identify → cross-reference → plan → execute → verify symbiosis → commit + propagate. Anti-slop guardrails enforced. Output is load-bearing code, not paperwork.",
    foundational: true,
    tags: ["integration", "audit", "v6.8", "research", "github"],
    prompt: `I'm dropping you a new external resource to integrate into the empire. Use the canonical workflow in \`prompts/INTEGRATE_NEW_TOOL.md\` end-to-end. Identity probe first — figure out which agent (Bravo / Maven / Atlas / client) this belongs in. Run Phase 1 (identify the problem this solves — don't import for the sake of importing). Spawn the Phase 2 parallel audit (researcher + Explore agents). Synthesize the cross-reference table yourself — never delegate synthesis. Write a plan to \`~/.claude/plans/<slug>.md\` with ADR-0001 hard/soft dependency classification and completeness scores 0-10. Call ExitPlanMode for non-trivial work, wait for my approval. Execute in layers: substrate → conventions → vocabulary → distribution. Run the 4 symbiosis tests after each layer (graph rebuild, retriever pickup, resolver behavior, end-to-end). Commit per layer with V6.X.Y semantic-versioning. Propagate to siblings via CONTEXT.md + V68_AGENT_OS_PATTERNS.md contract when cross-agent. Log a probationary pattern in memory/PATTERNS.md. Finish with the memory sync line. Resource to integrate: `,
  },
  // ── CLIENT SETUP ────────────────────────────────────────────────
  {
    id: "client-admin-bridge-setup",
    category: "client_setup",
    audience: "operator",
    agent: "bravo",
    title: "Set up admin's always-on bridge",
    description:
      "Codifies the admin-bridge model from ADR-0006 for a new client tenant: one machine (the owner's) stays on 24/7 to power the bridge daemon; every employee chats via the dashboard against that bridge; personal API keys remain private per employee.",
    foundational: true,
    tags: ["client", "setup", "bridge", "multi-tenant", "admin"],
    prompt:
      "I'm setting up a new client tenant. The client's owner/admin will run one always-on machine that powers the bridge daemon for every employee. Walk me through: (1) confirm the admin's machine is suitable (idle CPU + memory headroom; stable network; can run 24/7 without sleep). (2) Install the OASIS Desktop app on the admin's machine + pair it as the tenant's primary bridge. Verify the launchd / pm2 service is set to auto-start on boot. (3) Confirm the admin's Claude / Codex / Gemini CLI subscriptions are signed in on that machine — every employee on this tenant will chat against those subscriptions by default. (4) Set the tenant's workspace-default API key in Settings → Agents (the fallback when the bridge isn't reachable from an employee's browser, e.g. quota exceeded). (5) Onboard each employee with their own dashboard account — they inherit the admin's bridge automatically. Walk them through where to paste their PERSONAL API key (Settings → My Agents) if they ever want to override — that key is private to them via RLS (migration 063), no other tenant member can read or use it. Confirm step-by-step with the admin in chat. Report what's done + what's pending.",
  },
  {
    id: "client-fresh-machine-bootstrap",
    category: "client_setup",
    audience: "client",
    agent: "bravo",
    title: "Bootstrap client machine",
    description:
      "Run on a brand-new client laptop after install.sh / install.ps1. Verifies install, pairs to dashboard, smoke-tests every CLI tool, lists what's missing.",
    foundational: true,
    tags: ["onboarding", "setup", "verify"],
    prompt:
      "Bootstrap this fresh client machine. Verify the install: check that bravo, python, node, and git are on PATH; confirm the bridge is paired with the dashboard; smoke-test every CLI tool in scripts/; list anything that's missing or broken. Tell me exactly what to fix before this client is production-ready.",
  },
  {
    id: "client-personalize-identity",
    category: "client_setup",
    audience: "client",
    agent: "bravo",
    title: "Personalize identity",
    description:
      "Replace CC's identity in brain/USER.md + memory/* + the operator secrets file with the new client's. Run after they paste their wizard answers.",
    foundational: true,
    tags: ["onboarding", "identity"],
    prompt:
      "Personalize this clone for the new client. Read their wizard answers from .bravo/profiles/<active>.json, then replace every CC identifier in brain/USER.md, memory/SESSION_LOG.md, memory/ACTIVE_TASKS.md, and any other file that references 'CC' or 'Conaugh McKenna'. Confirm what you changed before committing.",
  },
  {
    id: "client-wire-integrations",
    category: "client_setup",
    audience: "client",
    agent: "bravo",
    title: "Wire integrations",
    description:
      "Walk through every integration in the registry. For each, ask the client what they have a key for and paste it via the bridge.",
    tags: ["onboarding", "keys"],
    prompt:
      "Walk this client through wiring every integration in their stack. Read lib/integrations-registry.ts, then for each api_key integration ask which they have available right now. For ones they have, prompt them to paste the key (we save via the local bridge to the operator secrets file). For ones they don't, tell them which to prioritize and why. Skip OAuth ones for now.",
  },
  {
    id: "client-discover-existing-stack",
    category: "client_setup",
    audience: "client",
    agent: "bravo",
    title: "Discover existing stack",
    description:
      "Scan the client's existing tools — n8n workflows, Stripe products, Supabase tables, Gmail labels. Map their reality before building on top.",
    tags: ["onboarding", "audit"],
    prompt:
      "Scan this client's existing stack. List their n8n workflows, Stripe products + active subscriptions, Supabase tables + recent activity, Gmail labels + unread counts. Map what they already have so we don't accidentally overwrite anything when we build on top.",
  },
  {
    id: "client-set-north-star",
    category: "client_setup",
    audience: "client",
    agent: "bravo",
    title: "Set north-star goal",
    description:
      "Capture the client's primary metric + deadline + path-to. Writes to brain/USER.md so every agent reasons against it.",
    tags: ["onboarding", "strategy"],
    prompt:
      "I want to set this client's north-star goal. Ask me: what metric, what target, by when, and what's the current baseline. Then update brain/USER.md with the goal, draft a 30-day path-to, and tell me which agent owns each leg of it (Bravo for ops, Atlas for money, Maven for content/funnel).",
  },
  {
    id: "client-scaffold-templates",
    category: "client_setup",
    audience: "client",
    agent: "bravo",
    title: "Scaffold day-1 templates",
    description:
      "Set up the operator's weekday + weekend plan templates with their actual schedule, not CC's defaults.",
    tags: ["onboarding", "templates"],
    prompt:
      "Set up this client's plan templates. Ask me their typical weekday rhythm (wake, deep work, meetings, content, ops, wind-down) and weekend pattern. Write to plan_templates table for both kinds, then materialize today's plan. Show me the schedule before saving so I can edit.",
  },
  {
    id: "client-cron-scope",
    category: "client_setup",
    audience: "client",
    agent: "bravo",
    title: "Scope client crons",
    description:
      "Most crons in the default repo are CC-specific. Audit, recommend which to enable / disable for this client.",
    tags: ["onboarding", "crons"],
    prompt:
      "Audit every cron in vercel.json and .agents/workflows/ for this client. For each, tell me: does it apply to their business model? Should we enable, disable, or change frequency? Don't disable anything yet — just give me the recommendation list.",
  },
  {
    id: "client-mcp-setup",
    category: "client_setup",
    audience: "client",
    agent: "bravo",
    title: "Connect MCP servers",
    description:
      "Each client may want their own MCP servers (Slack, Notion, custom). Walk them through configuring .claude/mcp.json.",
    tags: ["onboarding", "mcp"],
    prompt:
      "Walk this client through setting up their MCP servers. Ask which they want (Slack, Notion, GitHub, custom). For each, generate the .claude/mcp.json entry, walk them through the auth step, then verify the server connects via Claude Code. Skip ones they don't need. NOTE: credential-bearing MCPs (Supabase, GitHub, n8n, Late, Firecrawl, Obsidian) MUST use the scripts/mcp_shims/<name>.js Node-shim pattern (not .cmd wrappers) — the shim loads .env.agents via dotenv and passes windowsHide:true so no cmd.exe flashes on spawn. See scripts/mcp_shims/supabase.js for the canonical pattern when adding a new one.",
  },
  {
    id: "client-second-machine-pair",
    category: "client_setup",
    audience: "client",
    agent: "bravo",
    title: "Pair second machine",
    description:
      "Walk a desktop+laptop client through pairing both machines. One stays as production (cron daemons), the other is chat-server only. Foundational — uses the fingerprint-idempotent pair endpoint.",
    foundational: true,
    tags: ["onboarding", "multi-machine", "pair"],
    prompt:
      "Pair this second machine to the same dashboard tenant as the existing one. Read brain/MULTI_MACHINE_PAIRING_PROMPT.md (was MAC_COMMAND_CENTER_PROMPT pre-2026-05-09) for the canonical 12-step playbook. Hard constraint: only ONE machine runs scheduler.py / skool_engine.py daemon / telegram_agent.js — those are state-mutating singletons. The second machine runs ONLY `bravo bridge serve` (the operator-side chat-server). Both bridges paired = both chat-servers visible on /devices. The pair endpoint is idempotent by machine_fingerprint (commit d0e15e0 + migration 030) so re-running is safe. Verify: dashboard /operations shows 2 paired machines, both online, no duplicates.",
  },

  // ── CLIENT OPTIMIZATION ─────────────────────────────────────────
  {
    id: "client-voice-tune",
    category: "client_optimization",
    audience: "client",
    agent: "bravo",
    title: "Tune voice",
    description:
      "Paste 3-5 examples of the client's actual writing → agent rewrites brain/SOUL.md voice section to match.",
    tags: ["voice", "brand"],
    prompt:
      "I'm going to paste 3-5 examples of how this client actually writes (emails, social posts, DMs). Use them to update the voice section of brain/SOUL.md so future drafts match. Pull out: tone words, sentence rhythm, signature phrases, things they never say.",
  },
  {
    id: "client-prune-skills",
    category: "client_optimization",
    audience: "client",
    agent: "bravo",
    title: "Prune unused skills",
    description:
      "Disable skills that don't match the client's business model. E.g., a real-estate client doesn't need DJ booking flows.",
    tags: ["skills", "scope"],
    prompt:
      "This client doesn't run a {business_type}. Audit skills/ and tell me which skills are irrelevant to their model. For each, propose: disable, archive, or keep as future-option. Don't delete anything yet — just give me the list ranked by 'least relevant' first.",
  },
  {
    id: "client-tighten-cron-schedule",
    category: "client_optimization",
    audience: "client",
    agent: "bravo",
    title: "Tighten cron schedule",
    description:
      "Most clients don't need every cron firing. Audit, recommend a leaner schedule based on their volume.",
    tags: ["crons", "ops"],
    prompt:
      "This client's cron schedule is probably over-tuned for someone running CC's volume. Audit every cron in vercel.json + .agents/workflows/ and recommend a leaner schedule based on their actual lead volume + team size. Be specific about which to disable, which to drop in frequency, which to keep.",
  },
  {
    id: "client-revenue-baseline",
    category: "client_optimization",
    audience: "client",
    agent: "atlas",
    title: "Set revenue baseline",
    description:
      "First-time financial snapshot for the client. P&L, runway, where the cash is, what's exposed.",
    tags: ["finance", "onboarding"],
    prompt:
      "First-time financial snapshot for this client. Pull whatever you can from their Stripe / bank exports / receipts. Net MRR, monthly burn, runway, top revenue source, top cost. Flag any concentration risk (one client > 40%) or unclaimed deductibles. Save the snapshot to brain/CFO_BASELINE.md.",
  },
  {
    id: "client-content-pillars",
    category: "client_optimization",
    audience: "client",
    agent: "maven",
    title: "Define content pillars",
    description:
      "3-5 themes every post for this client should belong to. Build the matrix.",
    tags: ["content", "brand"],
    prompt:
      "Define 3-5 content pillars for this client. Each pillar: what it's about, who it serves, why it lands with their audience, target cadence per platform. Render as a matrix. Anchor against their north-star goal.",
  },

  // ── CLIENT HANDOFF (day-1 self-serve) ──────────────────────────
  {
    id: "client-handoff-first-chat",
    category: "client_handoff",
    audience: "client",
    agent: "bravo",
    title: "First-chat orientation",
    description:
      "What the client runs first when they sit down on day 1 alone with the dashboard.",
    foundational: true,
    tags: ["handoff", "day-one"],
    prompt:
      "Walk me through what you can do for me. Pull my goal from brain/USER.md, list the integrations that are connected vs missing, and give me 3 specific things I can ask you today that would move me toward my goal.",
  },
  {
    id: "client-handoff-how-to-correct",
    category: "client_handoff",
    audience: "client",
    agent: "bravo",
    title: "How to correct me",
    description:
      "Show the client how to use [OVERRIDE] when the agent does something they don't want.",
    foundational: true,
    tags: ["handoff", "feedback"],
    prompt:
      "Teach me how to course-correct you. Walk me through the [OVERRIDE] syntax with 3 example scenarios: (1) the voice was off, (2) you sent something I didn't want sent, (3) I want you to pause autonomous activity for the day. Show me the exact syntax for each.",
  },
  {
    id: "client-handoff-daily-rhythm",
    category: "client_handoff",
    audience: "client",
    agent: "bravo",
    title: "Set daily rhythm",
    description:
      "Customize the Today page templates to the client's actual day, not CC's defaults.",
    foundational: true,
    tags: ["handoff", "templates"],
    prompt:
      "Help me customize my Today page. My typical workday looks like: <I'll describe>. Build the weekday + weekend templates around that, save them, and materialize today's plan from the new template.",
  },

  // ── SYSTEM OVERRIDES ────────────────────────────────────────────
  {
    id: "override-correction",
    category: "system_override",
    audience: "shared",
    agent: "bravo",
    title: "Correct behavior",
    description:
      "When the agent did something wrong and you want it to remember the correction permanently. Saves to memory/MISTAKES.md.",
    foundational: true,
    tags: ["override", "feedback"],
    prompt:
      "[OVERRIDE]\nContext: <describe what the agent did wrong + what it should have done instead>\n\nLog this as a permanent correction in memory/MISTAKES.md with the root cause and the rule to apply going forward. Don't try to fix the immediate task — just lock in the lesson so it never happens again.",
  },
  {
    id: "override-pause-cron",
    category: "system_override",
    audience: "shared",
    agent: "bravo",
    title: "Pause an autonomous loop",
    description:
      "Stop a cron / agent from firing while you debug or travel. Expires automatically after 24h.",
    foundational: true,
    tags: ["override", "cron"],
    prompt:
      "[OVERRIDE]\nContext: pause autonomous agent activity for the next 24h.\n\nDisable every cron in vercel.json by setting it to a date in the past. List what you disabled, the original schedule, and write a re-enable script I can run when I'm back. Do NOT touch any data — just the cron triggers.",
  },
  {
    id: "override-voice-shift",
    category: "system_override",
    audience: "shared",
    agent: "bravo",
    title: "One-off voice shift",
    description:
      "Override the brand voice for a specific output (e.g., a formal proposal, a legal email).",
    tags: ["override", "voice"],
    prompt:
      "[OVERRIDE]\nContext: for this task only, write in <formal / clinical / playful / etc> voice — NOT the usual brand voice.\n\nDo not save this preference. After this task, revert to brain/SOUL.md voice. The task: <describe>.",
  },
  {
    id: "override-do-not-send",
    category: "system_override",
    audience: "shared",
    agent: "bravo",
    title: "Draft only",
    description:
      "When you want a draft but the agent should NOT auto-fire send_gateway / publish / post.",
    foundational: true,
    tags: ["override", "safety"],
    prompt:
      "[OVERRIDE]\nContext: draft-only mode for the next request.\n\nProduce the draft and stop. Do NOT call send_gateway, late_tool publish, or any mutating script. I will review and fire it manually.",
  },
  {
    id: "override-private-mode",
    category: "system_override",
    audience: "shared",
    agent: "bravo",
    title: "Private mode",
    description:
      "For sensitive conversations: no SESSION_LOG entry, no agent_events publish, no traces.",
    tags: ["override", "privacy"],
    prompt:
      "[OVERRIDE]\nContext: private mode for this conversation.\n\nDo NOT write to memory/SESSION_LOG.md, do NOT publish to agent_events, do NOT call any persistence path. Hold context in memory only. Confirm you understand before I continue.",
  },

  // ── SYSTEM HEALTH ───────────────────────────────────────────────
  {
    id: "health-full-diagnostic",
    category: "system_health",
    audience: "shared",
    agent: "bravo",
    title: "Full health diagnostic",
    description:
      "Six-layer sweep: harness score, credentials, guards, MCP configs, crons, and file integrity. Auto-fixes mechanical drift, escalates judgment calls, ends with pass/fail per subsystem.",
    foundational: true,
    tags: ["health", "diagnostic", "guards", "crons"],
    prompt: `Run a full system health diagnostic. Work through all six layers, then report. Run the commands — don't assess any layer from memory.

**1. Harness + genome.** \`python scripts/harness_eval.py\` (scores the live harness across its checks) and \`python scripts/agent_genome.py\` (verifies the genome is fully expressed). A failing check names the gap — quote it verbatim rather than paraphrasing.

**2. Credentials.** \`python scripts/capability_probe.py list\`. Report presence and which services are AVAILABLE vs missing. Never read \`.env*\` — secret_guard blocks it by design and logs the attempt. Presence only; never echo a value, not even partially.

**3. Guards.** Confirm all three are in enforce mode: \`EMPIRE_HOOK_SECRET_GUARD\`, \`EMPIRE_HOOK_EXEC_GUARD\`, \`EMPIRE_HOOK_STATE_GUARD\`. Check the hook chain in \`.claude/settings.local.json\` still matches \`.claude/settings.hooks.template.json\` — cross-machine drift here is silent and it disarms the guards. Then check \`state/*.log\` for recent blocks worth knowing about.

**4. MCP configs.** \`python scripts/audit_mcp_secrets.py\`. It sweeps every path in \`MCP_CONFIG_PATHS\`, including \`%APPDATA%\\\\Antigravity\\\\User\\\\mcp.json\` which lives outside the repo and was the source of a real plaintext-key leak. A plaintext credential in any config is a STOP-and-report, not an auto-fix.

**5. Automations.** \`python scripts/integrations/supabase_tool.py select cron_jobs --project bravo --limit 50\`. Flag any job whose \`last_result\` starts with ERROR or FAILED, and any whose \`last_run_at\` is older than 2× its schedule interval — a silently dead cron is the most expensive failure here because nothing alerts on it.

**6. File integrity.** \`brain/\`, \`memory/\`, \`skills/\`, \`scripts/\`: broken imports, dead cross-references, entry-point drift (\`python scripts/genome_sync.py --check\`), and stale inventory counts.

**Fix policy.** Auto-fix mechanical issues — broken imports, dead links, stale counts, formatting — and list what you changed. ASK before anything touching security posture, architecture, or business logic. Never silently rewrite a shared substrate file (\`scripts/\`, \`database/\`, prompt files, MCP wrappers): propose it with the diagnostic that proves it and wait.

**Report:** one line per layer, PASS / FAIL / FIXED, with the actual command output for every failure. End with the single most urgent item. "Should be fine" is not a result — if you didn't run it, say you didn't run it.`,
  },
  {
    id: "health-self-audit",
    category: "system_health",
    audience: "shared",
    agent: "bravo",
    title: "Self-audit drift",
    description:
      "Runs the drift audit plus the staleness and entry-point-parity checks, then sorts every finding into fix-now / ask-CC / skip. Catches the memory files that quietly went stale.",
    tags: ["health", "audit", "drift", "staleness"],
    prompt: `Audit this system for drift. Three checks, then triage.

**1. \`python scripts/core/self_audit.py\`** — walk me through the actual output. Quote the failing checks; don't summarize them into "mostly fine."

**2. Staleness.** \`python scripts/core/memory_aging.py stale --days 7\`. Anything in \`memory/*.md\` or \`brain/STATE.md\` older than 7 days is archived context, not current state — and the real risk is that it still reads as authoritative. Call out specifically any stale file that a future session would likely treat as ground truth.

**3. Entry-point parity.** \`python scripts/genome_sync.py --check\` and \`python scripts/tests/test_entrypoint_parity.py\`. The six entry points (CLAUDE / GEMINI / ANTIGRAVITY / AGENTS / OPENCODE / ZCODE) must carry byte-identical LOCKSTEP blocks. If they've drifted, the fix is editing \`PERSONAL.md\` and re-running \`genome_sync.py\` — never hand-editing the entry point, which is what caused the drift.

**Then triage every finding into exactly one bucket:**
- **Auto-fixable** — mechanical, no judgment. Do it now, list what changed.
- **Needs CC** — security posture, architecture, business logic, or anything where the "right" state is a choice rather than a fact. Give me the one-sentence tradeoff and your recommendation, not an unranked menu.
- **Out of scope** — real but not worth fixing now. Say why, so it doesn't get re-raised next audit.

**Rank by blast radius, not by how easy it is to fix.** A stale file that misroutes a future session outranks ten formatting nits.

Do not silently rewrite shared substrate — \`scripts/\`, \`database/\`, templates, MCP wrappers, prompt files. Every chassis reads those; a unilateral "I noticed it was off so I fixed it" breaks every other agent that relied on the prior shape. Propose with the diagnostic, get a yes, then edit.`,
  },
  {
    id: "health-bridge-status",
    category: "system_health",
    audience: "shared",
    agent: "bravo",
    title: "Bridge status",
    description:
      "Traces the full chain — process, port, pairing, heartbeat, CLI auth — and names the first broken link. Checks the running daemon, not just the repo.",
    tags: ["health", "bridge", "pm2"],
    prompt: `Diagnose the bridge end to end. Follow the chain in order and stop at the first genuinely broken link — everything downstream of a break reports failure for the same reason and that's misleading.

**1. Process.** Is the daemon actually running? \`pm2 status\` on Windows, \`launchctl list | grep bravo-bridge\` on Mac. Note its start time.

**2. Port + health.** \`curl -s http://127.0.0.1:9100/warm-status\` — expect \`{"ok": true, ...}\`. If the port doesn't answer but the process is up, the process is wedged, not absent; those need different fixes.

**3. Heartbeat freshness.** The daemon pings every 60s. Check the last heartbeat is under 2 minutes old. On the dashboard, \`/operations\` → Paired machines should show online (under 90s) rather than idle or offline.

**4. Pairing.** Is this machine's fingerprint present and not revoked in \`bridge_pairings\`? A machine can be running and healthy but paired to nothing, which looks identical from the terminal and completely dead from the dashboard.

**5. CLI auth.** Verify claude / codex / gemini each report installed AND authenticated. An expired login degrades chat to API-key mode, which is banned here — we're subscription-CLI only, never \`ANTHROPIC_API_KEY\`.

**Critical — check the RUNNING daemon, not the repo.** PM2 holds the source and environment captured at spawn time. If the process start time predates the last relevant commit, it is running stale code and every check above can pass while the behaviour is still wrong. Compare the two explicitly and say so.

**Report:** the chain with a pass/fail per link, the first genuine break, and the exact command to fix it. Canonical restart is \`bravo bridge restart\` — it cycles both the heartbeat daemon and the chat-server and waits for :9100 to free. If a restart needs new env values, use \`pm2 restart --update-env\`, but flag that it copies the calling shell's environment.`,
  },
  {
    id: "health-metric-audit",
    category: "system_health",
    audience: "shared",
    agent: "bravo",
    title: "Audit dashboard metrics",
    description:
      "Traces every number on the dashboard to its backing query and classifies it real / stale / miscounted / fake. A plausible wrong number is worse than an error.",
    tags: ["health", "audit", "transparency", "metrics"],
    prompt: `Audit every number the dashboard shows. A number that renders confidently and is wrong is worse than a visible error, because it gets trusted and acted on.

**Scope:** Today, Pipeline, Operations, Agents, Analytics, Health, Automations. (The Reasoning page was dropped from the operator nav on 2026-08-04 — its Agent Decisions tape now lives on Operations. Audit it there.)

**For each metric, do all four:**
1. **Trace it** — find the query in \`lib/queries.ts\` or the page component. Name the table and the filter. If you can't find the source, that alone is the finding.
2. **Verify it's live** — hardcoded arrays, placeholder constants, and sample data behind real-looking chrome are the defect being hunted. Live hydration or hard fail, never a plausible fake.
3. **Check the counting rule against the label** — does the number mean what the label claims? The known failure mode: "Errors today" counted \`severity IN ('error','warn')\` and read ~1600 on a day nothing was broken. Warnings aren't errors. Look for the same class of bug elsewhere: counts including archived or soft-deleted rows, sums crossing tenants, "today" using UTC where the operator reads local (America/Toronto).
4. **Check tenant scoping** — does the query filter \`tenant_id\`? On a service-role path RLS is bypassed by design, so that filter IS the entire isolation boundary. A \`.from(...)\` with no adjacent tenant filter on a service-role path is a cross-tenant leak, not a style note.

**Classify each:** REAL (verified live + correctly counted) · STALE (live but the source stopped updating) · MISCOUNTED (live but the rule contradicts the label) · FAKE (hardcoded or placeholder).

**Update \`brain/METRIC_AUDIT.md\`** with the findings and the date. Lead your report with anything FAKE or MISCOUNTED and the exact file:line — those are the ones that have been quietly lying. Give me counts per class so I can see the shape at a glance.`,
  },
  {
    id: "client-bridge-restart",
    category: "system_health",
    audience: "shared",
    agent: "bravo",
    title: "Restart bridge",
    description:
      "One command. Stops both the heartbeat daemon AND the chat-server, waits for :9100 to free, restarts both. Foundational.",
    foundational: true,
    tags: ["bridge", "restart", "operator"],
    prompt:
      "Run `bravo bridge restart` to cleanly cycle both the heartbeat daemon and the chat-server. After it completes, verify with `curl -s http://127.0.0.1:9100/warm-status` — expect `{\"ok\": true, ...}`. If port :9100 doesn't free in time, the restart waits and retries. This is the canonical 'chat feels stuck' move — replaces the old 'kill python.exe in Task Manager' ritual.",
  },
  {
    id: "client-popup-audit",
    category: "system_health",
    audience: "shared",
    agent: "bravo",
    title: "Audit popup spam",
    description:
      "If a terminal window keeps popping up, run this. Enumerates orphan polling loops, missing CREATE_NO_WINDOW flags, scheduled-task state. Foundational.",
    foundational: true,
    tags: ["health", "popup", "diagnostic"],
    prompt:
      "A terminal window keeps popping up on the operator's screen. Diagnose the source using the same playbook CC ran on 2026-05-09: (1) start a silent watcher script that logs every NEW cmd.exe / conhost / wscript spawn with parent + grandparent for 5 min; (2) bucket the captured spawns by parent process — common culprits are leaked Bash background loops (`until` polling), the bridge heartbeat probing for `playwright.cmd` without STARTUPINFO+SW_HIDE, the BravoSystemHealth scheduled task firing reap_orphan_mcps, and claude.exe spawning MCP servers via `cmd /c npx`; (3) for each culprit, recommend one of: kill the orphan loop (background bash with `KillShell`), patch the subprocess call to add `creationflags=WINDOWLESS_FLAGS` from `_subprocess_helpers` AND `startupinfo=windowless_startupinfo()` for .cmd shims, or switch from python.exe to pythonw.exe for any long-lived daemon. Reference: commits 64ae7b6 (helper consolidation) + 59d773c (heartbeat fix) + 871d71a (skool daemon fix). Report findings + ship the fixes.",
  },

  // ── OPS DAILY ───────────────────────────────────────────────────
  // Morning briefing rewritten 2026-08-04. The old version led with "MRR +
  // delta from yesterday" — revenue is Atlas's domain (CFO-Agent), and Bravo
  // has no first-party MRR process, so the number either came back empty or
  // got inferred. Replaced with the five signals Bravo actually owns and can
  // pull live: pipeline, delivery, inbound, calendar, priority.
  {
    id: "ops-morning-briefing",
    category: "ops_daily",
    audience: "operator",
    agent: "bravo",
    title: "Morning briefing",
    description:
      "Pipeline movement, client delivery health, inbound needing a reply, today's calendar, and the one thing that matters most. Pulled live — no revenue figures (that's Atlas).",
    foundational: true,
    tags: ["daily", "kickoff", "pipeline", "inbound"],
    prompt: `Run my morning briefing. Pull everything live — if a source is unreachable, say so on its line rather than skipping it or estimating.

**1. Pipeline movement (last 24h).** \`python scripts/integrations/supabase_tool.py select leads --project bravo --limit 100\`. Read the table's own status values, don't assume an enum. Report: new leads since yesterday and where they came from, any status changes, and anyone sitting in an active stage untouched for 7+ days. Name the businesses, not just counts.

**2. Client delivery health.** For every active client engagement: anything due today or overdue, any blocker waiting on me, and anything waiting on THEM that I should chase. If a deliverable has slipped twice, flag it explicitly — that's the pattern worth catching early.

**3. Inbound needing a human.** Check \`lead_interactions\` for inbound since yesterday, plus \`python scripts/core/agent_inbox.py list --to bravo\` for messages from Atlas / Maven / Aura / Hermes. Give me sender, what they want in one line, and whether the native pipeline already auto-replied. Separate "needs CC" from "already handled."

**4. Today's calendar.** \`python scripts/integrations/google_tool.py calendar list\`. Meetings with times, what each needs prepped, and any conflict or back-to-back with no gap.

**5. What ran overnight.** Anything in \`agent_events\` at severity=error in the last 24h, and any cron in \`cron_jobs\` whose \`last_result\` starts with ERROR or FAILED. Errors only — warnings are noise at 8am.

**Then: the #1 priority.** One thing, with the reason it beats the rest. Not a list.

**Format:** five short sections, then the priority. Businesses and people by name. No revenue or MRR figures anywhere — that's Atlas's domain, and a number I invent is worse than no number. If a section has nothing, one line: "nothing new." Whole thing readable in under 60 seconds.`,
  },
  // ── OPS DAILY — MACHINE SYNC (added 2026-05-23) ─────────────────
  // Fires when CC switches machines (Windows ↔ Mac) and needs the
  // new machine caught up with whatever the other one did. Critical
  // for travel days: Mac picks up where Windows left off, no manual
  // git pulls or env-rotation guesswork. Foundational because every
  // operator with multi-machine setups will need this ritual.
  {
    id: "ops-sync-this-machine",
    category: "ops_daily",
    audience: "operator",
    agent: "bravo",
    title: "Machine sync",
    description:
      "Bring this machine up to date with work done on the other one. Pulls every repo in the empire, surfaces env-key drift, restarts the bridge daemon, verifies CLIs + auth, and reports what changed since the last session here. Run this whenever you switch from Windows ↔ Mac or come back to a machine you haven't touched in a while.",
    foundational: true,
    tags: ["sync", "travel", "multi-machine", "kickoff", "git"],
    prompt: `Sync this machine with the rest of the empire. I just switched from my other machine and need this one caught up. Do all of this autonomously — don't ask permission for any of it:

**1. Pull every empire repo to its latest main:**
- CEO-Agent (\`~/CEO-Agent\` on Mac / \`C:\\Users\\User\\CEO-Agent\` on Windows — was \`Business-Empire-Agent\` pre-rename, check both) — Bravo brain
- CMO-Agent (\`~/CMO-Agent\`) — Maven content/brand
- CFO-Agent (\`~/CFO-Agent\` or \`~/APPS/CFO-Agent\`) — Atlas finance (branch may be \`master\`, not \`main\`)
- oasis-command-center (\`~/oasis-command-center\` or \`~/APPS/oasis-command-center\`) — Next.js dashboard (Vercel-watched)
- hermes (\`~/hermes\` or \`~/APPS/hermes\`) — community manager (optional, skip if missing)

For each repo: \`git pull --rebase origin <branch>\`. If pull conflicts on tracking/state files (AGENTS.md, brain/STATE.md, memory/*.md), \`git stash push -m "machine-sync stale state"\` then re-pull. Report any conflict that wasn't trivially stash-resolvable.

**2. Refresh the bridge daemon so it loads new code:**
- macOS: \`launchctl kickstart -k gui/$(id -u)/work.oasisai.bravo-bridge\`
- Windows: \`pm2 restart claude-bridge\` (or \`bravo bridge restart\`)
- Confirm: \`curl -s http://localhost:9100/health\` returns ok=true.
- Confirm: \`~/.oasis/bridge_chat.last_heartbeat\` mtime is <2 min old (Mac) or the equivalent freshness check on Windows.

**3. Audit .env.agents for drift:**
- Count keys: should be ~62 populated. Empty / placeholder keys (\`REPLACE_\`, \`your-key-here\`, \`...\`, \`TODO\`, \`CHANGEME\`) mean either a value rotated and didn't propagate OR a new service got added on the other machine.
- DO NOT read or echo values. Use the sanitized count + key-name listing only.
- Surface any key that's blank, surface any key on the OTHER machine's git-tracked \`.env.agents.template\` that's missing here. Don't try to fix — flag them so CC can paste fresh values.

**4. Verify every CLI is still installed + authenticated:**
- \`curl -s -X POST http://localhost:9100/exec-tool -H "content-type: application/json" -H "Origin: https://agent-dashboard-cc90210.vercel.app" -d '{"tool_name":"cli_status","input":{}}'\` should return all three (claude / codex / gemini) with \`installed=true\` and \`authenticated=true\`.
- If any CLI is missing: \`npm i -g @anthropic-ai/claude-code\` / \`npm i -g @openai/codex\` / \`npm i -g @google/gemini-cli\` as needed.
- If any is unauthenticated: tell CC which one + the specific re-auth command (\`claude /login\` / \`codex login\` / \`gemini auth login\`).

**4b. Enable the Codex end-of-task review gate for the CEO-Agent workspace.** Added 2026-05-23 per CC. The codex-plugin lives at \`~/.claude/codex-plugin/\` on both Mac and Windows. The gate makes the Stop hook block until Codex has reviewed any big-task diff — workflow embed lives in CLAUDE.md Rule 8 + skills/codex-delegation/SKILL.md Pattern 5, but the gate itself is a per-workspace config that doesn't survive \`git pull\`. Each rig has to enable it locally:
- \`cd ~/CEO-Agent && node ~/.claude/codex-plugin/scripts/codex-companion.mjs setup --enable-review-gate --json\` — flips \`stopReviewGate\` to true for this workspace.
- Confirm: \`cd ~/CEO-Agent && node ~/.claude/codex-plugin/scripts/codex-companion.mjs setup --json | grep reviewGateEnabled\` returns \`"reviewGateEnabled": true\`. The \`cd\` prefix is REQUIRED — the gate is per-workspace and the lookup resolves against cwd, so omitting it can return a different project's state and silently pass the check.
- If the plugin directory is missing entirely, surface that as a hard error — CC needs to install it from the codex-plugin source. Don't try to scaffold one.

**5. Re-run any pending install steps that the puller may have added:**
- If \`install.sh\` / \`install.ps1\` changed since last sync, scan the diff for new \`npm i -g\` or \`brew install\` lines. Run them.
- If \`bravo_cli/requirements.txt\` changed, \`pip install -r bravo_cli/requirements.txt\` inside the venv.
- If there are new database migrations under \`database/\` or \`supabase/migrations/\`, surface them for CC to apply via the Supabase dashboard or migration tool.

**6. Restart any per-machine daemons that should be running:**
- PM2 daemons (Mac): \`pm2 resurrect\` to bring back saved daemons after reboot. Check \`pm2 status\` shows event-router online.
- Telegram bridge: skip if Windows is the bridge-owner; only start here if Windows is offline and the bridge lock at \`~/.oasis/bridge_locks/bravo.json\` has a stale heartbeat (>60s).

**7. Final report — surface ONLY these in this exact order, one per line:**
- \`✅\` / \`❌\` per item above. One emoji + one short sentence each.
- Top 3 commits across all 4 repos since the last sync (commit sha + first line of message).
- Any key that needs a manual fresh value.
- Any CLI that needs re-auth + the exact command.
- The bridge heartbeat timestamp (so I can confirm it's actively pinging).
- Whether the Codex review-gate is enabled for the CEO-Agent workspace (from step 4b).

Do NOT dump file contents, command outputs, or git diffs. The report should be scannable in 15 seconds. If there's nothing to flag, say \`Nothing needs your hand — this machine is in lockstep.\`

Personal context: I'm CC. My main work machine is Windows; my travel machine is the Mac. I bounce between them. The Mac should always be production-equivalent to Windows because I leave for client visits / coffee shop sessions with it. If anything I do on Windows isn't reflected here in <60 seconds of running this prompt, the sync is broken.`,
  },
  {
    id: "ops-pre-sales-block",
    category: "ops_daily",
    audience: "operator",
    agent: "bravo",
    title: "Relationship pipeline focus",
    description:
      "Ranks the three highest-leverage relationship moves for today across active clients and warm inbound, with the draft attached to each. Inbound-first — never surfaces cold lists.",
    tags: ["daily", "pipeline", "relationships", "inbound"],
    prompt: `Pick my three highest-leverage relationship moves for today.

**Pull the real state first.** \`python scripts/integrations/supabase_tool.py select leads --project bravo --limit 100\` for pipeline, plus \`lead_interactions\` for the last touch on each. Read status values from the data — don't assume the enum.

**Scope: inbound and warm only.** OASIS runs an inbound-first motion — funnel, DMs, and content generate leads; we nurture and book a call. Cold outbound is on-demand and operator-approved, never a suggestion you volunteer. If a lead never initiated contact, it's out of scope for this ranking.

**Rank by:** delivery urgency (a client mid-engagement outranks a prospect), decay risk (warm goes cold at a real rate — a 10-day-old inbound is more urgent than a 2-day-old one), trust already built, and commercial upside. Say which factor decided each pick.

**For each of the three, give me:**
- Person + company, and where they actually came from
- The full last exchange — what they said, what we said, how long it's been
- The next honest action, in one sentence
- The outcome that makes it worth doing
- **The draft itself**, in my voice, ready to read

**Then one line:** anyone about to go cold that didn't make the top three, so I can decide whether to bump them.

Draft-only. Do not call send_gateway or any send path — I approve every send myself. If you think one should go out immediately, say so and let me hit the button.`,
  },
  // Ported from the Reasoning page's Quick Actions grid 2026-08-04, when
  // that page left CC's nav. The grid's other Bravo entries were dropped as
  // duplicates: "Run the daily briefing" and "What changed in the last 24h?"
  // are covered by Morning briefing + End-of-day, and "Send a check-in" is
  // what Relationship pipeline focus already does with more context.
  {
    id: "ops-qualified-leads",
    category: "ops_daily",
    audience: "operator",
    agent: "bravo",
    title: "Qualified leads + next moves",
    description:
      "Every lead in an active stage with its full context, ranked by urgency, each with a recommended next move and the draft ready to go.",
    tags: ["daily", "pipeline", "sales", "inbound"],
    prompt: `Show me every lead currently in an active pipeline stage, with the next move on each.

**Pull the data.** \`python scripts/integrations/supabase_tool.py select leads --project bravo --limit 100\`, then \`lead_interactions\` for the history on each. Read the status values off the rows — don't assume an enum, and don't invent stages the tenant doesn't use.

**For each lead give me:**
- Business + contact name, and how they actually arrived (funnel, DM, referral, content)
- Current stage and how long it's been sitting there
- The last real exchange — what they said, what we said, days since
- Whether the ball is in my court or theirs (this decides everything below)
- The recommended next move, one sentence
- What would make it a dead lead, so I know what I'm watching for

**Rank by urgency**, and say what drove the ranking. Days-in-stage is not urgency by itself — a lead who replied yesterday asking a question outranks one who's been parked for three weeks with no signal. Decay risk on genuinely warm leads outranks both.

**Flag the two edge cases explicitly:** anyone waiting on ME longer than 48h (that's my failure, list them first), and anyone who's gone quiet after real engagement and needs a decision about whether to keep working.

**Draft the top three messages** in my voice, ready to read. Draft only — no sends, no send_gateway. I approve every outbound myself.

If a lead looks like vendor mail or a newsletter rather than a real prospect, say so — junk in the pipeline has been a real problem here and I'd rather retire it than work it.`,
  },
  {
    id: "ops-pre-content-block",
    category: "ops_daily",
    audience: "operator",
    agent: "maven",
    title: "Pre-content-block",
    description:
      "Three hook variants and a shot-by-shot outline for today's drop, built from what actually happened this week. Voice-checked against the anti-slop list.",
    tags: ["daily", "content", "maven"],
    prompt: `I'm about to record today's content. Build me the block.

**1. Mine this week for the raw material first.** Don't invent a topic. Pull from what actually happened: shipped work, a problem I solved, a client outcome, a decision I reversed, something that broke and what it taught me. Check \`memory/SESSION_LOG.md\` and the last week of git history across the empire repos if you need the specifics. Name the real thing — a concrete story beats a generic insight every time.

**2. Three hook variants, three different angles** — not three phrasings of one idea. Give me one contrarian (the thing most people get wrong), one story-led (drop me mid-scene), one specific-result (the number or outcome up front). Label which is which.

**3. A shot-by-shot outline**, not a paragraph. Opening line verbatim, then the beats in order, then the close. Mark where the energy shift or cut goes.

**4. The close.** What the viewer does next. Inbound-first — that's usually a reason to reply or DM, not a hard pitch.

**Voice check before you hand it over.** Kill: "It's worth noting that", "Let's dive in", "In today's world", "game-changer", "unlock", any hook that opens with a rhetorical question, and any sentence that could have been written about any business. Short sentences. Say the real thing.

If nothing this week is genuinely worth a post, tell me that instead of manufacturing one — a forced drop costs more than a skipped day.`,
  },
  {
    id: "ops-decision-prep",
    category: "ops_daily",
    audience: "operator",
    agent: "atlas",
    title: "Pre-decision check",
    description:
      "Before any commitment over $500 or 10 hours: Atlas runs cost, opportunity cost, payback, cash-flow risk, and the reversibility test — then calls it yes / no / wait.",
    tags: ["daily", "money", "atlas"],
    prompt: `I'm about to commit to: <describe the decision — what, how much, over what period>.

Run the full check before I sign anything.

**1. True cost.** Not the sticker price. Include setup time, the ongoing hours it consumes, anything it forces me to buy alongside it, and the switching cost if I need out in 6 months. Separate one-time from recurring.

**2. Opportunity cost.** What else does this money or time buy right now? Name the specific alternative, not "something else." If the hours are the real constraint rather than the cash, say so — my time is the bottleneck and a cheap thing that eats a week is expensive.

**3. Expected return + payback.** How does this actually produce a return, over what period, and what has to be true for that to happen. Name the assumption the whole case rests on.

**4. Cash-flow risk.** Against live financial state — pull it, don't assume it, and don't reason from a hard-coded revenue target. What does the commitment do to the runway in the worst realistic month? Flag it if this is a fixed obligation against variable income.

**5. Reversibility.** One-way or two-way door? Cheap to undo, or locked in for a term? This usually decides borderline calls — a reversible yes at 60% confidence is fine; an irreversible one is not.

**6. Strategic fit.** Does this move the North Star (multiply CC's time, scale OASIS) or is it adjacent-interesting?

**Then call it: YES / NO / WAIT.** One decisive reason. If WAIT, name the exact thing that has to happen or be known first, and by when. Don't hedge across all three — I'm asking because I want the call, and I'll overrule you if I disagree.`,
  },
  {
    id: "ops-inbox-triage",
    category: "ops_daily",
    audience: "shared",
    agent: "bravo",
    title: "Inbox triage",
    description:
      "Read every unread email + agent-inbox message in the last 24h. Classify each (respond / schedule / archive / ignore), rank by what moves the business most, draft replies for the respond-now bucket — no sends.",
    foundational: true,
    tags: ["daily", "comms", "inbox", "triage"],
    prompt:
      "Triage every unread message across (a) my email inbox and (b) the agent-inbox (messages other agents posted to me). For each one: who sent it, what they need in one line, the priority (P1 / P2 / P3). Then classify: respond now (high signal), schedule for later (defer with date), archive (no action needed), or ignore (noise). Rank the respond-now bucket by what'll move the business most. For each respond-now item, draft my reply in my voice — don't send anything, draft only. End with a one-line recommendation on what to action first.",
  },

  // ── OPS REVIEW ──────────────────────────────────────────────────
  {
    id: "ops-end-of-day",
    category: "ops_review",
    audience: "shared",
    agent: "bravo",
    title: "End-of-day",
    description:
      "Reconstructs what actually moved from git, events, and pipeline state — not from memory — then extracts the one durable lesson and sets tomorrow's #1.",
    foundational: true,
    tags: ["review", "daily", "memory"],
    prompt: `End-of-day reflection. Reconstruct the day from evidence before you interpret it.

**1. What actually happened.** Pull it, don't recall it: today's commits across the empire repos (\`git log --since=midnight --oneline\`), \`agent_events\` for today, pipeline changes in \`leads\`, and anything sent through the gateway. A day always feels less productive than it was — the log is the corrective.

**2. What moved.** Group by pipeline, client delivery, systems/code, and content. One line each, concrete. Skip revenue — Atlas owns that.

**3. What didn't, and the honest why.** Separate three causes, because they need different fixes: blocked on someone else, blocked on a decision I didn't make, or simply didn't get to it. The third one repeated across days is a prioritization problem, not a capacity problem — say so if you see it.

**4. One lesson.** Exactly one, and only if it's durable — something that changes how the next similar task gets done. Route it: a validated approach goes to \`memory/PATTERNS.md\`, a failure or correction to \`memory/MISTAKES.md\` with root cause plus the one-line prevention. If today taught nothing new, say "nothing durable today" — a manufactured lesson pollutes the file for every future session.

**5. Tomorrow's #1.** One thing, chosen from what today actually revealed — not a carryover I've now punted three days running. If it IS a three-day carryover, name that and ask whether it should be killed instead.

**6. Sync.** Run \`python scripts/state/state_sync.py --note "<one-sentence summary>"\` and confirm it wrote.

Keep it tight. Six short sections, no padding.`,
  },
  // Ported from the Reasoning page's Quick Actions grid 2026-08-04. Lives in
  // ops_review rather than ops_daily — it's a post-mortem on a call that
  // already happened, not something fired at the start of a day.
  {
    id: "ops-score-sales-call",
    category: "ops_review",
    audience: "operator",
    agent: "bravo",
    title: "Score a sales call",
    description:
      "Paste a transcript: NEPQ + LAER scoring, every missed objection, the exact better line for each, and the follow-up draft.",
    tags: ["review", "sales", "nepq", "objections"],
    prompt: `I'm going to paste a sales call transcript. Score it properly — I want the uncomfortable version, not encouragement.

**1. NEPQ scoring.** Rate each stage and quote the actual line that earned the score:
   - Connection — did I lower resistance, or open in pitch posture?
   - Situation questions — did I learn their reality before offering anything?
   - Problem awareness — did THEY articulate the problem, or did I name it for them? (This is the one that decides calls.)
   - Consequence — did we make the cost of inaction concrete?
   - Solution awareness — did they describe what a fix looks like before I presented?
   - Commitment — was the next step specific, dated, and mutual?

**2. LAER on every objection.** For each: did I Listen (or start rebutting mid-sentence), Acknowledge genuinely, Explore the real concern underneath, then Respond? Most objections are proxies — "too expensive" is usually unclear value or wrong timing. Say which it actually was.

**3. Missed objections.** The ones never voiced but audible in hesitation, topic changes, or a vague "let me think about it." These are what actually killed the deal. Quote the moment.

**4. Talk ratio.** Roughly how much did I talk versus them? Flag every place I answered my own question or filled a silence that was doing useful work.

**5. The three lines to change.** For each: what I said, why it cost me, and the exact better line. Verbatim — I want to be able to say it next time, not a description of a principle.

**6. Honest call.** Is this deal alive? What single thing has to happen next for it to advance, and what's the realistic probability?

**7. Follow-up draft**, in my voice, referencing what they actually said — specifics from the transcript, not generic gratitude. Draft only, no send.

If the call went well, say so and name what to repeat. But don't grade generously — a soft score costs me the next deal.`,
  },
  {
    id: "ops-weekly-retro",
    category: "ops_review",
    audience: "operator",
    agent: "bravo",
    title: "Weekly retro",
    description:
      "Seven days of evidence — commits, pipeline deltas, delivery, automation health — turned into one process change and one priority. Catches the patterns a daily review can't see.",
    tags: ["review", "weekly", "retro"],
    prompt: `Weekly retrospective. Work from the record, not recollection.

**1. Reconstruct the week.** \`git log --since="7 days ago" --oneline\` across the empire repos, \`agent_events\` for the last 7 days, pipeline state changes in \`leads\`, and \`memory/SESSION_LOG.md\`. Note what shipped and reached production versus what's still sitting on a branch — those are different outcomes.

**2. Movement by area.** Client delivery, relationship pipeline (inbound volume and where it came from), systems/code, content. What moved, what stalled. For anything stalled: is it blocked, deprioritized, or quietly abandoned? Abandoned things should be killed explicitly rather than left to rot on the list.

**3. The weekly-only signals** — the ones a daily review structurally cannot surface:
   - A mistake that recurred. Once is noise; twice is a system gap, and it needs a guard, not more discipline.
   - Where the time actually went versus where I said it would go last week.
   - Automation health: any cron in \`cron_jobs\` with a failing \`last_result\`, or one that hasn't fired in over 2× its interval. A silently dead cron is the most expensive thing on this list because nothing alerts you.
   - Anything shipped without verification proof.

**4. One process change.** Exactly one, specific enough to act on Monday. "Be more focused" is not a process change; "no code before the failing test is written" is.

**5. One priority for next week**, with the reason it beats the alternatives.

**6. Memory discipline.** Save durable lessons only — a rule that changes future behaviour. Do NOT copy this week's raw activity into memory; the session log already holds it and duplicating it makes retrieval worse. If nothing durable emerged, say so.

Then update \`memory/ACTIVE_TASKS.md\` to reflect real current state and tell me what you changed.`,
  },
  {
    id: "ops-quarterly-review",
    category: "ops_review",
    audience: "shared",
    agent: "bravo",
    title: "Quarterly review",
    description:
      "Product / market / pricing / motion, judged against what the quarter actually did. Forces an explicit kill list and updates brain/STATE.md with the new direction.",
    tags: ["review", "quarterly", "strategy"],
    prompt: `Quarterly review. Strategy only — no task-level detail. Zoom all the way out.

**1. Ground it in what the quarter actually did.** Read \`brain/STATE.md\` for the direction we set last quarter, then check it against reality: which client engagements started and ended, where inbound actually came from, what shipped and reached production. Start by answering directly — did we do what we said we'd do last quarter? If not, was it the wrong plan or poor execution? Those have opposite fixes.

**2. The four questions:**
   - **Product** — is what we sell still what people want to buy? What are they actually asking for that we don't offer?
   - **Market** — is the buyer the same? Where did the best-fit clients actually come from, and is that repeatable or luck?
   - **Pricing** — what's the evidence? Fast yeses mean underpriced; long silences after the number mean the value story is wrong, not the number.
   - **Motion** — inbound-first is the current bet. Is it producing enough volume, and is the funnel → nurture → call path converting?

**3. Double down.** What's working well enough to deserve materially more time or money next quarter. Be specific about what "more" means.

**4. The kill list.** What to stop. This is the part these reviews always skip — name at least one thing, and if the honest answer is genuinely nothing, justify it. Include: offers that don't sell, systems maintained but unused, and any commitment I'm continuing out of sunk cost.

**5. The gap.** What's missing that we need to build or hire for. Rank by what unblocks the most.

**6. Write it down.** Update \`brain/STATE.md\` with the direction if it changed, and log the reasoning in \`memory/DECISIONS.md\` — a strategy shift without a recorded why gets silently reversed in six weeks.

Revenue targets and MRR are Atlas's call — reference them if I bring them up, but don't set or report them here. Give me your honest read even where it contradicts what I decided last quarter.`,
  },

  // ── INBOX HANDOFF (single, parameterized) ─────────────────────
  // One prompt that covers handoffs to ANY other agent (atlas / maven
  // / aura / hermes / future ones). Caller specifies the target via
  // <agent> placeholder + 1-line context. Replaced two near-identical
  // per-target prompts (bravo-to-atlas, bravo-to-maven) that diverged
  // only in the addressed-agent name. Adding a new agent no longer
  // requires a new entry — just type the agent name where the
  // placeholder is.
  {
    id: "ops-handoff-to-agent",
    category: "ops_daily",
    audience: "operator",
    agent: "bravo",
    title: "Hand off to another agent",
    description:
      "Drafts a clear handoff message to another OASIS agent (Atlas / Maven / Aura / Hermes) and posts it to their agent-inbox so they pick it up next run. One prompt for any target agent.",
    foundational: true,
    tags: ["inbox", "handoff", "atlas", "maven", "aura", "hermes"],
    prompt:
      "I need <target agent: atlas | maven | aura | hermes> to take something on. Take what we just discussed (or what I'm pasting next), write a clear, specific handoff in 5–8 lines: who's asking + what they need + priority + needs-reply flag. Concrete asks only — no generic 'review this and let me know your thoughts.' Post it to the agent inbox addressed to that agent, then confirm the message id back to me. Context for this handoff: ",
  },
];

export function promptsByCategory(category: PromptCategory): PromptEntry[] {
  return PROMPTS_LIBRARY.filter((p) => p.category === category);
}

export function promptsByAudience(audience: PromptAudience): PromptEntry[] {
  return PROMPTS_LIBRARY.filter(
    (p) => p.audience === audience || p.audience === "shared"
  );
}
