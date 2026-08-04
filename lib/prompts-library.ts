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
  // V9.1 adds the third and usually correct one — ask CC 2-4 high-leverage
  // questions once, before emitting, each with its default attached so a
  // one-word reply unblocks the build. Unattended runs never block: they
  // label the assumption instead. Cost of asking: one message. Cost of not:
  // a rebuild. Kept in lockstep with Business-Empire-Agent
  // skills/vibe-to-execution/SKILL.md and content/playbooks/11-vibe-translator.md.
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
      "Drops the agent into 'translation layer' mode. Feed it raw brain dumps, audio transcripts, screenshots, or disorganized thoughts about UI bugs / features / architecture, and it returns a single copy-pasteable Markdown system message engineered for a downstream execution agent (Claude Code, Codex, Bravo). V9.1: it now asks you 2-4 high-leverage questions BEFORE writing the prompt whenever a missing fact would otherwise become a guess — each with the default attached, so a one-word reply unblocks the build. Plus the four-layer dissection, the fixed 7-heading output schema, the Anti-Slop Matrix, and the 7 production defenses — so the receiving agent ships the whole system instead of a stub, and never guesses a column name.",
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
3. **Run the CLARIFICATION LOOP.** If anything on that list is high-leverage, STOP and ask CC 2-4 questions in one message. Fold the answers in as verified facts.
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

**Budget: 2-4 questions, ONE round.** A second round only if an answer opens a genuinely new fork. Three rounds is not clarification, it is a design meeting — take the rest as stated assumptions and ship the prompt.

**Unattended runs never block.** If nobody can answer (cron, background agent, another agent's hand-off), do not wait: take the default, mark it \`[ASSUMED: <default> — unconfirmed]\` rather than as a decision, copy every one into OPEN QUESTIONS, and force any IRREVERSIBLE dependent step (money, sends, migrations, production pushes) to stop for operator confirmation. A deadlocked cron is worse than a labelled assumption; an unlabelled assumption is worse than both.

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
2. **No UI-only security.** Authorization re-checked server-side on EVERY endpoint; session/JWT verified in the route handler; RLS enabled and forced. A hidden button is not a blocked route.
3. **Tenant data isolation.** Every multi-tenant query filters an explicit tenant_id/user_id and every insert stamps the same value. Where routes use a service role, that filter IS the boundary. Prove it as anon AND as a wrong-tenant user.
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
      "Test every MCP server, check configs, verify file integrity. Auto-fixes mechanical issues.",
    foundational: true,
    tags: ["health", "diagnostic"],
    prompt:
      "Run a full system health diagnostic. Test every MCP server, check the integrity of brain/, memory/, skills/, and scripts/. Verify all credentials are still valid. Auto-fix mechanical issues (broken imports, dead links, stale counts). Give me a clear pass/fail per subsystem at the end.",
  },
  {
    id: "health-self-audit",
    category: "system_health",
    audience: "shared",
    agent: "bravo",
    title: "Self-audit drift",
    description:
      "Detect when files have drifted from canonical state. Score the system, name the drift, propose fixes.",
    tags: ["health", "audit"],
    prompt:
      "Run scripts/core/self_audit.py and walk me through its output. Score the current state, name the top 3 drift issues, and for each propose the fix as either: auto-fixable (do it now), needs my judgment (ask me), or out of scope (skip).",
  },
  {
    id: "health-bridge-status",
    category: "system_health",
    audience: "shared",
    agent: "bravo",
    title: "Bridge status",
    description:
      "Verify the local bridge is paired, heartbeating, and the dashboard sees it as online.",
    tags: ["health", "bridge"],
    prompt:
      "Check the bridge status: is the local chat server running on :9100, is it paired with the dashboard, is /devices showing it as online, and is the heartbeat thread firing every 60s? If anything's off, tell me which to fix first.",
  },
  {
    id: "health-metric-audit",
    category: "system_health",
    audience: "shared",
    agent: "bravo",
    title: "Audit dashboard metrics",
    description:
      "Walk every number on every page, verify it's real or flag it as facade.",
    tags: ["health", "audit", "transparency"],
    prompt:
      "Walk through every metric on the Today, Pipeline, Operations, Agents, and Reasoning pages. For each: trace it to the backing query + table, verify the data is real (not a hardcoded placeholder), flag anything stale or fake. Update brain/METRIC_AUDIT.md with your findings.",
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
  {
    id: "ops-morning-briefing",
    category: "ops_daily",
    audience: "operator",
    agent: "bravo",
    title: "Morning briefing",
    description:
      "MRR, pipeline, client health, top priority — all in one read.",
    foundational: true,
    tags: ["daily", "kickoff"],
    prompt:
      "Give me the morning briefing. MRR + delta from yesterday, pipeline movement, client health alerts, anything from inbound/outbound that needs my eye, and my #1 priority for today. Be punchy.",
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
      "Choose the highest-leverage next touch across active clients and warm community opportunities.",
    tags: ["daily", "pipeline", "relationships"],
    prompt:
      "Review the current OASIS pipeline and active clients. Ignore cold lists. Rank the three highest-leverage relationship moves for today using recency, trust, delivery urgency, and commercial upside. For each: person/company, current context, the next honest action, and the outcome we want. Draft-only unless I explicitly approve a send.",
  },
  {
    id: "ops-pre-content-block",
    category: "ops_daily",
    audience: "operator",
    agent: "maven",
    title: "Pre-content-block",
    description:
      "Hook variants + raw outline for today's content drop. Voice-checked.",
    tags: ["daily", "content"],
    prompt:
      "I'm about to record today's content. Give me 3 hook variants and a raw outline in CC's voice. Reference anything noteworthy from this week. Each hook should pass the brand-voice check (no AI-slop openers, no 'It's worth noting that').",
  },
  {
    id: "ops-decision-prep",
    category: "ops_daily",
    audience: "operator",
    agent: "atlas",
    title: "Pre-decision check",
    description:
      "Before any commitment over $500 or 10 hrs: Atlas runs the financial + opportunity-cost math.",
    tags: ["daily", "money"],
    prompt:
      "I'm about to commit to <decision>. Run the financial math: real cost, opportunity cost, expected return, payback period, cash-flow risk, and strategic fit. Tell me yes / no / wait with one decisive reason. Use live financial truth; do not rely on a hard-coded revenue target.",
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
      "What moved, what didn't, one lesson, tomorrow's #1.",
    foundational: true,
    tags: ["review", "daily"],
    prompt:
      "End-of-day reflection. What actually moved today (revenue, pipeline, content, ops). What didn't and why. One lesson worth saving to memory/PATTERNS.md or memory/MISTAKES.md. Tomorrow's #1 priority based on what I just did.",
  },
  {
    id: "ops-weekly-retro",
    category: "ops_review",
    audience: "operator",
    agent: "bravo",
    title: "Weekly retro",
    description:
      "Did delivery, relationships, and pipeline move this week? What changes next week.",
    tags: ["review", "weekly"],
    prompt:
      "Weekly retrospective. Use live client delivery, relationship pipeline, content, operations, and financial signals. What moved, what stalled, and why? Name one process change and one priority for next week. Save only durable lessons; do not duplicate raw activity into memory.",
  },
  {
    id: "ops-quarterly-review",
    category: "ops_review",
    audience: "shared",
    agent: "bravo",
    title: "Quarterly review",
    description:
      "Big-picture: are we still on the right product / market / pricing? What to ship vs. kill.",
    tags: ["review", "quarterly"],
    prompt:
      "Quarterly review. Big-picture only — are we still on the right product, the right market, the right pricing? What's working that we should double down on. What's not working that we should kill. What's missing that we need to ship. Update brain/STATE.md with the new direction if anything changes.",
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
